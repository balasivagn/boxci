import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { version } from "../src/version.js";

const cli = fileURLToPath(new URL("../bin/boxci.js", import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
test("installed version is available without a Git checkout, sign-in or external CLI", () => {
  for (const flag of ["--version", "-v", "version"]) {
    const result = run(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
    assert.equal(result.stderr, "");
  }
});
test("JSON version output is parseable and plain", () => {
  const result = run("--version", "--json");
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { version });
  assert.doesNotMatch(result.stdout, /\x1b/);
});
test("help shows version and application-checkout guidance before any setup", () => {
  const result = run("--help");
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`v${version}`));
  assert.match(result.stdout, /application\s+checkout/);
});
