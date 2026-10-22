#!/usr/bin/env python3
"""Wake a dedicated BoxCI machine on InstaBox using only Python's standard library."""

import json
from concurrent.futures import ThreadPoolExecutor
import os
import re
import shlex
import sys
import time
import urllib.error
import urllib.request
import uuid


API = "https://api.instabox.sh"
RUNNER_ROOTS = ("boxci/runners", "instabox-ci/runners")
CI_PURPOSES = frozenset({"boxci", "instabox-ci"})


class ApiError(RuntimeError):
    def __init__(self, status, code):
        self.status = status
        self.code = code
        super().__init__(f"InstaBox HTTP {status}: {code}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A redirect must never forward the machine-management credential.
        return None


def request(method, path, key, deadline, body=None, idempotency_key=None):
    headers = {"X-API-Key": key, "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    payload = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=payload, headers=headers, method=method)
    opener = urllib.request.build_opener(NoRedirect)
    for attempt in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("InstaBox wake exceeded its five-minute deadline")
        try:
            with opener.open(req, timeout=min(30, remaining)) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                detail = json.load(error)
                code = detail.get("code") or detail.get("error", {}).get("code", "api_error")
            except (ValueError, AttributeError):
                code = "api_error"
            if error.code not in (429, 502, 503, 504) or attempt == 2:
                # Do not print server response bodies, headers or credentials.
                raise ApiError(error.code, code) from None
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise RuntimeError("Cannot reach InstaBox; check provider availability") from None
        time.sleep(min(2 ** attempt, max(0, deadline - time.monotonic())))


def runner_service_cmd(runner_name):
    checks = []
    for root in RUNNER_ROOTS:
        qname = shlex.quote(runner_name)
        checks.append(
            f'dir="$HOME/{root}/"{qname}; '
            f'test -s "$dir/.service" && systemctl is-active --quiet "$(cat "$dir/.service")"'
        )
    return " || ".join(checks)


def wake(machine_id, key, timeout=300, runner_name="", expected_name=""):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", runner_name):
        raise ValueError("BOXCI_RUNNER_NAME is missing or invalid")
    if not re.fullmatch(r"m_[a-z0-9]{26}", machine_id):
        raise ValueError("BOXCI_MACHINE_ID must be a machine ID")
    if not key:
        raise ValueError("BOXCI_API_KEY is missing")
    deadline = time.monotonic() + timeout
    path = f"/v1/machines/{machine_id}"
    machine = request("GET", path, key, deadline)
    # Refuse a typo that points the pilot at a developer's machine.
    if expected_name:
        if machine.get("name") != expected_name:
            raise RuntimeError("VM name differs from the reviewed machine; refusing to change it")
    elif machine.get("metadata", {}).get("purpose") not in CI_PURPOSES:
        raise RuntimeError("Machine is not marked for BoxCI; refusing to change it")
    state = machine["state"]
    operation_id = machine.get("operationId")
    if state in ("suspended", "stopped") and not operation_id:
        action = "resume" if state == "suspended" else "start"
        try:
            operation = request(
                "POST", f"{path}/{action}", key, deadline,
                idempotency_key=str(uuid.uuid4()),
            )
            operation_id = operation["id"]
        except ApiError as error:
            if error.status != 409 or error.code != "operation_conflict":
                raise
            # Another wake request won the race. Follow its operation.
            operation_id = request("GET", path, key, deadline).get("operationId")
    elif state not in ("running", "creating", "starting", "resuming", "suspending"):
        raise RuntimeError(f"Machine is {state}; inspect it in InstaBox before retrying")

    while time.monotonic() < deadline:
        if operation_id:
            operation = request("GET", f"/v1/operations/{operation_id}", key, deadline)
            if operation["state"] == "failed":
                code = (operation.get("error") or {}).get("code", "operation_failed")
                raise RuntimeError(f"InstaBox could not wake the machine: {code}")
            if operation["state"] == "succeeded":
                operation_id = None
            else:
                time.sleep(min(3, max(0, deadline - time.monotonic())))
                continue
        machine = request("GET", path, key, deadline)
        if machine["state"] == "suspended" and not operation_id:
            raise RuntimeError("Machine paused during wake; retry after checking InstaBox")
        if machine["state"] == "error":
            raise RuntimeError("Machine entered an error state; inspect InstaBox")
        if machine["state"] == "running" and machine.get("runtime", {}).get("ready"):
            result = request("POST", f"{path}/exec", key, deadline, {
                "cmd": runner_service_cmd(runner_name), "timeoutSeconds": 10,
            })
            if result.get("exitCode") == 0 and not result.get("timedOut"):
                print("VM is ready and its runner service is active.")
                return
        time.sleep(min(3, max(0, deadline - time.monotonic())))
    raise TimeoutError("InstaBox VM or runner service was not ready within five minutes")


def route(machine_id, key, runner_name, expected_name, runner_label,
          fallback_label, trusted, output):
    """Select an explicit hosted fallback when the bounded provider wake fails.

    This proves guest service readiness only, not GitHub connectivity. A job
    assigned after routing is still subject to GitHub's own queue behaviour.
    """
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", fallback_label):
        raise ValueError("A specific hosted fallback label is required")
    labels = [fallback_label]
    reason = "untrusted source"
    if trusted:
        try:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", runner_label):
                raise ValueError("A dedicated runner label is required")
            if runner_label.lower() in ("self-hosted", "linux", "x64", "arm64"):
                raise ValueError("Generic runner labels are not dedicated")
            wake(machine_id, key, runner_name=runner_name, expected_name=expected_name)
            labels = ["self-hosted", "Linux", runner_label]
            reason = "VM and runner service ready"
        except (RuntimeError, ValueError, KeyError, TimeoutError):
            # Never forward provider response details or credentials to Actions.
            reason = "wake failed or CI credential unavailable"
    with open(output, "a", encoding="utf-8") as target:
        target.write("runner=" + json.dumps(labels, separators=(",", ":")) + "\n")
    print("Runner route: " + json.dumps(labels) + " (" + reason + ")")
    return labels


def route_pool(pool_json, key, runner_label, fallback_label, trusted, output):
    """Wake every reviewed pool member concurrently; route only the complete pool.

    All members must have active services before returning the shared label.
    Partial readiness selects hosted CI, never a partially woken shared pool.
    Normal idle suspension stays enabled. Service readiness is not proof of
    GitHub connectivity; actual job pickup remains visible in GitHub Actions.
    """
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", fallback_label):
        raise ValueError("A specific hosted fallback label is required")
    labels = [fallback_label]
    reason = "untrusted source"
    if trusted:
        try:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", runner_label) or runner_label.lower() in (
                    "self-hosted", "linux", "x64", "arm64"):
                raise ValueError("A dedicated runner label is required")
            pool = json.loads(pool_json)
            if not isinstance(pool, list) or not 1 <= len(pool) <= 5 or not key:
                raise ValueError("A pool requires one to five dedicated VMs and a CI credential")
            ids, names = set(), set()
            for member in pool:
                if not isinstance(member, dict) or set(member) != {"machine_id", "runner_name", "expected_name"}:
                    raise ValueError("Invalid pool member")
                mid, name, expected = (member[k] for k in ("machine_id", "runner_name", "expected_name"))
                if not all(isinstance(v, str) for v in (mid, name, expected)) or not (
                        re.fullmatch(r"m_[a-z0-9]{26}", mid)
                        and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}", name)
                        and expected.strip()) or mid in ids or name.lower() in names:
                    raise ValueError("Pool members must be distinct VMs with distinct runner names")
                ids.add(mid)
                names.add(name.lower())
            # Validate the complete pool before any provider mutation. Waiting on
            # every future also ensures a failed member does not cancel other wakes.
            with ThreadPoolExecutor(max_workers=len(pool)) as executor:
                futures = [executor.submit(wake, m["machine_id"], key,
                           runner_name=m["runner_name"], expected_name=m["expected_name"]) for m in pool]
                ready = []
                for future in futures:
                    try:
                        future.result()
                        ready.append(True)
                    except (RuntimeError, ValueError, KeyError, TimeoutError):
                        ready.append(False)
            if all(ready):
                labels = ["self-hosted", "Linux", runner_label]
                reason = f"all {len(pool)} VM runner services ready"
            else:
                reason = f"only {sum(ready)}/{len(pool)} VM runner services ready"
        except (RuntimeError, ValueError, KeyError, TypeError, TimeoutError):
            reason = "pool configuration or CI credential unavailable"
    with open(output, "a", encoding="utf-8") as target:
        target.write("runner=" + json.dumps(labels, separators=(",", ":")) + "\n")
    print("Runner pool route: " + json.dumps(labels) + " (" + reason + ")")
    return labels


