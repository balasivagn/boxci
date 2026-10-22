import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileFor,
  saveProject,
  readProject,
  locked,
  validateRepo,
} from "../src/store.js";
test("repository path components cannot collide or escape the project directory", () => {
  assert.notEqual(fileFor("a--b/c"), fileFor("a/b--c"));
  assert.throws(() => validateRepo("../outside"), /owner/);
  assert.throws(() => validateRepo("owner/repo/other"), /owner/);
});
test("state is private/atomic and project lock is released on failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxci-store-"));
  const old = process.env.BOXCI_HOME;
  process.env.BOXCI_HOME = dir;
  try {
    const state = { repo: "acme/project", pool: [] };
    await saveProject(state);
    assert.deepEqual(await readProject(state.repo), state);
    if (process.platform !== "win32")
      assert.equal((await stat(fileFor(state.repo))).mode & 0o777, 0o600);
    await assert.rejects(
      locked(state.repo, async () => locked(state.repo, async () => {})),
      /Another setup/,
    );
    await locked(state.repo, async () => {});
  } finally {
    if (old === undefined) delete process.env.BOXCI_HOME;
    else process.env.BOXCI_HOME = old;
    await rm(dir, { recursive: true, force: true });
  }
});
