import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { App, validatePool, quotaPlan } from "../src/engine.js";
import { Provider } from "../src/provider.js";
import { redact } from "../src/process.js";
import { archiveFileFor } from "../src/store.js";
import {
  legacyWakeJobYaml,
  wakeJobYaml,
  reusableWakeWorkflow,
} from "../src/wake.js";
import { workflow } from "../src/workflow.js";
const helperPath = ".github/workflows/boxci-wake.yml";
const id = (char) => "m_" + char.repeat(26);
function fixture() {
  const db = {
    project: null,
    archives: [],
    machines: [],
    runners: [],
    secrets: new Set(),
    variables: new Map(),
    files: new Map(),
    localFiles: new Map(),
    branches: new Set(),
    calls: [],
    keys: 0,
    keyRecords: [],
    saves: 0,
    workflowWrites: 0,
    workflowPending: true,
    prs: [],
    failCompletion: false,
    failSecret: false,
    identity: { userId: 7, login: "developer" },
  };
  const storage = {
    readProject: async () => structuredClone(db.project),
    archiveFileFor,
    archiveProject: async (p) => {
      db.archives.push(structuredClone(p));
      return archiveFileFor(p);
    },
    saveProject: async (p) => {
      db.saves++;
      if (db.failCompletion && p.status === "ready_to_commit")
        throw new Error("completion response lost");
      db.project = structuredClone(p);
    },
    locked: async (_, fn) => fn(),
  };
  const workspace = {
    review: async (repo, relPath, after, { preserveExisting = false } = {}) => {
      const before = db.localFiles.get(relPath) ?? null;
      if (before !== null && before !== after && !preserveExisting)
        throw new Error("local workflow conflict");
      return {
        repo,
        relPath,
        before,
        after: preserveExisting && before !== null ? before : after,
      };
    },
    validate: async (edit) => {
      if ((db.localFiles.get(edit.relPath) ?? null) !== edit.before)
        throw new Error("local workflow changed after review");
    },
    apply: async (edit) => {
      await workspace.validate(edit);
      db.workflowWrites++;
      db.localFiles.set(edit.relPath, edit.after);
    },
    pending: async (edit) => {
      await workspace.validate(edit);
      return db.workflowPending;
    },
  };
  const provider = {
    identity: async () => ({ ...db.identity }),
    authenticate: async () => ({ ...db.identity }),
    list: async () => structuredClone(db.machines),
    usage: async () => ({
      limits: { maxMachines: 5, machineSpec: { vcpus: 4, memMiB: 8192 } },
    }),
    get: async (mid) => structuredClone(db.machines.find((m) => m.id === mid)),
    create: async (name, repo) => {
      db.calls.push("create");
      const vm = {
        id: id(String.fromCharCode(97 + db.machines.length)),
        name,
        state: "running",
        runtime: { ready: true },
        metadata: { app: "boxci", repo },
        spec: { vcpus: 4, memMiB: 8192 },
        autoSuspendAfterSeconds: 1800,
      };
      db.machines.push(vm);
      return vm;
    },
    execScript: async (mid, script) => {
      db.calls.push("exec");
      const name = script.match(/OR_NAMES='([^']+)'/)?.[1];
      if (name) {
        db.runners.push({
          name,
          id: db.runners.length + 1,
          status: "online",
          busy: false,
          labels: [{ name: script.match(/OR_LABELS='([^']+)'/)[1] }],
        });
      }
      return "";
    },
    keys: async () => structuredClone(db.keyRecords),
    createKey: async (name) => {
      db.calls.push("key");
      db.keys++;
      db.keyRecords.push({
        id: "key_fixture_" + db.keys,
        name,
        expiresAt: "2030-01-01T00:00:00Z",
      });
      return {
        key: {
          id: "key_fixture_" + db.keys,
          expiresAt: "2030-01-01T00:00:00Z",
        },
        secret: "ibk_fixture_only_" + db.keys,
      };
    },
    cli: async (args) => {
      db.calls.push(args.join(" "));
    },
    wake: async (mid) => {
      db.calls.push("wake:" + mid);
      db.machines.find((m) => m.id === mid).state = "running";
    },
  };
  const github = {
    repo: async (r) => r || "acme/project",
    authenticate: async () => ({ login: "builder" }),
    runners: async () => structuredClone(db.runners),
    variable: async (_, name) => db.variables.get(name) ?? null,
    hasSecret: async (_, name) => db.secrets.has(name),
    secret: async (_, name, value) => {
      assert.match(value, /^ibk_fixture_only_/);
      if (db.failSecret) throw new Error("secret transfer failed");
      db.secrets.add(name);
    },
    content: async (_, path, ref) => db.files.get(ref + ":" + path) || null,
    recent: async () => [],
    consumerWorkflows: async (_, ref = "main") =>
      [...db.files.entries()]
        .filter(
          ([key, source]) =>
            key.startsWith(ref + ":") &&
            !key.endsWith(":" + helperPath) &&
            source.includes("./" + helperPath),
        )
        .map(([key]) => key.slice(ref.length + 1))
        .sort(),
    api: async (path, opts = {}) => {
      if (
        opts.method &&
        opts.method !== "GET" &&
        (/\/git\//.test(path) ||
          /\/contents\//.test(path) ||
          /\/pulls$/.test(path))
      )
        throw new Error("Remote workflow writes are forbidden");
      db.calls.push(opts.method || "GET");
      if (path === "user") return { login: "builder" };
      if (path === "repos/acme/project")
        return { permissions: { admin: true }, default_branch: "main" };
      if (path.endsWith("/downloads"))
        return [
          {
            os: "linux",
            architecture: "x64",
            filename: "actions-runner-linux-x64-2.337.0.tar.gz",
            sha256_checksum: "a".repeat(64),
          },
        ];
      if (path.endsWith("/registration-token"))
        return { token: "fixture-registration-token" };
      if (path.includes("/git/ref/heads/")) {
        const branch = path.split("/heads/")[1];
        if (branch === "main" || db.branches.has(branch))
          return { object: { sha: "base" } };
        throw new Error("HTTP 404");
      }
      if (path.endsWith("/git/refs")) {
        db.branches.add(opts.body.ref.replace("refs/heads/", ""));
        return {};
      }
      if (path.includes("/contents/") && opts.method === "PUT") {
        db.files.set(
          opts.body.branch + ":" + path.split("/contents/")[1],
          Buffer.from(opts.body.content, "base64").toString(),
        );
        return {};
      }
      if (path.includes("/actions/variables")) {
        db.variables.set(opts.body.name, opts.body.value);
        return {};
      }
      if (path.includes("/pulls?")) {
        const head = new URLSearchParams(path.split("?")[1]).get("head");
        return db.prs.filter((pr) => head.endsWith(":" + pr.branch));
      }
      if (path.endsWith("/pulls") && opts.method === "POST") {
        if (db.failCompletion) throw new Error("PR response lost");
        const pr = {
          number: db.prs.length + 1,
          html_url:
            "https://github.com/acme/project/pull/" + (db.prs.length + 1),
          branch: opts.body.head,
          state: "open",
          merged: false,
          draft: false,
        };
        db.prs.push(pr);
        return pr;
      }
      if (path.endsWith("/pulls/1")) return db.prs[0];
      if (path.includes("/dispatches")) return null;
      throw new Error("Unexpected fixture API " + path);
    },
  };
  return {
    db,
    provider,
    github,
    storage,
    app: new App({ provider, github, storage, workspace }),
  };
}
const options = {
  repo: "acme/project",
  command: "npm ci && npm test",
  yes: true,
};
test("new setup creates only the wake helper, never a starter or build workflow", async () => {
  const { app, db } = fixture();
  const state = await app.init({ repo: options.repo, yes: true });
  assert.equal(state.status, "ready_to_commit");
  assert.equal(state.helper_only, true);
  assert.deepEqual([...db.localFiles.keys()], [helperPath]);
  assert.equal(db.localFiles.get(helperPath), await reusableWakeWorkflow());
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.keys, 1);
  assert.equal(db.branches.size, 0);
  assert.equal(db.files.size, 0);
  assert.equal(db.prs.length, 0);
  assert.equal(JSON.stringify(db.project).includes("ibk_"), false);
  assert.deepEqual(JSON.parse(db.variables.get("BOXCI_POOL")), state.pool);
});
test("dry run and declined confirmation never provision or save a project", async () => {
  const { app, db } = fixture();
  await app.init({ ...options, dryRun: true });
  assert.equal(db.project, null);
  assert.equal(db.localFiles.size, 0);
  assert.equal(db.calls.includes("create"), false);
  await assert.rejects(
    app.init({ ...options, yes: false }, async () => false),
    /cancelled/,
  );
  assert.equal(db.project, null);
  assert.equal(db.localFiles.size, 0);
});
test("local write failure or an edit after review blocks setup before provisioning", async () => {
  const failed = fixture();
  failed.app.workspace.apply = async () => {
    throw new Error("checkout is read-only");
  };
  await assert.rejects(failed.app.init(options), /read-only/);
  assert.equal(failed.db.machines.length, 0);
  assert.equal(failed.db.keys, 0);
  const changed = fixture();
  await assert.rejects(
    changed.app.init({ ...options, yes: false }, async (plan) => {
      changed.db.localFiles.set(
        plan.workflow_edit.relPath,
        "my new local edits",
      );
      return true;
    }),
    /changed after review/,
  );
  assert.equal(changed.db.project, null);
  assert.equal(changed.db.machines.length, 0);
  assert.equal(changed.db.localFiles.get(helperPath), "my new local edits");
});
test("a legacy uploaded branch resumes into a local diff without changing that branch or registering another runner", async () => {
  const { app, db } = fixture();
  db.failSecret = true;
  await assert.rejects(app.init(options), /transfer failed/);
  db.project.workflow_delivery = undefined;
  db.project.helper_only = false;
  db.project.branch = "legacy-ci-branch";
  db.files.set(
    "legacy-ci-branch:" + db.project.workflow_path,
    "legacy uploaded workflow",
  );
  const remote = new Map(db.files);
  db.failSecret = false;
  db.calls = [];
  await app.init(options);
  assert.equal(db.project.branch, "legacy-ci-branch");
  assert.deepEqual(db.files, remote);
  assert.equal(db.branches.size, 0);
  assert.equal(db.prs.length, 0);
  assert.equal(db.calls.includes("create"), false);
  assert.equal(db.calls.includes("exec"), false);
  assert.equal(db.project.status, "ready_to_commit");
});
test("helper-only readiness requires a published helper and a connected application workflow", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.calls = [];
  assert.equal((await app.status(options)).workflow_published, false);
  assert.equal((await app.doctor(options)).ready, false);
  await assert.rejects(app.ciRun(options), /commit, and push/);
  db.files.set("main:" + helperPath, await reusableWakeWorkflow());
  assert.equal((await app.status(options)).workflow_published, true);
  assert.equal((await app.doctor(options)).ready, false);
  await assert.rejects(app.ciRun(options), /No application workflow/);
  db.files.set("main:.github/workflows/ci.yml", await workflow(db.project));
  assert.deepEqual((await app.status(options)).consumer_workflows, [
    ".github/workflows/ci.yml",
  ]);
  assert.equal((await app.doctor(options)).ready, true);
  assert.equal((await app.ciRun(options)).workflow, ".github/workflows/ci.yml");
});
test("helper-only dispatch selects the application workflow and never dispatches the reusable helper", async () => {
  const { app, db, github } = fixture();
  await app.init(options);
  db.files.set("main:" + helperPath, await reusableWakeWorkflow());
  for (const name of ["ci.yml", "test.yml"])
    db.files.set("main:.github/workflows/" + name, await workflow(db.project));
  await assert.rejects(app.ciRun(options), /--workflow/);
  const original = github.api;
  const dispatches = [];
  github.api = async (path, opts) => {
    if (opts?.method === "POST") dispatches.push(path);
    return original(path, opts);
  };
  const result = await app.ciRun({ ...options, workflow: "ci.yml" });
  assert.equal(result.workflow, ".github/workflows/ci.yml");
  assert.deepEqual(dispatches, [
    "repos/acme/project/actions/workflows/ci.yml/dispatches",
  ]);
  await assert.rejects(
    app.ciRun({ ...options, workflow: "boxci-wake.yml" }),
    /Choose your application workflow/,
  );
});
test("repeat init is prompt-free and makes no changes before or after committing and publishing the workflow", async () => {
  for (const phase of ["uncommitted", "committed", "published"]) {
    const { app, db } = fixture();
    await app.init(options);
    const path = db.project.workflow_path;
    db.localFiles.set(path, "name: Application CI\n# My customizations\n");
    db.workflowPending = phase === "uncommitted";
    if (phase === "published")
      db.files.set("main:" + path, db.localFiles.get(path));
    db.machines[0].state = "suspended";
    for (const char of "bcde")
      db.machines.push({
        id: id(char),
        name: "unrelated-" + char,
        state: "suspended",
      });
    const before = structuredClone(db);
    db.calls = [];
    const result = await app.init({ ...options, yes: false }, () => {
      assert.fail("unchanged setup must not prompt for approval");
    });
    assert.equal(result.already_configured, true, phase);
    assert.equal(result.workflow_pending, db.workflowPending);
    assert.match(
      result.message,
      /^Already configured\. No setup changes needed\./,
    );
    assert.match(
      result.message,
      phase === "uncommitted"
        ? /Wake helper has local changes/
        : /Wake helper is committed locally/,
    );
    assert.equal(db.saves, before.saves);
    assert.equal(db.workflowWrites, before.workflowWrites);
    assert.deepEqual(db.project, before.project);
    assert.deepEqual(db.localFiles, before.localFiles);
    assert.deepEqual(db.files, before.files);
    assert.deepEqual(db.machines, before.machines);
    assert.deepEqual(db.runners, before.runners);
    assert.deepEqual(db.variables, before.variables);
    assert.deepEqual(db.secrets, before.secrets);
    assert.equal(db.keys, before.keys);
    assert.ok(db.calls.every((call) => call === "GET"));
  }
});
test("prompt-free repeat init still rejects account, checkpoint and workflow changes during review", async () => {
  for (const changed of ["identity", "project", "workflow"]) {
    const { app, db, storage } = fixture();
    await app.init(options);
    const saves = db.saves;
    storage.locked = async (_, fn) => {
      if (changed === "identity") db.identity.userId++;
      else if (changed === "project")
        db.project.command = "concurrently changed command";
      else db.localFiles.set(helperPath, "concurrently changed workflow");
      return fn();
    };
    db.calls = [];
    await assert.rejects(app.init({ ...options, yes: false }), /changed/);
    assert.equal(db.saves, saves);
    assert.equal(db.machines.length, 1);
    assert.equal(db.runners.length, 1);
    assert.ok(db.calls.every((call) => call === "GET"));
  }
});
test("repeat init accepts equivalent manifest formatting and pool order", async () => {
  const { app, db } = fixture();
  await app.init({ ...options, count: 3 });
  const reordered = [...db.project.pool]
    .reverse()
    .map((member) => Object.fromEntries(Object.entries(member).reverse()));
  db.variables.set(
    db.project.pool_variable,
    JSON.stringify(reordered, null, 2),
  );
  const result = await app.init({ ...options, yes: false }, () =>
    assert.fail("equivalent manifest must not prompt"),
  );
  assert.equal(result.already_configured, true);
  assert.equal(db.machines.length, 3);
  assert.equal(db.runners.length, 3);
});
test("a missing local workflow still requires approval and restores only the file using the existing pool", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.localFiles.delete(helperPath);
  const before = structuredClone(db);
  db.calls = [];
  await assert.rejects(
    app.init({ ...options, yes: false }, async () => false),
    /cancelled/,
  );
  assert.equal(db.localFiles.size, 0);
  assert.equal(db.saves, before.saves);
  assert.equal((await app.plan(options)).already_configured, undefined);
  await app.init(options);
  assert.ok(db.localFiles.has(helperPath));
  assert.deepEqual(db.machines, before.machines);
  assert.deepEqual(db.runners, before.runners);
  assert.equal(db.keys, before.keys);
  assert.ok(db.calls.every((call) => call === "GET"));
});
test("legacy records retain their starter path but deleted starters are never recreated", async () => {
  const { app, db } = fixture();
  await app.init(options);
  const path = db.project.workflow_path;
  const legacy = await workflow(db.project);
  db.localFiles.set(path, legacy);
  delete db.project.helper_only;
  const before = structuredClone(db);
  await app.init({ ...options, yes: false }, () =>
    assert.fail("existing helper needs no approval"),
  );
  assert.equal(db.localFiles.get(path), legacy);
  db.localFiles.delete(path);
  const saved = structuredClone(db.project);
  await app.init({ ...options, yes: false }, () =>
    assert.fail("missing starter must not trigger creation"),
  );
  assert.equal(db.localFiles.has(path), false);
  assert.deepEqual(db.project, saved);
  assert.equal(db.project.workflow_path, path);
  assert.deepEqual(db.machines, before.machines);
  assert.deepEqual(db.runners, before.runners);
  assert.equal(db.keys, before.keys);
});
test("helper conflicts or changes after approval block init before any setup mutation", async () => {
  const { app, db } = fixture();
  db.localFiles.set(".github/workflows/boxci-wake.yml", "my custom helper");
  await assert.rejects(app.init(options), /conflict/);
  assert.equal(db.machines.length, 0);
  db.localFiles.clear();
  await assert.rejects(
    app.init({ ...options, yes: false }, async () => {
      db.localFiles.set(".github/workflows/boxci-wake.yml", "concurrent edit");
      return true;
    }),
    /changed after review/,
  );
  assert.equal(db.localFiles.has(".github/workflows/boxci.yml"), false);
  assert.equal(db.machines.length, 0);
});
test("interrupted legacy setup resumes only its helper and keeps its existing VM and runner", async () => {
  const { app, db } = fixture();
  db.failSecret = true;
  await assert.rejects(app.init(options), /transfer failed/);
  delete db.project.helper_only;
  db.localFiles.delete(helperPath);
  db.failSecret = false;
  db.calls = [];
  await app.init(options);
  assert.deepEqual([...db.localFiles.keys()], [helperPath]);
  assert.equal(db.project.helper_only, true);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.calls.includes("create"), false);
  assert.equal(db.calls.includes("exec"), false);
});
test("repeat init cannot report configured when the saved secret or pool variable is missing or different", async () => {
  for (const missing of ["secret", "variable", "different", "invalid"]) {
    const { app, db } = fixture();
    await app.init(options);
    if (missing === "secret") db.secrets.clear();
    else if (missing === "variable") db.variables.clear();
    else
      db.variables.set(
        db.project.pool_variable,
        missing === "invalid" ? "invalid" : "[]",
      );
    const before = structuredClone(db);
    db.calls = [];
    await assert.rejects(
      app.init(options),
      missing === "secret"
        ? /secret.*missing.*auth renew/
        : /variable.*missing or differs/,
    );
    assert.deepEqual(db.project, before.project);
    assert.equal(db.saves, before.saves);
    assert.equal(db.workflowWrites, before.workflowWrites);
    assert.equal(db.keys, before.keys);
    assert.deepEqual(db.machines, before.machines);
    assert.deepEqual(db.runners, before.runners);
    assert.ok(db.calls.every((call) => call === "GET"));
  }
});
test("saved three-VM project is adopted without VM, credential or GitHub writes", async () => {
  const f = fixture();
  const pool = Array.from("abc", (c, i) => ({
    machine_id: id(c),
    runner_name: "ci-" + i,
    expected_name: "ci-" + i,
  }));
  f.db.machines = pool.map((p) => ({
    id: p.machine_id,
    name: p.expected_name,
    state: "suspended",
    autoSuspendAfterSeconds: 1800,
  }));
  f.db.runners = pool.map((p) => ({
    name: p.runner_name,
    labels: [{ name: "pool" }],
    status: "offline",
    busy: false,
  }));
  f.db.secrets.add("EXISTING_KEY");
  f.db.variables.set("INSTABOX_CI_POOL", JSON.stringify(pool));
  f.db.project = {
    version: 1,
    repo: "acme/project",
    account: { userId: 7, login: "developer" },
    github_login: "developer",
    pool,
    label: "pool",
    secret: "EXISTING_KEY",
    pool_variable: "INSTABOX_CI_POOL",
    managed_workflow: false,
    workflow_path: ".github/workflows/existing.yml",
    pr_url: "https://github.com/acme/project/pull/1",
    pr_number: 1,
    status: "awaiting_merge",
  };
  const result = await f.app.init({ repo: "acme/project", yes: true });
  assert.equal(result.pool.length, 3);
  assert.equal(result.managed_workflow, false);
  assert.equal(f.db.keys, 0);
  assert.equal(f.db.calls.includes("exec"), false);
  assert.equal(f.db.calls.includes("POST"), false);
});
test("completion checkpoint failure resumes from checkpoint without a second VM, runner or key", async () => {
  const { app, db } = fixture();
  db.failCompletion = true;
  await assert.rejects(app.init(options), /response lost/);
  db.failCompletion = false;
  await app.init(options);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.keys, 1);
  assert.equal(db.prs.length, 0);
});
test("failed secret transfer revokes the orphan key on reviewed retry without duplicating machines", async () => {
  const { app, db } = fixture();
  db.failSecret = true;
  await assert.rejects(app.init(options), /transfer failed/);
  assert.equal(db.project.status, "credential_pending");
  db.failSecret = false;
  await app.init(options);
  assert.equal(db.machines.length, 1);
  assert.equal(db.keys, 2);
  assert.ok(db.calls.includes("keys rm key_fixture_1"));
  assert.equal(db.project.key_id, "key_fixture_2");
});
test("flat CLI key response works for setup and credential renewal", async () => {
  const { app, db, provider } = fixture();
  const create = provider.createKey;
  provider.createKey = async (name) => {
    const result = await create(name);
    return { ...result.key, name, key: result.secret };
  };
  await app.init(options);
  assert.equal(db.project.key_id, "key_fixture_1");
  await app.renew(options);
  assert.equal(db.project.key_id, "key_fixture_2");
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(JSON.stringify(db.project).includes("ibk_"), false);
});
test("certificate validation failure resumes the same VM and runner at full quota and retires only the recorded key after delivery", async () => {
  const { app, db, provider, github } = fixture();
  provider.validateKey = async () => {
    const error = new Error("GET /v1/machines/fixture failed: fetch failed");
    error.code = "network_error";
    error.cause = Object.assign(new Error("certificate chain"), {
      code: "SELF_SIGNED_CERT_IN_CHAIN",
    });
    throw error;
  };
  await assert.rejects(app.init(options), /fetch failed/);
  assert.equal(db.project.status, "credential_pending");
  assert.equal(db.project.key_id, "key_fixture_1");
  assert.equal(db.secrets.size, 0);
  assert.equal(
    db.calls.some((c) => c.startsWith("keys rm")),
    false,
  );
  const savedPool = structuredClone(db.project.pool);
  provider.usage = async () => ({ limits: { maxMachines: 1 } });
  provider.validateKey = async (_, account, machineId) => {
    assert.equal(account, 7);
    assert.equal(machineId, savedPool[0].machine_id);
  };
  const transfer = github.secret;
  github.secret = async (...args) => {
    assert.equal(
      db.calls.some((c) => c.startsWith("keys rm")),
      false,
    );
    return transfer(...args);
  };
  db.calls = [];
  const plan = await app.plan(options);
  assert.equal(plan.count, 0);
  assert.deepEqual(plan.pool, savedPool);
  await app.init(options);
  assert.deepEqual(db.project.pool, savedPool);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.calls.includes("create"), false);
  assert.equal(db.calls.includes("exec"), false);
  assert.equal(
    db.calls.some((c) => c.startsWith("wake:")),
    false,
  );
  assert.ok(db.calls.includes("keys rm key_fixture_1"));
  assert.equal(db.project.status, "ready_to_commit");
  assert.equal(JSON.stringify(db.project).includes("ibk_"), false);
});
test("CLI response containing only a secret fetches metadata by the checkpointed request name", async () => {
  const { app, db, provider } = fixture();
  const create = provider.createKey;
  provider.createKey = async (name) => ({ key: (await create(name)).secret });
  await app.init(options);
  assert.equal(db.project.key_id, "key_fixture_1");
  assert.equal(db.project.creating_key, undefined);
});
test("lost key response recovers only its checkpointed key and retry creates no extra VM or runner", async () => {
  const { app, db, provider } = fixture();
  const create = provider.createKey;
  provider.createKey = async (name) => {
    await create(name);
    throw new Error("key response lost");
  };
  await assert.rejects(app.init(options), /key response lost/);
  assert.equal(db.project.creating_key.name, db.keyRecords[0].name);
  db.keyRecords.push({
    id: "key_unrecorded",
    name: "boxci-unrelated",
    expiresAt: "2030-01-01T00:00:00Z",
  });
  provider.createKey = create;
  await app.init(options);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.project.key_id, "key_fixture_2");
  assert.equal(db.project.creating_key, undefined);
  assert.ok(db.calls.includes("keys rm key_fixture_1"));
  assert.equal(db.calls.includes("keys rm key_unrecorded"), false);
});
test("ambiguous checkpointed key metadata blocks retry without another key, VM or runner", async () => {
  const { app, db, provider } = fixture();
  const create = provider.createKey;
  provider.createKey = async (name) => {
    await create(name);
    throw new Error("key response lost");
  };
  await assert.rejects(app.init(options), /key response lost/);
  db.keyRecords.push({ ...db.keyRecords[0], id: "key_duplicate" });
  provider.createKey = create;
  await assert.rejects(app.init(options), /ambiguous/);
  assert.equal(db.keys, 1);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(
    db.calls.some((c) => c.startsWith("keys rm")),
    false,
  );
});
test("account switch during key creation blocks secret transfer and key retirement", async () => {
  const { app, db, provider } = fixture();
  const create = provider.createKey;
  provider.createKey = async (name) => {
    const result = await create(name);
    db.identity = { userId: 8, login: "other" };
    return result;
  };
  await assert.rejects(app.init(options), /account changed/);
  assert.equal(db.secrets.size, 0);
  assert.equal(db.project.pending_keys.length, 1);
  assert.equal(
    db.calls.some((c) => c.startsWith("keys rm")),
    false,
  );
});
test("retry of a legacy metadata failure reuses its VM and runner without touching an unrecorded key", async () => {
  const { app, db, provider } = fixture();
  const create = provider.createKey;
  provider.createKey = async (name) => {
    await create(name);
    throw new Error("legacy metadata failure");
  };
  await assert.rejects(app.init(options), /legacy metadata failure/);
  delete db.project.creating_key;
  provider.usage = async () => ({ limits: { maxMachines: 1 } });
  provider.createKey = async (name) => {
    const result = await create(name);
    return { ...result.key, key: result.secret };
  };
  db.calls = [];
  await app.init(options);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.calls.includes("create"), false);
  assert.equal(db.calls.includes("exec"), false);
  assert.equal(db.calls.includes("keys rm key_fixture_1"), false);
});
test("adopting a complete setup preserves pending credential recovery metadata", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.project.creating_key = { name: "boxci-pending" };
  db.project.pending_keys = [
    { id: "key_pending", expiresAt: "2030-01-01T00:00:00Z" },
  ];
  await app.init(options);
  assert.equal(db.project.creating_key.name, "boxci-pending");
  assert.equal(db.project.pending_keys[0].id, "key_pending");
});
test("saved runner identity is rechecked before resumed credential changes", async () => {
  const { app, db } = fixture();
  db.failSecret = true;
  await assert.rejects(app.init(options), /transfer failed/);
  db.machines[0].name = "renamed";
  db.calls = [];
  db.failSecret = false;
  await assert.rejects(app.init(options), /missing or renamed/);
  assert.equal(db.calls.includes("key"), false);
  assert.equal(
    db.calls.some((c) => c.startsWith("keys rm")),
    false,
  );
});
test("already-retired recorded keys are cleared without deleting unrelated keys", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.project.keys_to_retire = ["key_already_removed"];
  db.calls = [];
  await app.retireRecordedKeys(db.project);
  assert.deepEqual(db.project.keys_to_retire, []);
  assert.equal(
    db.calls.some((c) => c.startsWith("keys rm")),
    false,
  );
});
test("a corrupt retirement queue is rejected in full before any deletion", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.project.keys_to_retire = ["key_old", db.project.key_id];
  db.calls = [];
  await assert.rejects(app.retireRecordedKeys(db.project), /invalid/);
  assert.deepEqual(db.calls, []);
});
test("account changed after review blocks every mutation", async () => {
  const { app, db } = fixture();
  await assert.rejects(
    app.init({ ...options, yes: false }, async () => {
      db.identity = { userId: 8, login: "other" };
      return true;
    }),
    /account changed/,
  );
  assert.equal(db.project, null);
  assert.equal(db.machines.length, 0);
});
async function switchedAccountFixture() {
  const f = fixture();
  await f.app.init(options);
  f.db.project.workflow_delivery = undefined;
  f.db.project.branch = "legacy-ci-branch";
  f.db.project.pr_url = "https://github.com/acme/project/pull/1";
  f.db.project.pr_number = 1;
  f.db.project.status = "awaiting_merge";
  f.db.files.set(
    "legacy-ci-branch:" + f.db.project.workflow_path,
    f.db.localFiles.get(f.db.project.workflow_path),
  );
  const old = structuredClone(f.db.project);
  f.db.identity = { userId: -8, login: "current@example.test" };
  f.db.machines = [];
  f.db.calls = [];
  return { ...f, old };
}
test("account mismatch previews a fresh current-account setup and cancellation preserves the old record", async () => {
  const { app, db, old } = await switchedAccountFixture();
  const plan = await app.init({ ...options, dryRun: true });
  assert.deepEqual(plan.account, db.identity);
  assert.equal(plan.source, "new-pool");
  assert.deepEqual(plan.pool, []);
  assert.notEqual(plan.label, old.label);
  assert.notEqual(plan.secret, old.secret);
  assert.notEqual(plan.pool_variable, old.pool_variable);
  assert.notEqual(plan.workflow_path, old.workflow_path);
  assert.equal(plan.previous_project.archive_path, archiveFileFor(old));
  assert.match(plan.actions.join("\n"), /fresh pool as current@example.test/);
  await assert.rejects(
    app.init({ ...options, yes: false }, async () => false),
    /cancelled/,
  );
  assert.deepEqual(db.project, old);
  assert.deepEqual(db.archives, []);
  assert.ok(db.calls.every((c) => c === "GET"));
});
test("approved fresh setup archives the full old record and isolates GitHub resources and runner names", async () => {
  const { app, db, old } = await switchedAccountFixture();
  const oldVariables = new Map(db.variables);
  const oldFiles = new Map(db.files);
  const oldRunners = structuredClone(db.runners);
  const state = await app.init(options);
  assert.deepEqual(db.archives, [old]);
  assert.deepEqual(state.account, db.identity);
  assert.notEqual(state.pool[0].runner_name, old.pool[0].runner_name);
  assert.equal(state.key_id, "key_fixture_2");
  assert.notEqual(state.pr_url, old.pr_url);
  assert.equal(state.previous_project.archive_path, archiveFileFor(old));
  for (const [k, v] of oldVariables) assert.equal(db.variables.get(k), v);
  for (const [k, v] of oldFiles) assert.equal(db.files.get(k), v);
  assert.deepEqual(db.runners.slice(0, oldRunners.length), oldRunners);
  assert.ok(db.secrets.has(old.secret));
  assert.equal(db.localFiles.get(helperPath), await reusableWakeWorkflow());
  assert.equal(db.localFiles.has(state.workflow_path), false);
  await app.init(options);
  assert.deepEqual(db.archives, [old]);
  assert.equal(db.keys, 2);
  await app.add({ ...options, count: 1 });
  assert.ok(
    db.project.pool.every((p) =>
      p.runner_name.startsWith(state.runner_prefix + "-"),
    ),
  );
});
test("fresh setup failure resumes its new checkpoints without losing the archived pool", async () => {
  const { app, db, old } = await switchedAccountFixture();
  db.failCompletion = true;
  await assert.rejects(app.init(options), /response lost/);
  assert.deepEqual(db.archives, [old]);
  assert.deepEqual(db.project.account, db.identity);
  const pool = structuredClone(db.project.pool);
  db.failCompletion = false;
  await app.init(options);
  assert.deepEqual(db.project.pool, pool);
  assert.deepEqual(db.archives, [old]);
  assert.equal(db.keys, 2);
  assert.equal(db.machines.length, 1);
});
test("archive failure stops fresh setup before saving or mutating resources", async () => {
  const { app, db, storage, old } = await switchedAccountFixture();
  storage.archiveProject = async () => {
    throw new Error("archive unavailable");
  };
  await assert.rejects(app.init(options), /archive unavailable/);
  assert.deepEqual(db.project, old);
  assert.ok(db.calls.every((c) => c === "GET"));
});
test("account or saved-record changes during fresh setup review prevent archiving and mutations", async () => {
  for (const change of ["account", "record"]) {
    const { app, db, old } = await switchedAccountFixture();
    await assert.rejects(
      app.init({ ...options, yes: false }, async () => {
        if (change === "account") db.identity = old.account;
        else db.project.status = "changed";
        return true;
      }),
      /changed after review/,
    );
    assert.deepEqual(db.archives, []);
    assert.ok(db.calls.every((c) => c === "GET"));
  }
});
test("fresh setup refuses old labels, old secrets and resources appearing during review", async () => {
  const { app, db, old } = await switchedAccountFixture();
  await assert.rejects(
    app.init({ ...options, label: old.label }),
    /dedicated label/,
  );
  await assert.rejects(
    app.init({ ...options, secret: old.secret }),
    /unused --secret/,
  );
  for (const collision of [
    "label",
    "runner",
    "variable",
    "secret",
    "workflow",
    "vm",
  ]) {
    const f = await switchedAccountFixture();
    await assert.rejects(
      f.app.init({ ...options, yes: false }, async (plan) => {
        if (collision === "label")
          f.db.runners.push({ name: "other", labels: [{ name: plan.label }] });
        if (collision === "runner")
          f.db.runners.push({ name: plan.runner_prefix + "-01", labels: [] });
        if (collision === "variable")
          f.db.variables.set(plan.pool_variable, "[]");
        if (collision === "secret") f.db.secrets.add(plan.secret);
        if (collision === "workflow")
          f.db.files.set(plan.base + ":" + plan.workflow_path, "existing");
        if (collision === "vm")
          f.db.machines.push({ name: plan.runner_prefix + "-01" });
        return true;
      }),
      /resources changed after review/,
    );
    assert.deepEqual(f.db.project, f.old);
    assert.deepEqual(f.db.archives, []);
    assert.ok(f.db.calls.every((c) => c === "GET"));
  }
  assert.deepEqual(db.project, old);
});
test("wake and growth still refuse to operate the saved pool under another account", async () => {
  const { app, db, old } = await switchedAccountFixture();
  await assert.rejects(app.wake(options), /saved pool belongs to/);
  await assert.rejects(app.add(options), /saved pool belongs to/);
  assert.deepEqual(db.project, old);
  assert.deepEqual(db.calls, []);
});
test("adding a runner updates the CI manifest, not an unused local-only list", async () => {
  const { app, db } = fixture();
  await app.init(options);
  const result = await app.add({ repo: "acme/project", count: 2, yes: true });
  assert.equal(result.pool.length, 3);
  assert.deepEqual(JSON.parse(db.variables.get("BOXCI_POOL")), result.pool);
  assert.equal(db.keys, 1);
});
test("quota is read dynamically and rejects growth before any creation", async () => {
  assert.throws(
    () =>
      quotaPlan({ limits: { maxMachines: 1 } }, [{ state: "suspended" }], 1),
    /only 0 slots/,
  );
  const { app, db, provider } = fixture();
  provider.usage = async () => ({ limits: { maxMachines: 0 } });
  await assert.rejects(app.init(options), /only 0 slots/);
  assert.equal(db.machines.length, 0);
});
test("status on paused VMs never executes guest commands or resumes them", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.machines[0].state = "suspended";
  db.runners[0].status = "offline";
  db.calls = [];
  const state = await app.status({ repo: "acme/project" });
  assert.equal(state.members[0].vm.state, "suspended");
  assert.equal(state.members[0].runner.status, "offline");
  assert.equal(db.calls.includes("exec"), false);
  assert.equal(
    db.calls.some((c) => c.startsWith("wake")),
    false,
  );
});
test("unmanaged runner sharing the pool label is rejected before wake", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.runners.push({ name: "unmanaged", labels: [{ name: db.project.label }] });
  await assert.rejects(app.wake({ repo: "acme/project" }), /unmanaged/);
  assert.equal(
    db.calls.some((c) => c.startsWith("wake")),
    false,
  );
});
test("registration collision cannot replace another runner", () => {
  assert.throws(
    () =>
      validatePool(
        [{ machine_id: id("a"), runner_name: "ci", expected_name: "ci" }],
        [{ id: id("a"), name: "ci" }],
        [{ name: "ci", labels: [{ name: "Linux" }] }],
        "Linux",
      ),
    /dedicated/,
  );
});
test("CI dispatch refuses unmerged defaults and allows an explicit reviewed branch", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.project.helper_only = false;
  db.project.managed_workflow = false;
  await assert.rejects(app.ciRun({ repo: "acme/project" }), /commit, and push/);
  const result = await app.ciRun({
    repo: "acme/project",
    ref: "reviewed-ci-branch",
  });
  assert.equal(result.ref, "reviewed-ci-branch");
});
test("native provider reuses auth and falls back to bundled official CLI without reading credentials", async () => {
  const calls = [];
  const p = new Provider({
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "instabox") {
        const e = new Error("not found");
        e.code = "ENOENT";
        throw e;
      }
      return JSON.stringify({ userId: 7, login: "developer" });
    },
  });
  assert.deepEqual(await p.authenticate(), { userId: 7, login: "developer" });
  assert.equal(calls[1][0], process.execPath);
  assert.equal(calls[1][1][0], "--import");
  assert.ok(calls[1][1][1].endsWith("/src/certificate-preload.js"));
  assert.ok(calls[1][1][2].endsWith("instabox.mjs"));
  assert.equal(
    calls.some((c) => c[1].includes("login")),
    false,
  );
});
test("errors redact provider and GitHub credentials", () => {
  assert.equal(
    redact("bad ibk_supersecret github_pat_topsecret ghp_abc"),
    "bad [redacted] [redacted] [redacted]",
  );
});

