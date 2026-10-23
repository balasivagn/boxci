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
});