if __name__ == "__main__":
    try:
        args = (
            os.environ.get("BOXCI_MACHINE_ID", ""),
            os.environ.get("BOXCI_API_KEY", ""),
        )
        if "BOXCI_POOL" in os.environ:
            route_pool(os.environ["BOXCI_POOL"], args[1],
                       runner_label=os.environ.get("BOXCI_RUNNER_LABEL", ""),
                       fallback_label=os.environ["BOXCI_FALLBACK_LABEL"],
                       trusted=os.environ.get("BOXCI_TRUSTED", "false") == "true",
                       output=os.environ["GITHUB_OUTPUT"])
        elif os.environ.get("BOXCI_FALLBACK_LABEL"):
            route(*args,
                  runner_name=os.environ.get("BOXCI_RUNNER_NAME", ""),
                  expected_name=os.environ.get("BOXCI_EXPECTED_NAME", ""),
                  runner_label=os.environ.get("BOXCI_RUNNER_LABEL", ""),
                  fallback_label=os.environ["BOXCI_FALLBACK_LABEL"],
                  trusted=os.environ.get("BOXCI_TRUSTED", "false") == "true",
                  output=os.environ["GITHUB_OUTPUT"])
        else:
            wake(*args,
                 runner_name=os.environ.get("BOXCI_RUNNER_NAME", ""),
                 expected_name=os.environ.get("BOXCI_EXPECTED_NAME", ""))
    except (RuntimeError, ValueError, KeyError, TimeoutError) as error:
        print(f"CI wake failed: {error}", file=sys.stderr)
        sys.exit(1)
