import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readFile,
  writeFile,
  stat,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { DashboardManager } from "../src/dashboard-manager.js";
import {
  dashboardPaths,
  validateDashboardRecord,
  controlDashboard,
} from "../src/dashboard-runtime.js";

const exec = promisify(execFile);
const controller = fileURLToPath(
  new URL("./fixtures/dashboard-controller.mjs", import.meta.url),
);
const app = {
  github: { repo: async (repo) => repo || "acme/project" },
  status: () => {
    throw new Error("Local management must not query cloud state");
  },
};
const options = { repo: "acme/project", "no-open": true };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "boxci-daemon-"));
  const manager = new DashboardManager({
    directory,
    worker: new URL("./fixtures/dashboard-worker.mjs", import.meta.url),
    timeout: 10000,
  });
  t.after(async () => {
    await manager.stop(app, options).catch(() => {});
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });
  const command = async (action = "start") => {
    const result = await exec(process.execPath, [controller, action], {
      env: { ...process.env, BOXCI_HOME: directory },
      timeout: 15000,
    });
    assert.equal(result.stderr, "");
    return { result: JSON.parse(result.stdout), stdout: result.stdout };
  };
  const paths = dashboardPaths(directory, options.repo);
  return { directory, manager, command, paths };
}

test("background dashboard survives its launcher exiting, reuses its instance and stops through authenticated control", async (t) => {
  const { directory, command, paths } = await fixture(t);
  const first = await command(); // execFile has observed the launcher process exit.
  assert.equal(first.result.running, true);
  assert.equal(first.result.background, true);
  const record = JSON.parse(await readFile(paths.state, "utf8"));
  assert.ok(!first.stdout.includes(record.token));
  assert.ok(!first.stdout.includes(record.control_token));
  if (process.platform !== "win32") {
    assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.root)).mode & 0o777, 0o700);
    assert.equal((await stat(paths.log)).mode & 0o777, 0o600);
  }
  assert.equal((await fetch(record.origin + "/api/status")).status, 401);
  const authorized = await fetch(record.origin + "/api/session", {
    method: "POST",
    headers: { Origin: record.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: record.token }),
  });
  assert.equal(authorized.status, 200);
  const cookie = authorized.headers.get("set-cookie").split(";")[0];
  const status = await fetch(record.origin + "/api/status", {
    headers: { Cookie: cookie },
  });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).repo, options.repo);
  assert.equal(
    (
      await fetch(record.origin + "/api/stop", {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).status,
    405,
  );
  const second = (await command()).result;
  assert.equal(second.reused, true);
  assert.equal(second.pid, first.result.pid);
  assert.equal(second.origin, first.result.origin);
  assert.equal((await command("status")).result.running, true);
  assert.equal((await command("stop")).result.running, false);
  await assert.rejects(access(paths.state), { code: "ENOENT" });
  await assert.rejects(fetch(record.origin));
  assert.equal((await command("stop")).result.running, false);
  assert.equal((await command("status")).result.running, false);
  assert.ok(directory.length > 0);
});

test("concurrent launches create one background instance", async (t) => {
  const { command } = await fixture(t);
  const [a, b] = await Promise.all([command(), command()]);
  assert.equal(a.result.pid, b.result.pid);
  assert.equal(a.result.origin, b.result.origin);
  assert.equal(Number(a.result.reused) + Number(b.result.reused), 1);
});

test("invalid control credentials and stale PID metadata cannot stop an unrelated process or the live dashboard", async (t) => {
  const { manager, paths } = await fixture(t);
  await manager.start(app, options);
  const record = JSON.parse(await readFile(paths.state, "utf8"));
  await assert.rejects(
    controlDashboard({ ...record, control_token: "0".repeat(64) }, "stop"),
    /Cannot verify/,
  );
  await assert.rejects(
    controlDashboard({ ...record, instance: "0".repeat(32) }, "stop"),
    /Cannot verify/,
  );
  await assert.rejects(
    controlDashboard({ ...record, pid: process.pid }, "stop"),
    /Cannot verify/,
  );
  assert.equal((await controlDashboard(record)).pid, record.pid);
  for (const input of ["GET / HTTP/1.1\r\n", "null\n", '{"token":{}}\n']) {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(
        { host: "127.0.0.1", port: record.control_port },
        () => socket.write(input),
      );
      socket.on("data", () => {});
      socket.on("error", (error) =>
        error.code === "ECONNRESET" ? resolve() : reject(error),
      );
      socket.on("end", () => {
        socket.end();
        resolve();
      });
    });
  }
  assert.equal((await controlDashboard(record)).pid, record.pid);
  await writeFile(
    paths.state,
    JSON.stringify({ ...record, pid: process.pid }),
    { mode: 0o600 },
  );
  try {
    await assert.rejects(manager.stop(app, options), /Cannot verify/);
  } finally {
    await writeFile(paths.state, JSON.stringify(record), { mode: 0o600 });
  }
  assert.equal((await manager.status(app, options)).running, true);
});

test("stale stopped-instance metadata is recovered without signalling its saved PID", async (t) => {
  const { manager, paths } = await fixture(t);
  await manager.start(app, options);
  const old = JSON.parse(await readFile(paths.state, "utf8"));
  await manager.stop(app, options);
  await writeFile(paths.state, JSON.stringify({ ...old, pid: process.pid }), {
    mode: 0o600,
  });
  const next = await manager.start(app, options);
  assert.equal(next.running, true);
  assert.notEqual(
    JSON.parse(await readFile(paths.state, "utf8")).instance,
    old.instance,
  );
});

test("browser handoff keeps tokens out of output and writes an explicitly requested private session file", async (t) => {
  const { directory, paths } = await fixture(t);
  const opened = [];
  const manager = new DashboardManager({
    directory,
    worker: new URL("./fixtures/dashboard-worker.mjs", import.meta.url),
    browser: async (url) => opened.push(url),
  });
  const file = join(directory, "session.json");
  const result = await manager.start(app, {
    repo: options.repo,
    "session-file": file,
  });
  const record = JSON.parse(await readFile(paths.state, "utf8"));
  assert.equal(opened.length, 1);
  assert.equal(new URL(opened[0]).origin, record.origin);
  assert.ok(new URL(opened[0]).hash.startsWith("#token="));
  assert.ok(!JSON.stringify(result).includes(record.token));
  assert.ok(!JSON.stringify(result).includes(record.control_token));
  assert.equal(JSON.parse(await readFile(file, "utf8")).origin, record.origin);
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("invalid ports and records are rejected before launching or contacting a process", async (t) => {
  const { manager } = await fixture(t);
  await assert.rejects(
    manager.start(app, { ...options, port: "NaN" }),
    /port must be/,
  );
  const record = {
    protocol: 1,
    repo: options.repo,
    pid: 10,
    control_port: 1234,
    control_token: "a".repeat(64),
    token: "b".repeat(64),
    instance: "c".repeat(32),
    version: "0.1.0",
    background: true,
    origin: "http://127.0.0.1:1234",
  };
  assert.equal(validateDashboardRecord(record, options.repo).pid, 10);
  for (const origin of [
    "https://example.com",
    "http://localhost:1234",
    "http://127.0.0.1:1234/#secret",
    "bad url",
  ])
    assert.throws(
      () => validateDashboardRecord({ ...record, origin }, options.repo),
      /valid local instance/,
    );
  assert.throws(
    () =>
      validateDashboardRecord({ ...record, repo: "other/repo" }, options.repo),
    /valid local instance/,
  );
});
