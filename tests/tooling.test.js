import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyArchive, githubAsset, ensureGitHubCLI } from "../src/tooling.js";
test("official CLI archive must match its published SHA-256", () => {
  const bytes = Buffer.from("official fixture");
  const sum = createHash("sha256").update(bytes).digest("hex");
  verifyArchive(bytes, `${sum}  gh.zip`, "gh.zip");
  assert.throws(
    () => verifyArchive(Buffer.from("tampered"), `${sum}  gh.zip`, "gh.zip"),
    /checksum mismatch/,
  );
  assert.throws(
    () => verifyArchive(bytes, `${sum}  other.zip`, "gh.zip"),
    /checksum mismatch/,
  );
});
test("existing GitHub CLI never downloads a second copy", async () => {
  let fetches = 0;
  const path = await ensureGitHubCLI({
    exec: async () => "",
    fetcher: async () => {
      fetches++;
    },
  });
  assert.equal(path, "gh");
  assert.equal(fetches, 0);
});
test("release artifact is native for each supported platform", () => {
  assert.equal(
    githubAsset("2.103.0", "darwin", "arm64"),
    "gh_2.103.0_macOS_arm64.zip",
  );
  assert.equal(
    githubAsset("2.103.0", "linux", "x64"),
    "gh_2.103.0_linux_amd64.tar.gz",
  );
  assert.throws(() => githubAsset("2.103.0", "alien", "x64"), /Install/);
});