test("credential renewal installs before retiring old keys and retains recoverable metadata on failure", async () => {
  const { app, db } = fixture();
  await app.init(options);
  db.failSecret = true;
  await assert.rejects(
    app.renew({ repo: "acme/project", yes: true }),
    /transfer failed/,
  );
  assert.equal(db.project.key_id, "key_fixture_1");
  assert.equal(db.project.pending_keys.length, 1);
  assert.equal(
    db.calls.some((c) => c.startsWith("keys rm")),
    false,
  );
  db.failSecret = false;
  await app.renew({ repo: "acme/project", yes: true });
  assert.equal(db.project.key_id, "key_fixture_3");
  assert.deepEqual(db.project.pending_keys, []);
  assert.ok(db.calls.includes("keys rm key_fixture_1"));
  assert.ok(db.calls.includes("keys rm key_fixture_2"));
  assert.equal(JSON.stringify(db.project).includes("ibk_"), false);
});

test("lost create response recovers its owned VM even when it fills the account quota", async () => {
  const { app, db, provider } = fixture();
  provider.usage = async () => ({ limits: { maxMachines: 1 } });
  const create = provider.create;
  let first = true;
  provider.create = async (...args) => {
    const vm = await create(...args);
    if (first) {
      first = false;
      throw new Error("response lost");
    }
    return vm;
  };
  await assert.rejects(app.init(options), /response lost/);
  assert.equal(db.machines.length, 1);
  await app.init(options);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.prs.length, 0);
});

