import test from "node:test";
import assert from "node:assert/strict";
import {
  listMigratableJobs,
  applyMigration,
  mergeNeeds,
  filterJobs,
} from "../src/migrate.js";
import { WAKE_JOB } from "../src/wake.js";

const sample = `name: Test

on:
  pull_request:

jobs:
  install:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - run: echo hi
  deploy:
    needs: install
    runs-on: ubuntu-24.04
    steps:
      - run: echo deploy
`;

test("listMigratableJobs finds static runs-on jobs", () => {
  const jobs = listMigratableJobs(sample, ".github/workflows/ci.yml");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].name, "install");
  assert.equal(jobs[1].name, "deploy");
});

test("applyMigration adds boxci-wake and rewires selected jobs", async () => {
  const { wakeJobYaml } = await import("../src/wake.js");
  const wake = await wakeJobYaml({
    label: "instabox-test",
    secret: "BOXCI_API_KEY",
  });
  const keys = new Set([".github/workflows/ci.yml:install"]);
  const { content, changed } = applyMigration(
    sample,
    keys,
    ".github/workflows/ci.yml",
    wake,
  );
  assert.equal(changed, true);
  assert.match(content, new RegExp(`  ${WAKE_JOB}:`));
  assert.match(content, /fromJSON\(needs\.boxci-wake\.outputs\.runner\)/);
  assert.doesNotMatch(content, /deploy:[\s\S]*fromJSON\(needs\.boxci-wake/);
  assert.match(content, /permissions:\s*\n  contents: read/);
});

test("mergeNeeds prepends boxci-wake", () => {
  assert.equal(mergeNeeds("install"), `[${WAKE_JOB}, install]`);
  assert.equal(mergeNeeds(WAKE_JOB), WAKE_JOB);
});

test("filterJobs matches runs-on substring", () => {
  const jobs = listMigratableJobs(sample, ".github/workflows/ci.yml").map(
    (j) => ({
      ...j,
      relPath: ".github/workflows/ci.yml",
    }),
  );
  const picked = filterJobs(jobs, { match: "blacksmith" });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].name, "install");
});
