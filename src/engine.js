import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Provider } from "./provider.js";
import { GitHub } from "./github.js";
import * as store from "./store.js";
import { protect, redact } from "./process.js";
import { workflow } from "./workflow.js";
import {
  buildMigratePlan,
  applyMigratePlan,
  scanWorkflows,
  promptJobSelection,
  gitRoot,
} from "./migrate.js";
import { ownsVm, runnerAdoptVerifyScript, runnerInstallRoot } from "./brand.js";
export { runnerInstallRoot } from "./brand.js";
export const defaults = {
  secret: "BOXCI_API_KEY",
  workflow: ".github/workflows/boxci.yml",
};
const safeName = /^[a-z0-9][a-z0-9-]{0,62}$/;
const labelPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const generic = new Set(["self-hosted", "linux", "x64", "arm64"]);
export function validatePool(pool, machines, runners, label) {
  if (!Array.isArray(pool) || !pool.length || pool.length > 5)
    throw new Error("Pool must have one to five distinct VMs.");
  if (!labelPattern.test(label) || generic.has(label.toLowerCase()))
    throw new Error("A dedicated custom pool label is required.");
  const ids = new Set(),
    names = new Set();
  for (const member of pool) {
    if (
      !member ||
      !/^m_[a-z0-9]{26}$/.test(member.machine_id) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(member.runner_name) ||
      !member.expected_name
    )
      throw new Error("Invalid pool manifest.");
    if (
      ids.has(member.machine_id) ||
      names.has(member.runner_name.toLowerCase())
    )
      throw new Error("Use distinct VMs and one runner per VM.");
    ids.add(member.machine_id);
    names.add(member.runner_name.toLowerCase());
    const vm = machines.find((m) => m.id === member.machine_id);
    if (!vm || vm.name !== member.expected_name)
      throw new Error(
        "A reviewed VM is missing or renamed in the signed-in account.",
      );
    const matching = runners.filter((r) => r.name === member.runner_name);
    if (
      matching.length !== 1 ||
      !matching[0].labels.some(
        (l) => l.name.toLowerCase() === label.toLowerCase(),
      )
    )
      throw new Error(
        `Runner ${member.runner_name} is missing or no longer has the pool label.`,
      );
  }
  const labelled = runners.filter((r) =>
    r.labels.some((l) => l.name.toLowerCase() === label.toLowerCase()),
  );
  if (
    labelled.length !== pool.length ||
    labelled.some((r) => !names.has(r.name.toLowerCase()))
  )
    throw new Error(
      "Pool label also matches unmanaged runners. Choose a dedicated label.",
    );
  return pool;
}
export function quotaPlan(usage, machines, count) {
  const max = usage?.limits?.maxMachines;
  if (!Number.isInteger(max))
    throw new Error("Provider quota unavailable; cannot safely create VMs.");
  if (!Number.isInteger(count) || count < 1 || count > 5)
    throw new Error("Count must be a whole number from one to five.");
  const free = Math.max(0, max - machines.length);
  if (count > free)
    throw new Error(
      `Account has ${machines.length}/${max} VMs; only ${free} slots available. Paused/stopped VMs count. Existing VMs will not be deleted.`,
    );
  return {
    used: machines.length,
    max,
    free,
    count,
    spec: usage.limits.machineSpec,
  };
}
const shell = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
export async function installScript(pkg, repo, name, label, token) {
  if (
    !/^actions-runner-linux-x64-(\d+\.\d+\.\d+)\.tar\.gz$/.test(pkg.filename) ||
    !/^[a-f0-9]{64}$/i.test(pkg.sha256_checksum)
  )
    throw new Error(
      "Official runner package/checksum unavailable. Nothing installed.",
    );
  if (!safeName.test(name) || !labelPattern.test(label))
    throw new Error("Invalid runner name or label.");
  const version = pkg.filename.match(/x64-(.+)\.tar/)[1];
  protect(token);
  const values = {
    OR_VERSION: version,
    OR_SHA256: `linux-x64=${pkg.sha256_checksum}`,
    OR_URL: `https://github.com/${store.validateRepo(repo)}`,
    OR_TOKEN: token,
    OR_NAMES: name,
    OR_LABELS: label,
    OR_GROUP: "",
    OR_SERVICE: "1",
    OR_BASE: "",
  };
  return (
    Object.entries(values)
      .map(([k, v]) => `${k}=${shell(v)}`)
      .join("\n") +
    "\n" +
    (await readFile(new URL("../vendor/install.sh", import.meta.url), "utf8"))
  );
}
export class App {
  constructor({
    provider = new Provider(),
    github = new GitHub(),
    storage = store,
    emit = () => {},
  } = {}) {
    this.provider = provider;
    this.github = github;
    this.storage = storage;
    this.emit = emit;
  }
  async context(
    repo,
    { authenticate = false, allowAccountMismatch = false, ...options } = {},
  ) {
    repo = await this.github.repo(repo);
    const identity = authenticate
      ? await this.provider.authenticate(options)
      : await this.provider.identity();
    if (authenticate) await this.github.authenticate();
    const project = await this.storage.readProject(repo);
    if (project && project.repo.toLowerCase() !== repo.toLowerCase())
      throw new Error("Saved project repository mismatch; no action sent.");
    if (
      project &&
      project.account.userId !== identity.userId &&
      !allowAccountMismatch
    )
      throw new Error(
        `Signed in to InstaBox as ${identity.login}; the saved pool belongs to ${project.account.login}. Run boxci init to review a fresh setup for this account, or sign in to the pool's account to use it. No VM action was sent.`,
      );
    return { repo, identity, project };
  }
  async plan(options = {}) {
    const {
      repo,
      identity,
      project: saved,
    } = await this.context(options.repo, {
      ...options,
      authenticate: true,
      allowAccountMismatch: true,
    });
    const fresh = !!saved && saved.account.userId !== identity.userId;
    const project = fresh ? null : saved;
    const namespace = fresh
      ? createHash("sha256")
          .update(`${repo.toLowerCase()}:${identity.userId}`)
          .digest("hex")
          .slice(0, 10)
      : null;
    const [machines, usage, runners, details] = await Promise.all([
      this.provider.list(),
      this.provider.usage(),
      this.github.runners(repo),
      this.github.api(`repos/${repo}`),
    ]);
    if (!details.permissions?.admin)
      throw new Error(
        "Repository admin access is needed to register runners and install the CI secret.",
      );
    const previous = project;
    let poolVariable =
      previous?.pool_variable ||
      (fresh ? `BOXCI_POOL_${namespace.toUpperCase()}` : "BOXCI_POOL");
    let importedVariable = await this.github.variable(repo, poolVariable);
    if (
      fresh &&
      (importedVariable !== null || poolVariable === saved.pool_variable)
    )
      throw new Error(
        `${poolVariable} already exists. Inspect this account's setup before retrying; no resources were changed.`,
      );
    if (!fresh && !previous?.pool_variable && importedVariable === null) {
      const legacyVariable = await this.github.variable(
        repo,
        "INSTABOX_CI_POOL",
      );
      if (legacyVariable !== null) {
        importedVariable = legacyVariable;
        poolVariable = "INSTABOX_CI_POOL";
      }
    }
    let pool = previous?.pool;
    if (!pool && importedVariable !== null) {
      pool = JSON.parse(importedVariable);
      if (!Array.isArray(pool) || !pool.length || pool.length > 5)
        throw new Error("Pool must have one to five distinct VMs.");
    }
    const incomplete =
      !!project && !["awaiting_merge", "merged"].includes(project.status);
    if (incomplete && !pool?.length) pool = null;
    let inferredLabel;
    if (pool && !previous?.label && !options.label) {
      const mapped = runners.filter((r) =>
        pool.some((m) => m.runner_name === r.name),
      );
      const candidates = (mapped[0]?.labels || [])
        .map((l) => l.name)
        .filter(
          (name) =>
            !generic.has(name.toLowerCase()) &&
            mapped.every((r) =>
              r.labels.some((l) => l.name.toLowerCase() === name.toLowerCase()),
            ),
        );
      if (candidates.length !== 1)
        throw new Error(
          "An existing pool has ambiguous custom labels. Choose its routing label with --label.",
        );
      inferredLabel = candidates[0];
    }
    const label =
      previous?.label ||
      options.label ||
      inferredLabel ||
      "boxci-" +
        (namespace ||
          createHash("sha256").update(repo).digest("hex").slice(0, 10));
    if (!labelPattern.test(label) || generic.has(label.toLowerCase()))
      throw new Error("A dedicated custom pool label is required.");
    if (pool && !incomplete) validatePool(pool, machines, runners, label);
    const count = options.count === undefined ? 1 : Number(options.count);
    const missing = incomplete
      ? Math.max(
          0,
          (project.target_count || count) -
            (project.pool?.length || 0) -
            (project.pending?.length || 0),
        )
      : count;
    const expectedPrefix =
      previous?.runner_prefix ||
      "boxci-" +
        (namespace ||
          createHash("sha256").update(repo).digest("hex").slice(0, 8));
    if (
      fresh &&
      (machines.some((m) => m.name.startsWith(expectedPrefix + "-")) ||
        label.toLowerCase() === saved.label?.toLowerCase() ||
        runners.some(
          (r) =>
            r.labels.some(
              (l) => l.name.toLowerCase() === label.toLowerCase(),
            ) ||
            r.name.toLowerCase().startsWith(expectedPrefix.toLowerCase() + "-"),
        ))
    )
      throw new Error(
        "Fresh setup requires unused runner names and a dedicated label. Existing registrations were preserved.",
      );
    const recorded = new Set(
      [...(project?.pool || []), ...(project?.pending || [])].map(
        (m) => m.machine_id,
      ),
    );
    const recoverable = incomplete
      ? machines.filter(
          (m) =>
            ownsVm(m.metadata, repo) &&
            m.name.startsWith(expectedPrefix + "-") &&
            !recorded.has(m.id),
        ).length
      : 0;
    const needed = Math.max(0, missing - recoverable);
    const quota =
      pool || needed === 0
        ? {
            used: machines.length,
            max: usage.limits?.maxMachines,
            free: Math.max(
              0,
              (usage.limits?.maxMachines || 0) - machines.length,
            ),
          }
        : quotaPlan(usage, machines, needed);
    let command = options.command || previous?.command,
      manager = previous?.manager || "npm",
      managerVersion = previous?.managerVersion;
    const base = previous?.base || details.default_branch;
    if (!previous) {
      const raw = await this.github.content(repo, "package.json", base);
      if (raw) {
        const pkg = JSON.parse(raw);
        if (pkg.packageManager?.startsWith("pnpm@")) {
          manager = "pnpm";
          managerVersion = pkg.packageManager.slice(5).split("+")[0];
        }
        if (!command && pkg.scripts?.test) {
          if (manager === "pnpm")
            command = "pnpm install --frozen-lockfile && pnpm test";
          else if (!pkg.packageManager || pkg.packageManager.startsWith("npm@"))
            command = "npm ci && npm test";
        }
      }
    }
    if (!previous && !command)
      throw new Error(
        'No unambiguous test command found. Re-run with --command "your install and test command".',
      );
    const secret =
      previous?.secret ||
      options.secret ||
      (fresh ? `BOXCI_API_KEY_${namespace.toUpperCase()}` : defaults.secret);
    if (!/^[A-Z][A-Z0-9_]{0,99}$/.test(secret))
      throw new Error("Invalid Actions secret name.");
    const secretExists = await this.github.hasSecret(repo, secret);
    if (fresh && (secretExists || secret === saved.secret))
      throw new Error(
        `${secret} belongs to an existing setup or already exists. Choose an unused --secret name for the current account.`,
      );
    if (secretExists && !previous && !options.secret)
      throw new Error(
        `${secret} already exists. Choose --secret ${secret} to explicitly reuse it, or choose a new name. Its account/contents cannot be read from GitHub.`,
      );
    const workflowPath =
      previous?.workflow_path ||
      (fresh ? `.github/workflows/boxci-${namespace}.yml` : defaults.workflow);
    if (
      fresh &&
      (workflowPath === saved.workflow_path ||
        (await this.github.content(repo, workflowPath, base)))
    )
      throw new Error(
        `${workflowPath} already belongs to a setup. Its workflow was preserved.`,
      );
    const result = {
      version: 1,
      repo,
      project_revision: saved ? store.projectRevision(saved) : null,
      account: identity,
      ...(previous?.runner_prefix
        ? { runner_prefix: previous.runner_prefix }
        : {}),
      ...(fresh
        ? {
            previous_project: {
              account: saved.account,
              revision: store.projectRevision(saved),
              archive_path: this.storage.archiveFileFor(saved),
            },
            runner_prefix: expectedPrefix,
          }
        : previous?.previous_project
          ? {
              previous_project: previous.previous_project,
              runner_prefix: previous.runner_prefix,
            }
          : {}),
      managed_workflow: previous ? (previous.managed_workflow ?? false) : true,
      pool_variable: poolVariable,
      target_count: project?.target_count || pool?.length || count,
      adopt_only: !!previous && !incomplete,
      incomplete,
      github_login: (await this.github.api("user")).login,
      base,
      label,
      secret,
      secretExists,
      pool: pool || [],
      count: pool ? 0 : count,
      quota,
      command,
      manager,
      managerVersion,
      workflow_path: workflowPath,
      branch: previous?.branch,
      pr_number: previous?.pr_number,
      pr_url: previous?.pr_url,
      key_id: previous?.key_id,
      key_expires_at: previous?.key_expires_at,
      status: previous?.status || "planned",
      source: incomplete ? "resume" : pool ? "existing-pool" : "new-pool",
      actions: incomplete
        ? [
            "Resume the saved setup checkpoints. Existing runners and VMs are not replaced.",
          ]
        : pool && previous
          ? [
              "Adopt the verified existing pool; preserve its runner names, services and CI workflow.",
            ]
          : [
              ...(pool
                ? ["Reuse the verified existing VM/runner pool."]
                : [
                    "Create dedicated VMs with secret delivery disabled.",
                    "Install one checksum-verified GitHub systemd runner per VM.",
                  ]),
              secretExists
                ? "Reuse the selected Actions secret."
                : "Create a 30-day machine read/write key and transfer it directly to the repository secret. This key can execute commands on all VMs in this account.",
              "Open a workflow PR. No automatic merge.",
            ],
    };
    if (fresh)
      result.actions.unshift(
        `The saved pool belongs to InstaBox ${saved.account.login}. Set up a fresh pool as ${identity.login}.`,
        `Preserve the previous project record at ${result.previous_project.archive_path}. Existing VMs, runners, credentials, variables and workflows stay in place.`,
        `Use separate Actions variable ${poolVariable}, secret ${secret} and workflow ${workflowPath}. Review both workflows to avoid duplicate CI.`,
      );
    return result;
  }
  async init(options = {}, approve = async () => false) {
    const plan = await this.plan(options);
    this.emit({ type: "plan", plan });
    if (options.dryRun) return plan;
    if (!options.yes && !(await approve(plan)))
      throw new Error(
        "Setup cancelled. No VMs, runners, keys or workflow changes were made.",
      );
    return this.storage.locked(plan.repo, async () => {
      if ((await this.provider.identity()).userId !== plan.account.userId)
        throw new Error("InstaBox account changed after review.");
      if ((await this.github.api("user")).login !== plan.github_login)
        throw new Error("GitHub account changed after review.");
      const current = await this.storage.readProject(plan.repo);
      if (
        (current ? store.projectRevision(current) : null) !==
        plan.project_revision
      )
        throw new Error(
          "Saved project changed after review. Run boxci init again; no setup changes were made.",
        );
      const { project_revision, ...setup } = plan;
      if (plan.adopt_only) {
        await this.storage.saveProject(setup);
        this.emit({ type: "adopted", project: setup });
        return setup;
      }
      const fresh = current && current.account.userId !== plan.account.userId;
      if (fresh) {
        await this.checkFreshResources(plan);
        await this.storage.archiveProject(current);
      }
      const state = (fresh ? null : current) || {
        ...setup,
        pool: plan.pool,
        pending: [],
      };
      await this.storage.saveProject(state);
      await this.provision(state, state.target_count || plan.count);
      if (state.managed_workflow === false) {
        await this.variable(state);
        state.status = "awaiting_merge";
        await this.storage.saveProject(state);
      } else await this.configure(state);
      return state;
    });
  }
  async checkFreshResources(plan) {
    const [runners, variable, secretExists, source, machines] =
      await Promise.all([
        this.github.runners(plan.repo),
        this.github.variable(plan.repo, plan.pool_variable),
        this.github.hasSecret(plan.repo, plan.secret),
        this.github.content(plan.repo, plan.workflow_path, plan.base),
        this.provider.list(),
      ]);
    if (
      variable !== null ||
      secretExists ||
      source ||
      machines.some((m) => m.name.startsWith(plan.runner_prefix + "-")) ||
      runners.some(
        (r) =>
          r.labels.some(
            (l) => l.name.toLowerCase() === plan.label.toLowerCase(),
          ) ||
          r.name
            .toLowerCase()
            .startsWith(plan.runner_prefix.toLowerCase() + "-"),
      )
    )
      throw new Error(
        "Fresh setup resources changed after review. Run boxci init again; existing resources were preserved.",
      );
  }
  async package(repo) {
    const downloads = await this.github.api(
      `repos/${repo}/actions/runners/downloads`,
    );
    const pkg = downloads.find(
      (p) => p.os === "linux" && p.architecture === "x64",
    );
    if (!pkg)
      throw new Error(
        "GitHub offers no Linux X64 runner package for this repository.",
      );
    if (!pkg.sha256_checksum) {
      const version = pkg.filename.match(/x64-(\d+\.\d+\.\d+)\.tar\.gz$/)?.[1];
      if (!version) throw new Error("Unexpected runner package filename.");
      const release = await this.github.api(
        `repos/actions/runner/releases/tags/v${version}`,
      );
      pkg.sha256_checksum = release.body
        .split("\n")
        .find((l) => l.includes(pkg.filename))
        ?.match(/\b[a-f0-9]{64}\b/i)?.[0];
    }
    return pkg;
  }
  async provision(state, count) {
    const prefix =
      state.runner_prefix ||
      "boxci-" +
        createHash("sha256").update(state.repo).digest("hex").slice(0, 8);
    const target = count;
    const machines = await this.provider.list();
    const missing = Math.max(
      0,
      target - state.pool.length - (state.pending?.length || 0),
    );
    const recorded = new Set(
      [...state.pool, ...(state.pending || [])].map((m) => m.machine_id),
    );
    const recoverable = machines.filter(
      (m) =>
        ownsVm(m.metadata, state.repo) &&
        m.name.startsWith(prefix + "-") &&
        !recorded.has(m.id),
    ).length;
    if (missing > recoverable)
      quotaPlan(await this.provider.usage(), machines, missing - recoverable);
    while (state.pool.length < target) {
      const number = state.pool.length + 1;
      const name = `${prefix}-${String(number).padStart(2, "0")}`;
      let pending = state.pending?.find((p) => p.runner_name === name);
      await this.guard(state);
      if (!pending) {
        let vm = (await this.provider.list()).find((m) => m.name === name);
        if (vm && !ownsVm(vm.metadata, state.repo))
          throw new Error(
            `A VM named ${name} already exists outside this project. It was not adopted or replaced.`,
          );
        if (!vm) {
          this.emit({ type: "step", message: `Creating ${name}…` });
          vm = await this.provider.create(name, state.repo);
        }
        pending = {
          machine_id: vm.id,
          runner_name: name,
          expected_name: vm.name,
        };
        state.pending = [...(state.pending || []), pending];
        await this.storage.saveProject(state);
      }
      const reviewed = await this.provider.get(pending.machine_id);
      if (reviewed.name !== pending.expected_name)
        throw new Error(
          "Pending VM was renamed; inspect it before resuming setup.",
        );
      this.emit({ type: "step", message: `Installing runner ${name}…` });
      const remote = await this.github.runners(state.repo);
      const existing = remote.find((r) => r.name === name);
      if (existing) {
        if (!existing.labels.some((l) => l.name === state.label))
          throw new Error(
            "Pending runner labels changed. Inspect before retrying.",
          );
        await this.provider.execScript(
          pending.machine_id,
          runnerAdoptVerifyScript(name, state.repo, shell),
        );
        state.pool.push(pending);
        state.pending = state.pending.filter((p) => p.runner_name !== name);
        await this.storage.saveProject(state);
        continue;
      }
      const pkg = await this.package(state.repo);
      const token = protect(
        (
          await this.github.api(
            `repos/${state.repo}/actions/runners/registration-token`,
            { method: "POST" },
          )
        ).token,
      );
      await this.provider.execScript(
        pending.machine_id,
        await installScript(pkg, state.repo, name, state.label, token),
      );
      state.pool.push(pending);
      state.pending = state.pending.filter((p) => p.runner_name !== name);
      await this.storage.saveProject(state);
    }
  }
  async guard(state) {
    if ((await this.provider.identity()).userId !== state.account.userId)
      throw new Error("InstaBox account changed. No VM action sent.");
    if ((await this.github.api("user")).login !== state.github_login)
      throw new Error("GitHub account changed.");
  }
  async variable(state) {
    const name = state.pool_variable || "BOXCI_POOL";
    const existing = await this.github.variable(state.repo, name);
    await this.github.api(
      `repos/${state.repo}/actions/variables${existing === null ? "" : "/" + name}`,
      {
        method: existing === null ? "POST" : "PATCH",
        body: { name, value: JSON.stringify(state.pool) },
      },
    );
  }
  async configure(state) {
    await this.guard(state);
    if (!state.command) throw new Error("Test command missing.");
    const source = await workflow(state);
    const repo = state.repo;
    if (!state.branch) {
      if (await this.github.content(repo, state.workflow_path, state.base))
        throw new Error(
          `${state.workflow_path} already exists. It was not overwritten.`,
        );
      state.branch = "codex/boxci-" + randomUUID().slice(0, 8);
      await this.storage.saveProject(state);
    }
    try {
      await this.github.api(`repos/${repo}/git/ref/heads/${state.branch}`);
    } catch (e) {
      if (!/404/.test(e.message)) throw e;
      const base = await this.github.api(
        `repos/${repo}/git/ref/heads/${state.base}`,
      );
      await this.github.api(`repos/${repo}/git/refs`, {
        method: "POST",
        body: { ref: "refs/heads/" + state.branch, sha: base.object.sha },
      });
    }
    const existing = await this.github.content(
      repo,
      state.workflow_path,
      state.branch,
    );
    if (existing && existing !== source)
      throw new Error(
        "Workflow branch contains a different file. Review it before retrying.",
      );
    if (!existing)
      await this.github.api(`repos/${repo}/contents/${state.workflow_path}`, {
        method: "PUT",
        body: {
          branch: state.branch,
          message: "ci: add InstaBox on-demand runner pool",
          content: Buffer.from(source).toString("base64"),
        },
      });
    if (state.status !== "credential_pending")
      state.status = "workflow_uploaded";
    await this.storage.saveProject(state);
    await this.variable(state);
    if (!(await this.github.hasSecret(repo, state.secret))) {
      if (state.key_id && state.status === "credential_pending") {
        await this.provider.cli(["keys", "rm", state.key_id]);
        state.key_id = null;
        state.key_expires_at = null;
        await this.storage.saveProject(state);
      }
      const key = await this.provider.createKey(
        "boxci-" + randomUUID().slice(0, 8),
      );
      const values = [];
      const find = (v) => {
        if (typeof v === "string" && v.startsWith("ibk_")) values.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(find);
      };
      find(key);
      values.forEach(protect);
      if (values.length !== 1)
        throw new Error(
          "Provider returned an unexpected credential response; inspect instabox keys ls.",
        );
      const meta = key.key || key;
      if (
        !/^key_[A-Za-z0-9_]+$/.test(meta.id || "") ||
        !Number.isFinite(Date.parse(meta.expiresAt))
      )
        throw new Error(
          "Provider key metadata missing or invalid; inspect instabox keys ls. No secret was transferred.",
        );
      state.key_id = meta.id;
      state.key_expires_at = meta.expiresAt;
      state.status = "credential_pending";
      await this.storage.saveProject(state);
      if (this.provider.validateKey)
        await this.provider.validateKey(
          values[0],
          state.account.userId,
          state.pool[0].machine_id,
        );
      await this.github.secret(repo, state.secret, values[0]);
    }
    state.status = "credential_installed";
    await this.storage.saveProject(state);
    const matches = await this.github.api(
      `repos/${repo}/pulls?state=all&head=${repo.split("/")[0]}:${state.branch}`,
    );
    const pr =
      matches[0] ||
      (await this.github.api(`repos/${repo}/pulls`, {
        method: "POST",
        body: {
          head: state.branch,
          base: state.base,
          title: "ci: run GitHub Actions on InstaBox",
          body: "Adds the reviewed BoxCI workflow with bounded pool wake and hosted fallback. The wake job never checks out PR code. Normal idle pause stays enabled. Review the inferred build command and merge through normal repository controls. This PR can run CI when opened.",
        },
      }));
    state.pr_number = pr.number;
    state.pr_url = pr.html_url;
    state.status = "awaiting_merge";
    await this.storage.saveProject(state);
    this.emit({ type: "complete", project: state });
  }
  async add(options = {}, approve = async () => false) {
    const { project, identity } = await this.context(options.repo, {
      authenticate: true,
    });
    if (!project) throw new Error("Run boxci init first.");
    const count = Number(options.count || 1);
    const [machines, usage, runners] = await Promise.all([
      this.provider.list(),
      this.provider.usage(),
      this.github.runners(project.repo),
    ]);
    validatePool(project.pool, machines, runners, project.label);
    const quota = quotaPlan(usage, machines, count);
    if (project.pool.length + count > 5)
      throw new Error("A pool supports at most five VMs.");
    const plan = {
      ...project,
      count,
      quota,
      actions: [
        `Add ${count} dedicated VM(s) and service runners.`,
        `Update the existing manifest and reviewed workflow branch ${project.branch || ""}.`,
      ],
    };
    this.emit({ type: "plan", plan });
    if (options.dryRun) return plan;
    if (!options.yes && !(await approve(plan))) throw new Error("Cancelled.");
    return this.storage.locked(project.repo, async () => {
      if ((await this.provider.identity()).userId !== identity.userId)
        throw new Error("Account changed.");
      project.target_count = project.pool.length + count;
      project.status = "adding";
      await this.storage.saveProject(project);
      await this.provision(project, project.target_count);
      await this.variable(project);
      project.status = "awaiting_merge";
      await this.storage.saveProject(project);
      return project;
    });
  }
  async status(options = {}) {
    const { repo, identity, project } = await this.context(options.repo);
    if (!project)
      throw new Error(
        "No pool configured. Run boxci init in this repository first.",
      );
    const [machines, runners, usage] = await Promise.all([
      this.provider.list(),
      this.github.runners(repo),
      this.provider.usage(),
    ]);
    validatePool(project.pool, machines, runners, project.label);
    let runs = [],
      jobs = [],
      historyError = null;
    let pr = null;
    if (project.pr_number) {
      try {
        const result = await this.github.api(
          `repos/${repo}/pulls/${project.pr_number}`,
        );
        pr = {
          url: result.html_url,
          state: result.state,
          merged: result.merged,
          draft: result.draft,
        };
      } catch (e) {
        historyError = redact(e.message);
      }
    }
    try {
      runs = await this.github.recent(
        repo,
        project.workflow_path,
        pr && !pr.merged ? project.branch : undefined,
      );
      for (const r of runs.slice(0, 3)) {
        const data = await this.github.api(
          `repos/${repo}/actions/runs/${r.id}/jobs?per_page=100`,
        );
        jobs.push(...data.jobs.map((j) => ({ ...j, run_url: r.html_url })));
      }
    } catch (e) {
      historyError = redact(e.message);
    }
    return {
      repo,
      account: identity,
      label: project.label,
      workflow_path: project.workflow_path,
      checked_at: new Date().toISOString(),
      quota: { used: machines.length, max: usage.limits?.maxMachines },
      members: project.pool.map((p) => ({
        name: p.runner_name,
        machine_id: p.machine_id,
        vm: machines.find((m) => m.id === p.machine_id),
        runner: runners.find((r) => r.name === p.runner_name),
      })),
      jobs,
      runs,
      pr,
      key_expires_at: project.key_expires_at || null,
      history_error: historyError,
    };
  }
  async renew(options = {}, approve = async () => false) {
    const { project } = await this.context(options.repo, {
      authenticate: true,
    });
    if (!project) throw new Error("Run boxci init first.");
    const [machines, usage] = await Promise.all([
      this.provider.list(),
      this.provider.usage(),
    ]);
    const plan = {
      ...project,
      quota: { used: machines.length, max: usage.limits?.maxMachines },
      actions: [
        `Replace ${project.secret} with a validated 30-day machine read/write key in this same account. It can execute commands on ALL account VMs.`,
        "Retire recorded previous keys only after the new credential is installed. Existing runners and workflows remain in place.",
      ],
    };
    this.emit({ type: "plan", plan });
    if (options.dryRun) return plan;
    if (!options.yes && !(await approve(plan))) throw new Error("Cancelled.");
    return this.storage.locked(project.repo, async () => {
      await this.guard(project);
      const result = await this.provider.createKey(
        "boxci-" + randomUUID().slice(0, 8),
      );
      const values = [];
      const visit = (v) => {
        if (typeof v === "string" && v.startsWith("ibk_")) values.push(v);
        else if (v && typeof v === "object") Object.values(v).forEach(visit);
      };
      visit(result);
      values.forEach(protect);
      if (values.length !== 1)
        throw new Error(
          "Unexpected credential response; inspect instabox keys ls.",
        );
      const meta = result.key || result;
      if (!meta.id || !meta.expiresAt)
        throw new Error(
          "Credential metadata missing; inspect instabox keys ls.",
        );
      project.pending_keys = [
        ...(project.pending_keys || []),
        { id: meta.id, expiresAt: meta.expiresAt },
      ];
      await this.storage.saveProject(project);
      if (this.provider.validateKey)
        await this.provider.validateKey(
          values[0],
          project.account.userId,
          project.pool[0].machine_id,
        );
      await this.github.secret(project.repo, project.secret, values[0]);
      const oldIds = [
        project.key_id,
        ...project.pending_keys.map((k) => k.id),
      ].filter((id) => id && id !== meta.id);
      project.key_id = meta.id;
      project.key_expires_at = meta.expiresAt;
      project.pending_keys = [];
      project.keys_to_retire = [
        ...new Set([...(project.keys_to_retire || []), ...oldIds]),
      ];
      await this.storage.saveProject(project);
      for (const id of [...project.keys_to_retire]) {
        if (!/^key_[A-Za-z0-9_]+$/.test(id))
          throw new Error(
            "Recorded previous key ID invalid; inspect provider keys.",
          );
        await this.provider.cli(["keys", "rm", id]);
        project.keys_to_retire = project.keys_to_retire.filter((k) => k !== id);
        await this.storage.saveProject(project);
      }
      return project;
    });
  }
  async doctor(options = {}) {
    const context = await this.context(options.repo);
    if (
      context.project &&
      !["awaiting_merge", "merged"].includes(context.project.status)
    )
      return {
        repo: context.repo,
        ready: false,
        checks: [
          {
            name: "Setup checkpoint",
            ok: false,
            detail:
              context.project.status +
              "; rerun boxci init to review and resume. Existing resources will not be replaced.",
          },
        ],
      };
    const state = await this.status(options);
    const checks = [
      { name: "Provider account", ok: true, detail: state.account.login },
      {
        name: "Pool mapping",
        ok: true,
        detail: `${state.members.length} distinct VMs with a dedicated label`,
      },
      {
        name: "Account quota",
        ok: state.quota.used <= state.quota.max,
        detail: `${state.quota.used}/${state.quota.max}; paused and stopped VMs count`,
      },
      {
        name: "Idle pause",
        ok: state.members.every((m) => m.vm.autoSuspendAfterSeconds > 0),
        detail: "Read from provider state; no guest commands run",
      },
      {
        name: "Workflow merge",
        ok: state.pr?.merged === true,
        detail: state.pr?.merged
          ? "Merged"
          : state.pr?.draft
            ? "Draft PR awaits review and merge"
            : "Workflow PR awaits merge",
      },
      {
        name: "Credential expiry",
        ok:
          !!state.key_expires_at &&
          Date.parse(state.key_expires_at) > Date.now() + 7 * 86400000,
        detail:
          state.key_expires_at ||
          "Managed externally; expiry cannot be read from GitHub secrets",
      },
    ];
    return { repo: state.repo, checks, ready: checks.every((c) => c.ok) };
  }
  async wake(options = {}) {
    const { project } = await this.context(options.repo);
    if (!project) throw new Error("Run boxci init first.");
    validatePool(
      project.pool,
      await this.provider.list(),
      await this.github.runners(project.repo),
      project.label,
    );
    await Promise.all(
      project.pool.map((m) => this.provider.wake(m.machine_id)),
    );
    return this.status(options);
  }
  async ciRun(options = {}) {
    const { project } = await this.context(options.repo);
    if (!project) throw new Error("Run boxci init first.");
    let ref = options.ref;
    if (!ref) {
      const pr = project.pr_number
        ? await this.github.api(
            `repos/${project.repo}/pulls/${project.pr_number}`,
          )
        : null;
      if (pr && !pr.merged)
        throw new Error(
          `Merge ${project.pr_url} first, or explicitly test --ref ${project.branch}.`,
        );
      ref = project.base;
    }
    await this.github.api(
      `repos/${project.repo}/actions/workflows/${project.workflow_path.split("/").at(-1)}/dispatches`,
      { method: "POST", body: { ref } },
    );
    return {
      repo: project.repo,
      ref,
      message:
        "CI dispatch requested. Use boxci status to observe the actual result.",
    };
  }
  async migrate(options = {}, approve = async () => false) {
    const { repo, project } = await this.context(options.repo);
    if (!project?.pool?.length)
      throw new Error(
        "No BoxCI pool for this repository. Run boxci init here first.",
      );
    if (!project.label)
      throw new Error("Project record is missing a routing label.");

    const files = await scanWorkflows(options.root || gitRoot());
    const candidates = files.flatMap((f) => f.jobs);
    if (!candidates.length)
      throw new Error(
        "No migratable jobs found under .github/workflows (static runs-on only).",
      );

    let selectedJobs = options.selectedJobs;
    if (!selectedJobs && !options.jobs && !options.match) {
      if (!process.stdin.isTTY && !options.yes)
        throw new Error(
          "Use --match, --jobs, or --yes with --dry-run after reviewing a plan.",
        );
      if (process.stdin.isTTY && !options.yes) {
        const { createInterface } = await import("node:readline/promises");
        const rl = createInterface({
          input: process.stdin,
          output: process.stderr,
        });
        try {
          selectedJobs = await promptJobSelection(candidates, () =>
            rl.question("> "),
          );
        } finally {
          rl.close();
        }
      } else if (options.yes) {
        selectedJobs = candidates;
      }
    }

    const plan = await buildMigratePlan(project, {
      ...options,
      selectedJobs,
    });
    if (!plan.edits.length)
      throw new Error("No jobs selected; no workflow files changed.");

    this.emit({
      type: "migrate-plan",
      plan,
    });
    if (options.dryRun) return plan;
    if (!options.yes && !(await approve(plan)))
      throw new Error("Migration cancelled; workflow files unchanged.");

    await applyMigratePlan(plan);
    return {
      ...plan,
      message: `Updated ${plan.edits.length} workflow file(s). Review git diff, commit, and push.`,
    };
  }
}
