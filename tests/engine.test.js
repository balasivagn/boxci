import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { App, validatePool, quotaPlan } from "../src/engine.js";
import { Provider } from "../src/provider.js";
import { redact } from "../src/process.js";
const id = (char) => "m_" + char.repeat(26);
function fixture() {
  const db = {
    project: null,
    machines: [],
    runners: [],
    secrets: new Set(),
    variables: new Map(),
    files: new Map(),
    branches: new Set(),
    calls: [],
    keys: 0,
    prs: [],
    failPR: false,
    failSecret: false,
    identity: { userId: 7, login: "developer" },
  };
  const storage = {
    readProject: async () => structuredClone(db.project),
    saveProject: async (p) => {
      db.project = structuredClone(p);
    },
    locked: async (_, fn) => fn(),
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
    createKey: async () => {
      db.calls.push("key");
      db.keys++;
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
    api: async (path, opts = {}) => {
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
      if (path.includes("/pulls?")) return db.prs;
      if (path.endsWith("/pulls") && opts.method === "POST") {
        if (db.failPR) throw new Error("PR response lost");
        const pr = {
          number: 1,
          html_url: "https://github.com/acme/project/pull/1",
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
    app: new App({ provider, github, storage }),
  };
}
const options = {
  repo: "acme/project",
  command: "npm ci && npm test",
  yes: true,
};
test("new setup creates a verified service runner, transfers the credential privately and opens a workflow PR", async () => {
  const { app, db } = fixture();
  const state = await app.init(options);
  assert.equal(state.status, "awaiting_merge");
  assert.equal(state.pool.length, 1);
  assert.equal(db.keys, 1);
  assert.deepEqual(JSON.parse(db.variables.get("BOXCI_POOL")), state.pool);
  const source = [...db.files.values()][0];
  assert.match(source, /vars.BOXCI_POOL/);
  assert.match(source, /ThreadPoolExecutor/);
  assert.match(source, /head.repo.full_name == github.repository/);
  assert.ok(source.indexOf("actions/checkout") > source.indexOf("  build:"));
  assert.equal(JSON.stringify(db.project).includes("ibk_"), false);
  assert.equal(
    JSON.stringify(db.project).includes("fixture-registration-token"),
    false,
  );
});
test("dry run and declined confirmation never provision or save a project", async () => {
  const { app, db } = fixture();
  await app.init({ ...options, dryRun: true });
  assert.equal(db.project, null);
  assert.equal(db.calls.includes("create"), false);
  await assert.rejects(
    app.init({ ...options, yes: false }, async () => false),
    /cancelled/,
  );
  assert.equal(db.project, null);
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
test("PR failure resumes from checkpoint without a second VM, runner or key", async () => {
  const { app, db } = fixture();
  db.failPR = true;
  await assert.rejects(app.init(options), /response lost/);
  db.failPR = false;
  await app.init(options);
  assert.equal(db.machines.length, 1);
  assert.equal(db.runners.length, 1);
  assert.equal(db.keys, 1);
  assert.equal(db.prs.length, 1);
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
  await assert.rejects(app.ciRun({ repo: "acme/project" }), /Merge/);
  const result = await app.ciRun({
    repo: "acme/project",
    ref: db.project.branch,
  });
  assert.equal(result.ref, db.project.branch);
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
  assert.ok(calls[1][1][0].endsWith("instabox.mjs"));
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
  assert.equal(db.prs.length, 1);
});

test("draft integration history stays scoped to its CI branch instead of unrelated default-branch Mac runs", async () => {
  const { app, db, github } = fixture();
  await app.init(options);
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
    assert.ok(plan.actions.some((a) => a.includes("workflow PR")));

    const result = await app.init(options);
    assert.equal(result.pool_variable, variableName);
    assert.equal(result.pool.length, 1);
    assert.equal(db.machines.length, 1);
    assert.equal(db.calls.includes("create"), false);
    assert.equal(db.calls.includes("exec"), false);
    assert.equal(db.prs.length, 1);
    const source = db.files.get(result.branch + ":" + result.workflow_path);
    assert.ok(source.includes(`vars.${variableName}`));

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