test("draft integration history stays scoped to its CI branch instead of unrelated default-branch Mac runs", async () => {
  const { app, db, github } = fixture();
  await app.init(options);
  db.project.workflow_delivery = undefined;
  db.project.helper_only = false;
  db.project.branch = "legacy-ci-branch";
  db.project.pr_number = 1;
  db.prs.push({
    html_url: "https://github.com/acme/project/pull/1",
    merged: false,
  });
  let branch;
  github.recent = async (_, __, selected) => {
    branch = selected;
    return [];
  };
  await app.status({ repo: "acme/project" });
  assert.equal(branch, db.project.branch);
});

test("custom test commands still infer pnpm setup from the repository package manager", async () => {
  const { app, github } = fixture();
  github.content = async (_, path) =>
    path === "package.json"
      ? JSON.stringify({
          packageManager: "pnpm@10.17.1",
          scripts: { test: "vitest run" },
        })
      : null;
  const plan = await app.plan({
    ...options,
    command: "pnpm install && pnpm test --filter app",
  });
  assert.equal(plan.manager, "pnpm");
  assert.equal(plan.managerVersion, "10.17.1");
  assert.equal(plan.command, "pnpm install && pnpm test --filter app");
});
function existingPoolFixture(variableName) {
  const f = fixture();
  const pool = [
    {
      machine_id: id("a"),
      runner_name: "existing",
      expected_name: "existing",
    },
  ];
  f.db.machines = [
    { id: id("a"), name: "existing", metadata: {}, state: "suspended" },
  ];
  f.db.runners = [{ name: "existing", labels: [{ name: "existing-pool" }] }];
  f.db.variables.set(variableName, JSON.stringify(pool));
  return { ...f, pool };
}

