import test from "node:test";
import assert from "node:assert/strict";
import { checkRelease } from "../.github/scripts/check-release.mjs";

const pkg = {
  name: "@balasivagn/boxci",
  version: "0.1.1",
  repository: { url: "git+https://github.com/balasivagn/boxci.git" },
};
const release = {
  repository: "balasivagn/boxci",
  event: "release",
  tag: "v0.1.1",
};

test("stable release must match the reviewed package version", () => {
  assert.equal(checkRelease(pkg, release), "0.1.1");
  for (const tag of ["v0.1.0", "0.1.1", "v0.1.1; echo unexpected"])
    assert.throws(
      () => checkRelease(pkg, { ...release, tag }),
      /tag must match/,
    );
  assert.throws(
    () => checkRelease({ ...pkg, version: "0.1.1-beta.1" }, release),
    /stable versions/,
  );
});

test("forks, unrelated packages, private packages and non-release events cannot pass release validation", () => {
  assert.throws(
    () => checkRelease(pkg, { ...release, repository: "other/boxci" }),
    /repository/,
  );
  assert.throws(
    () => checkRelease({ ...pkg, name: "other" }, release),
    /package/,
  );
  assert.throws(
    () => checkRelease({ ...pkg, private: true }, release),
    /private/,
  );
  assert.throws(() =>
    checkRelease({ ...pkg, repository: { url: "other" } }, release),
  );
  assert.throws(
    () => checkRelease(pkg, { ...release, event: "pull_request" }),
    /event/,
  );
});

test("manual validation can check an unreleased version without a release tag", () => {
  assert.equal(
    checkRelease(pkg, {
      ...release,
      event: "workflow_dispatch",
      tag: undefined,
    }),
    "0.1.1",
  );
});

test("a push to main passes release validation without a tag", () => {
  assert.equal(
    checkRelease(pkg, { ...release, event: "push", tag: undefined }),
    "0.1.1",
  );
});
