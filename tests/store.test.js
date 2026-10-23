import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileFor,
  saveProject,
  readProject,
  locked,
  validateRepo,
  archiveFileFor,
  archiveProject,
} from "../src/store.js";
test("repository path components cannot collide or escape the project directory", () => {
  assert.notEqual(fileFor("a--b/c"), fileFor("a/b--c"));
  assert.throws(() => validateRepo("../outside"), /owner/);
  assert.throws(() => validateRepo("owner/repo/other"), /owner/);
});
test("account archives retain the complete previous record privately and never overwrite a conflicting archive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boxci-archive-"));
  const oldHome = process.env.BOXCI_HOME;
  process.env.BOXCI_HOME = dir;
  try {
    const old = {
      repo: "acme/project",
      account: { userId: -8, login: "old" },
      pool: [{ machine_id: "saved-vm" }],
      pending: [],
      status: "credential_pending",
      key_id: "key_metadata_only",
    };
    await saveProject(old);
    const path = await archiveProject(old);
    assert.equal(path, archiveFileFor(old));
    const bytes = await readFile(path, "utf8");
    assert.deepEqual(JSON.parse(bytes), old);
    await archiveProject(old);
    assert.equal(await readFile(path, "utf8"), bytes);
    await saveProject({
      ...old,
      account: { userId: 9, login: "new" },
      pool: [],
    });
    assert.equal((await readProject(old.repo)).account.userId, 9);
    assert.equal(await readFile(path, "utf8"), bytes);
    if (process.platform !== "win32")
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, '{"repo":"acme/project","changed":true}\n');
    await assert.rejects(archiveProject(old), /Archived project differs/);
    assert.equal(JSON.parse(await readFile(path, "utf8")).changed, true);
  } finally {
    if (oldHome === undefined) delete process.env.BOXCI_HOME;
    else process.env.BOXCI_HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
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