for (const variableName of ["BOXCI_POOL", "INSTABOX_CI_POOL"]) {
  test(`fresh setup discovers ${variableName}, reuses its VMs and keeps growth on that manifest`, async () => {
    const { app, db, pool } = existingPoolFixture(variableName);
    const plan = await app.init({ ...options, dryRun: true });
    assert.equal(plan.label, "existing-pool");
    assert.equal(plan.pool_variable, variableName);
    assert.equal(plan.adopt_only, false);
    assert.deepEqual(plan.pool, pool);
    assert.equal(db.project, null);
    assert.equal(
      db.calls.every((call) => call === "GET"),
      true,
    );
    assert.ok(plan.actions.some((a) => a.includes(helperPath)));

    const result = await app.init(options);
    assert.equal(result.pool_variable, variableName);
    assert.equal(result.pool.length, 1);
    assert.equal(db.machines.length, 1);
    assert.equal(db.calls.includes("create"), false);
    assert.equal(db.calls.includes("exec"), false);
    assert.equal(db.prs.length, 0);
    assert.equal(db.localFiles.get(helperPath), await reusableWakeWorkflow());
    assert.equal(db.localFiles.has(result.workflow_path), false);

    const grown = await app.add({ repo: options.repo, count: 1, yes: true });
    assert.equal(grown.pool.length, 2);
    assert.deepEqual(JSON.parse(db.variables.get(variableName)), grown.pool);
    assert.equal(db.variables.size, 1);
  });
}

