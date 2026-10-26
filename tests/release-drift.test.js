import assert from "node:assert/strict";
import test from "node:test";
import {
  compareVersions,
  findDrift,
} from "../.github/scripts/check-release-drift.mjs";

test("versions compare numerically", () => {
  assert.equal(compareVersions("0.4.1", "0.4.0"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1);
  assert.equal(compareVersions("0.4.0", "0.4.0"), 0);
});

test("a version bump that was never published is drift", () => {
  const [problem] = findDrift({
    local: "0.4.1",
    published: "0.4.0",
    changedSinceTag: [],
  });
  assert.match(problem, /tagged v0\.4\.1/);
});

test("packaged changes without a version bump are drift", () => {
  const [problem] = findDrift({
    local: "0.4.0",
    published: "0.4.0",
    changedSinceTag: ["src/cli.js"],
  });
  assert.match(problem, /src\/cli\.js/);
});

test("matching versions with no packaged changes are clean", () => {
  assert.deepEqual(
    findDrift({ local: "0.4.0", published: "0.4.0", changedSinceTag: [] }),
    [],
  );
});
