import test from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "../src/terminal.js";
import { version } from "../src/version.js";

const plan = {
  repo: "acme/project",
  account: { login: "builder" },
  pool: [{ runner_name: "saved-runner-01" }],
  target_count: 1,
  incomplete: true,
  status: "workflow_uploaded",
  label: "dedicated-pool",
  quota: { used: 3, max: 5 },
  command: "npm ci && npm test",
  actions: ["Resume the saved setup without replacing the VM or runner."],
};
function capture({ isTTY = true, environment = {}, plain = false } = {}) {
  let output = "";
  const stream = {
    isTTY,
    columns: 70,
    write: (value) => {
      output += value;
    },
  };
  return {
    terminal: new Terminal({ stream, environment, plain }),
    output: () => output,
  };
}
test("interactive plan makes the target repository and saved runner checkpoints visible", () => {
  const c = capture();
  c.terminal.plan(plan);
  assert.match(c.output(), /Resume saved setup/);
  assert.match(c.output(), /acme\/project/);
  assert.ok(c.output().includes(`BoxCI v${version}`));
  assert.match(c.output(), /GitHub Actions changes target the repository above/);
  assert.match(c.output(), /saved-runner-01/);
  assert.match(c.output(), /1 saved · target 1/);
  assert.match(c.output(), /\x1b\[36m/);
});
test("redirected, JSON/plain, NO_COLOR and dumb terminals do not receive ANSI color codes", () => {
  for (const options of [
    { isTTY: false },
    { plain: true },
    { environment: { NO_COLOR: "1", CI: "true" } },
    { environment: { TERM: "dumb" } },
  ]) {
    const c = capture(options);
    c.terminal.plan(plan);
    c.terminal.step("Checking saved runner…");
    c.terminal.finish();
    assert.doesNotMatch(c.output(), /\x1b/);
  }
});
test("a failed step stops its progress animation and reports failure", () => {
  const c = capture();
  c.terminal.step("Creating CI credential…");
  c.terminal.finish(false);
  assert.equal(c.terminal.timer, null);
  assert.match(c.output(), /✗/);
  assert.doesNotMatch(c.output(), /✓/);
});
