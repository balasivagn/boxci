import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  reusableWakeWorkflow,
  wakeJobYaml,
  legacyWakeJobYaml,
  upgradeWakeJob,
} from "../src/wake.js";
import { workflow } from "../src/workflow.js";

const config = {
  label: "dedicated-pool",
  pool_variable: "CUSTOM_POOL",
  secret: "CUSTOM_KEY",
  command: "npm test",
};
test("caller delegates to a local helper and forwards only the selected secret", async () => {
  const caller = await workflow(config);
  assert.match(caller, /uses: \.\/\.github\/workflows\/boxci-wake.yml/);
  assert.match(caller, /pool: \$\{\{ vars.CUSTOM_POOL \}\}/);
  assert.match(caller, /api-key: \$\{\{ secrets.CUSTOM_KEY \}\}/);
  assert.match(caller, /needs: boxci-wake/);
  assert.doesNotMatch(caller, /python3|ThreadPoolExecutor|secrets: inherit/);
});
test("helper wires workflow/job/step outputs, keeps trust checks and embeds exactly the tested Python source", async () => {
  const helper = await reusableWakeWorkflow();
  assert.match(helper, /workflow_call:/);
  assert.match(helper, /value: \$\{\{ jobs.wake.outputs.runner \}\}/);
  assert.match(helper, /runner: \$\{\{ steps.route.outputs.runner \}\}/);
  assert.match(
    helper,
    /BOXCI_TRUSTED: .*head.repo.full_name == github.repository/,
  );
  assert.match(helper, /draft == false/);
  assert.match(helper, /BOXCI_API_KEY: \$\{\{ secrets.api-key \}\}/);
  assert.doesNotMatch(
    helper,
    /actions\/checkout|pull_request_target|secrets: inherit|run:.*\$\{\{/,
  );
  const code = helper
    .split("python3 - <<'BOXCI_WAKE'\n")[1]
    .split("          BOXCI_WAKE")[0]
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
  assert.equal(
    code.trimEnd(),
    (
      await readFile(new URL("../ci/wake.py", import.meta.url), "utf8")
    ).trimEnd(),
  );
  assert.equal(
    helper,
    await readFile(
      new URL("../.github/workflows/boxci-wake.yml", import.meta.url),
      "utf8",
    ),
  );
  const compiled = spawnSync(
    "python3",
    ["-c", "import ast,sys; ast.parse(sys.stdin.read())"],
    { input: code, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
});
test("legacy upgrade preserves every application step and rejects a customized privileged block", async () => {
  const old = await legacyWakeJobYaml(config);
  const source =
    "jobs:\n" +
    old +
    "\n  test:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: custom application tests\n";
  const expected = source.replace(old, await wakeJobYaml(config));
  assert.equal(await upgradeWakeJob(source, config), expected);
  assert.equal(await upgradeWakeJob(expected, config), expected);
  await assert.rejects(
    upgradeWakeJob(
      source.replace("timeout-minutes: 7", "timeout-minutes: 99"),
      config,
    ),
    /custom or different/,
  );
});
