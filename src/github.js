import { execFileSync } from "node:child_process";
import { requireInteractive } from "./process.js";
import { runGh } from "./tooling.js";
import { validateRepo } from "./store.js";
// Same accepted forms as Workspace.root, plus the https://user[:token]@ userinfo
// that insteadOf rewrites can add. The host must be exactly github.com. Callers
// must never echo the URL, because it can carry a credential.
const GITHUB_REMOTE =
  /^(?:https:\/\/(?:[^\s/\\?#@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i;
export function repoFromRemote(url) {
  const repo = String(url ?? "")
    .trim()
    .match(GITHUB_REMOTE)?.[1];
  if (!repo) return null;
  try {
    return validateRepo(repo);
  } catch {
    return null;
  }
}
const readGit = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
export class GitHub {
  constructor({
    exec = runGh,
    interactive = process.stdin.isTTY,
    git = readGit,
    cwd = process.cwd(),
  } = {}) {
    this.interactive = interactive;
    this.git = git;
    this.cwd = cwd;
    this.workflowConsentRequested = false;
    this.exec = exec;
  }
  async api(path, { method = "GET", body } = {}) {
    let raw;
    const invoke = () =>
      this.exec(
        "gh",
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          method,
          path,
          ...(body === undefined ? [] : ["--input", "-"]),
        ],
        { input: body === undefined ? undefined : JSON.stringify(body) },
      );
    try {
      raw = await invoke();
    } catch (error) {
      if (
        method !== "GET" &&
        path.includes("/contents/.github/workflows/") &&
        /workflow/i.test(error.message) &&
        this.interactive &&
        !this.workflowConsentRequested
      ) {
        this.workflowConsentRequested = true;
        await this.exec(
          "gh",
          [
            "auth",
            "refresh",
            "--hostname",
            "github.com",
            "--scopes",
            "workflow",
          ],
          { interactive: true, timeout: 300000 },
        );
        raw = await invoke();
      } else throw error;
    }
    return raw.trim() ? JSON.parse(raw) : null;
  }
  async authenticate() {
    try {
      return await this.api("user");
    } catch (e) {
      if (e.code === "ENOENT")
        throw new Error(
          "GitHub CLI is required. Install gh: https://cli.github.com/ then run boxci init again.",
        );
      if (!/auth|login|token|401|not logged|credential/i.test(e.message))
        throw e;
      requireInteractive();
      await this.exec(
        "gh",
        [
          "auth",
          "login",
          "--hostname",
          "github.com",
          "--web",
          "--git-protocol",
          "https",
        ],
        { interactive: true, timeout: 300000 },
      );
      return this.api("user");
    }
  }
  async repo(input) {
    if (input) return validateRepo(input);
    try {
      return validateRepo(
        (
          await this.exec("gh", [
            "repo",
            "view",
            "--json",
            "nameWithOwner",
            "--jq",
            ".nameWithOwner",
          ])
        ).trim(),
      );
    } catch {
      // gh may be signed out or missing; the checkout's remote still names it.
      return this.repoFromGitRemote();
    }
  }
  repoFromGitRemote() {
    let remotes;
    try {
      remotes = this.git(["remote", "-v"], this.cwd);
    } catch {
      throw new Error(
        "Run inside a Git checkout, or pass --repo owner/repository.",
      );
    }
    // Remote name -> distinct repositories (case-insensitive) it points at.
    const byRemote = new Map();
    for (const line of String(remotes).split("\n")) {
      const [name, url] = line.split(/\s+/);
      const repo = repoFromRemote(url);
      if (!name || !repo) continue;
      if (!byRemote.has(name)) byRemote.set(name, new Map());
      byRemote.get(name).set(repo.toLowerCase(), repo);
    }
    const distinct =
      byRemote.get("origin") ??
      new Map([...byRemote.values()].flatMap((repos) => [...repos]));
    if (distinct.size === 1) return [...distinct.values()][0];
    throw new Error(
      distinct.size
        ? "This checkout has several GitHub remotes. Pass --repo owner/repository."
        : "No GitHub remote found in this checkout, and GitHub CLI could not identify the repository. Pass --repo owner/repository, or run gh auth login.",
    );
  }
  async runners(repo) {
    let out = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.api(
        `repos/${repo}/actions/runners?per_page=100&page=${page}`,
      );
      out.push(...data.runners);
      if (data.runners.length < 100) return out;
    }
    throw new Error("Too many runners to safely resolve the pool.");
  }
  async variable(repo, name) {
    try {
      const result = await this.api(`repos/${repo}/actions/variables/${name}`);
      return result.value;
    } catch (e) {
      if (/404/.test(e.message)) return null;
      throw e;
    }
  }
  async hasSecret(repo, name) {
    try {
      await this.api(`repos/${repo}/actions/secrets/${name}`);
      return true;
    } catch (e) {
      if (/404/.test(e.message)) return false;
      throw e;
    }
  }
  async secret(repo, name, value) {
    await this.exec("gh", ["secret", "set", name, "--repo", repo], {
      input: value,
    });
  }
  async content(repo, path, ref) {
    try {
      const result = await this.api(
        `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
      );
      return Buffer.from(result.content, "base64").toString();
    } catch (e) {
      if (/404/.test(e.message)) return null;
      throw e;
    }
  }
  async recent(repo, workflow, branch) {
    const path = workflow
      ? `actions/workflows/${workflow.split("/").at(-1)}/runs`
      : "actions/runs";
    return (
      await this.api(
        `repos/${repo}/${path}?per_page=5${branch ? "&branch=" + encodeURIComponent(branch) : ""}`,
      )
    ).workflow_runs;
  }
  async consumerWorkflows(repo, ref) {
    let files;
    try {
      files = await this.api(
        `repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`,
      );
    } catch (error) {
      if (/404/.test(error.message)) return [];
      throw error;
    }
    if (!Array.isArray(files))
      throw new Error("GitHub did not return a workflow directory.");
    const matches = await Promise.all(
      files
        .filter(
          (file) =>
            file.type === "file" &&
            /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(file.path) &&
            file.path !== ".github/workflows/boxci-wake.yml",
        )
        .map(async (file) => {
          const source = await this.content(repo, file.path, ref);
          return /^\s+uses:\s*["']?\.\/\.github\/workflows\/boxci-wake\.yml["']?\s*(?:#.*)?$/m.test(
            source || "",
          )
            ? file.path
            : null;
        }),
    );
    return matches.filter(Boolean).sort();
  }
}
