import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { isolateGitConfig } from "./helpers/git-config.js";

const keys = [
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
];
test("isolateGitConfig isolates once per test and restores the environment", async (t) => {
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  let global;
  await t.test("isolated", async (t) => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_PARAMETERS = "'core.fixture=1'";
    await isolateGitConfig(t);
    global = process.env.GIT_CONFIG_GLOBAL;
    await isolateGitConfig(t);
    assert.equal(process.env.GIT_CONFIG_GLOBAL, global, "isolated twice");
    assert.ok(existsSync(global), "temp global config missing");
    assert.equal(process.env.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(process.env.GIT_CONFIG_COUNT, undefined);
    assert.equal(process.env.GIT_CONFIG_PARAMETERS, undefined);
  });
  // The subtest set COUNT/PARAMETERS before isolating; those are restored too.
  assert.equal(process.env.GIT_CONFIG_COUNT, "1");
  assert.equal(process.env.GIT_CONFIG_PARAMETERS, "'core.fixture=1'");
  for (const key of keys)
    if (before[key] === undefined) delete process.env[key];
    else process.env[key] = before[key];
  assert.equal(process.env.GIT_CONFIG_GLOBAL, before.GIT_CONFIG_GLOBAL);
  assert.ok(!existsSync(global), "temp global config was not removed");
});
