import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../src/workspace.js";
import { buildMigratePlan, applyMigratePlan } from "../src/migrate.js";
import { legacyWakeJobYaml, reusableWakeWorkflow } from "../src/wake.js";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "boxci-checkout-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "--initial-branch=codex/test-fixture");
  git("remote", "add", "origin", "git@github.com:acme/project.git");
  return { root, git, workspace: new Workspace({ cwd: root }) };
}
const path = ".github/workflows/boxci.yml";

test("workflow review is read-only; apply creates only a local file and retry preserves custom edits", async (t) => {
  const { root, workspace, git } = await fixture(t);
  const edit = await workspace.review("acme/project", path, "name: BoxCI\n");
  await assert.rejects(readFile(join(root, path)), { code: "ENOENT" });
  await workspace.apply(edit);
  assert.equal(await readFile(join(root, path), "utf8"), edit.after);
  git("diff", "--exit-code", "--cached");
  await writeFile(join(root, path), "custom workflow\n");
  await assert.rejects(
    workspace.review("acme/project", path, "replacement"),
    /not overwritten/,
  );
  await workspace.apply(
    await workspace.review("acme/project", path, "replacement", {
      preserveExisting: true,
    }),
  );
  assert.equal(await readFile(join(root, path), "utf8"), "custom workflow\n");
});
test("wrong repositories, changed remotes and edits after review cannot write workflows", async (t) => {
  const { root, workspace, git } = await fixture(t);
  await assert.rejects(
    workspace.review("other/repo", path, "wrong"),
    /does not have a GitHub remote/,
  );
  const edit = await workspace.review("acme/project", path, "workflow");
  git("remote", "set-url", "origin", "https://github.com/other/repo.git");
  await assert.rejects(workspace.apply(edit), /does not have a GitHub remote/);
  git("remote", "set-url", "origin", "https://github.com/acme/project.git");
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await writeFile(join(root, path), "my edits");
  await assert.rejects(workspace.apply(edit), /changed after review/);
  assert.equal(await readFile(join(root, path), "utf8"), "my edits");
});
test("credentialed insteadOf rewrites still resolve the GitHub remote without exposing credentials", async (t) => {
  const { root, workspace, git } = await fixture(t);
  git(
    "config",
    "url.https://user:secret@github.com/.insteadOf",
    "git@github.com:",
  );
  const remotes = execFileSync("git", ["remote", "-v"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.match(
    remotes,
    /https:\/\/user:secret@github\.com\/acme\/project\.git/,
  );
  assert.equal(await workspace.root("acme/project"), root);
  await assert.rejects(workspace.root("other/repo"), (error) => {
    assert.match(error.message, /does not have a GitHub remote/);
    assert.doesNotMatch(error.message, /secret|user:/);
    return true;
  });
  git("config", "--unset", "url.https://user:secret@github.com/.insteadOf");
  for (const url of [
    "https://user@github.com/acme/project.git",
    "https://user:secret@github.com/acme/project.git",
    "https://user:secret@github.com/acme/project",
    "https://user@github.com/acme/project/",
  ]) {
    git("remote", "set-url", "origin", url);
    assert.equal(await workspace.root("acme/project"), root, url);
  }
});
test("credentialed remotes on other hosts or malformed URLs are rejected without exposing credentials", async (t) => {
  const { workspace, git } = await fixture(t);
  for (const url of [
    "https://user:secret@gitlab.com/acme/project.git",
    "https://user:secret@github.com.evil.com/acme/project.git",
    "https://github.com.evil.com/acme/project.git",
    "https://evil.com/github.com/acme/project.git",
    "https://user:secret@evil.com/github.com/acme/project.git",
    "https://user:secret@evil.com@github.com/acme/project.git",
    "https://evil.com#@github.com/acme/project.git",
    "https://evil.com?@github.com/acme/project.git",
    "https://evil.com\\@github.com/acme/project.git",
    "https://user:secret@github.com:8443/acme/project.git",
    "https://user:secret@github.com/acme/project/extra.git",
    "http://user:secret@github.com/acme/project.git",
  ]) {
    git("remote", "set-url", "origin", url);
    await assert.rejects(workspace.root("acme/project"), (error) => {
      assert.match(error.message, /does not have a GitHub remote/, url);
      assert.doesNotMatch(error.message, /secret|evil|user:/, url);
      return true;
    });
  }
});
test("workflow status distinguishes untracked, staged, committed and edited files without changing Git", async (t) => {
  const { root, workspace, git } = await fixture(t);
  await workspace.apply(
    await workspace.review("acme/project", path, "name: BoxCI\n"),
  );
  const review = () =>
    workspace.review("acme/project", path, "unused", {
      preserveExisting: true,
    });
  assert.equal(await workspace.pending(await review()), true);
  git("add", path);
  assert.equal(await workspace.pending(await review()), true);
  git(
    "-c",
    "user.name=BoxCI Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Add workflow",
  );
  assert.equal(await workspace.pending(await review()), false);
  await writeFile(join(root, "unrelated.txt"), "Unrelated local changes\n");
  assert.equal(await workspace.pending(await review()), false);
  await writeFile(join(root, path), "name: Customized BoxCI\n");
  assert.equal(await workspace.pending(await review()), true);
});
test("symlinked workflow directories and path traversal are refused", async (t) => {
  const { root, workspace } = await fixture(t);
  const other = join(root, "other");
  await mkdir(other);
  await symlink(other, join(root, ".github"), "dir");
  await assert.rejects(
    workspace.review("acme/project", path, "workflow"),
    /regular files and directories/,
  );
  await assert.rejects(
    workspace.content(root, "../outside.yml"),
    /Invalid local workflow path/,
  );
});
test("migration checks all reviewed contents before writing any file and leaves Git untouched", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  const source =
    "name: CI\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: npm test\n";
  const first = join(root, ".github/workflows/a.yml");
  const second = join(root, ".github/workflows/b.yml");
  await writeFile(first, source);
  await writeFile(second, source);
  const plan = await buildMigratePlan(
    { repo: "acme/project", label: "dedicated-pool" },
    { root },
  );
  await writeFile(second, "concurrent edit");
  await assert.rejects(applyMigratePlan(plan), /changed after review/);
  assert.equal(await readFile(first, "utf8"), source);
  await writeFile(second, source);
  await applyMigratePlan(plan);
  assert.match(await readFile(first, "utf8"), /fromJSON/);
  assert.match(await readFile(second, "utf8"), /fromJSON/);
  assert.doesNotMatch(
    await readFile(first, "utf8"),
    /python3|ThreadPoolExecutor/,
  );
  assert.equal(
    await readFile(join(root, ".github/workflows/boxci-wake.yml"), "utf8"),
    await reusableWakeWorkflow(),
  );
  assert.deepEqual(
    (
      await buildMigratePlan(
        { repo: "acme/project", label: "dedicated-pool" },
        { root },
      )
    ).edits,
    [],
  );
  await rm(join(root, ".github/workflows/boxci-wake.yml"));
  const repair = await buildMigratePlan(
    { repo: "acme/project", label: "dedicated-pool" },
    { root },
  );
  assert.deepEqual(
    repair.edits.map((edit) => edit.relPath),
    [".github/workflows/boxci-wake.yml"],
  );
  await applyMigratePlan(repair);
  assert.equal(
    await readFile(join(root, ".github/workflows/boxci-wake.yml"), "utf8"),
    await reusableWakeWorkflow(),
  );
});
test("migration extracts an already migrated inline job while preserving application steps and dependencies", async (t) => {
  const { root } = await fixture(t);
  const project = {
    repo: "acme/project",
    label: "dedicated-pool",
    secret: "CUSTOM_KEY",
    pool_variable: "CUSTOM_POOL",
  };
  const source =
    "name: App\non:\n  pull_request:\njobs:\n" +
    (await legacyWakeJobYaml(project)) +
    "\n  test:\n    needs: [install, boxci-wake]\n    runs-on: ${{ fromJSON(needs.boxci-wake.outputs.runner) }}\n    steps:\n      - run: my custom test command\n";
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  const target = join(root, ".github/workflows/ci.yml");
  await writeFile(target, source);
  const plan = await buildMigratePlan(project, { root });
  assert.equal(plan.jobs.length, 0);
  assert.equal(plan.edits.length, 2);
  assert.equal(await readFile(target, "utf8"), source);
  await applyMigratePlan(plan);
  const result = await readFile(target, "utf8");
  assert.ok(result.endsWith(source.slice(source.indexOf("  test:"))));
  assert.match(result, /uses: \.\/\.github\/workflows\/boxci-wake.yml/);
  assert.match(result, /vars.CUSTOM_POOL/);
  assert.match(result, /secrets.CUSTOM_KEY/);
  assert.doesNotMatch(result, /python3|ThreadPoolExecutor/);
});
test("migration refuses a conflicting helper before changing callers", async (t) => {
  const { root } = await fixture(t);
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  const target = join(root, ".github/workflows/ci.yml");
  const source =
    "jobs:\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo hello\n";
  await writeFile(target, source);
  await writeFile(
    join(root, ".github/workflows/boxci-wake.yml"),
    "my custom helper",
  );
  await assert.rejects(
    buildMigratePlan(
      { repo: "acme/project", label: "pool", secret: "KEY" },
      { root },
    ),
    /not overwritten/,
  );
  assert.equal(await readFile(target, "utf8"), source);
});
