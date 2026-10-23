import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class Workspace {
  constructor({ cwd = process.cwd() } = {}) {
    this.cwd = cwd;
  }
  async root(repo, cwd = this.cwd) {
    let root;
    try {
      root = await realpath(
        execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      );
    } catch {
      throw new Error(
        "Run init and migrate inside the target repository's Git checkout.",
      );
    }
    const remotes = execFileSync("git", ["remote", "-v"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const matches = remotes.split("\n").some((line) => {
      const url = line.split(/\s+/)[1] || "";
      const target = url.match(
        /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i,
      )?.[1];
      return target?.toLowerCase() === repo.toLowerCase();
    });
    if (!matches)
      throw new Error(
        `This checkout does not have a GitHub remote for ${repo}. Run from that repository's checkout; --repo does not change the local directory.`,
      );
    return root;
  }
  async content(root, relPath) {
    if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(relPath))
      throw new Error("Invalid local workflow path.");
    for (const path of [".github", ".github/workflows", relPath]) {
      try {
        const stat = await lstat(join(root, path));
        if (
          stat.isSymbolicLink() ||
          (path !== relPath && !stat.isDirectory()) ||
          (path === relPath && !stat.isFile())
        )
          throw new Error(
            "Workflow paths must be regular files and directories inside the checkout.",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    try {
      return await readFile(join(root, relPath), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async review(repo, relPath, source, { preserveExisting = false } = {}) {
    const root = await this.root(repo);
    const before = await this.content(root, relPath);
    if (before !== null && before !== source && !preserveExisting)
      throw new Error(
        `${relPath} already exists with different contents. It was not overwritten; review it before retrying.`,
      );
    return {
      root,
      repo,
      relPath,
      before,
      after: preserveExisting && before !== null ? before : source,
    };
  }
  async pending(edit) {
    await this.validate(edit);
    return !!execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored",
        "--",
        edit.relPath,
      ],
      {
        cwd: edit.root,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  }
  async validate(edit) {
    if ((await this.root(edit.repo, edit.root)) !== edit.root)
      throw new Error("Repository checkout changed after review.");
    if ((await this.content(edit.root, edit.relPath)) !== edit.before)
      throw new Error(
        `${edit.relPath} changed after review. No workflow was overwritten; run the command again.`,
      );
  }
  async apply(edit) {
    await this.validate(edit);
    if (edit.before === edit.after) return;
    await mkdir(join(edit.root, ".github", "workflows"), { recursive: true });
    await this.validate(edit);
    await writeFile(join(edit.root, edit.relPath), edit.after, {
      encoding: "utf8",
      flag: edit.before === null ? "wx" : "w",
    });
  }
}