test("fresh discovery prefers BOXCI_POOL when both variable names exist", async () => {
  const { app, db, pool } = existingPoolFixture("BOXCI_POOL");
  db.variables.set("INSTABOX_CI_POOL", "stale legacy manifest");
  const plan = await app.init({ ...options, dryRun: true });
  assert.equal(plan.pool_variable, "BOXCI_POOL");
  assert.deepEqual(plan.pool, pool);
  assert.equal(db.project, null);
});

test("a recorded manifest remains authoritative when BOXCI_POOL also exists", async () => {
  const { app, db, github } = fixture();
  await app.init(options);
  db.project.pool_variable = "CUSTOM_POOL";
  db.variables.set("CUSTOM_POOL", JSON.stringify(db.project.pool));
  db.variables.set("BOXCI_POOL", "unrelated manifest");
  const reads = [];
  const variable = github.variable;
  github.variable = async (...args) => {
    reads.push(args[1]);
    return variable(...args);
  };
  db.calls = [];
  const result = await app.init({ repo: options.repo, yes: true });
  assert.equal(result.pool_variable, "CUSTOM_POOL");
  assert.deepEqual(reads, ["CUSTOM_POOL"]);
  assert.equal(
    db.calls.every((call) => call === "GET"),
    true,
  );
});

test("an invalid current manifest cannot fall back to a valid legacy pool", async () => {
  const { app, db } = existingPoolFixture("INSTABOX_CI_POOL");
  db.variables.set(
    "BOXCI_POOL",
    JSON.stringify([
      { machine_id: id("b"), runner_name: "missing", expected_name: "missing" },
    ]),
  );
  await assert.rejects(app.init(options), /ambiguous custom labels/);
  assert.equal(db.project, null);
  assert.equal(
    db.calls.every((call) => call === "GET"),
    true,
  );
});

for (const manifest of ["invalid JSON", "", "null", "[]", "{}"]) {
  test(`invalid BOXCI_POOL ${JSON.stringify(manifest)} cannot fall back or create resources`, async () => {
    const { app, db } = existingPoolFixture("INSTABOX_CI_POOL");
    db.variables.set("BOXCI_POOL", manifest);
    await assert.rejects(app.init(options), /JSON|Pool must/);
    assert.equal(db.project, null);
    assert.equal(
      db.calls.every((call) => call === "GET"),
      true,
    );
  });
}
