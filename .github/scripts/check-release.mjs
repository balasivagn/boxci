import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function checkRelease(pkg, { repository, event, tag }) {
  assert.equal(repository, "balasivagn/boxci", "Unexpected release repository");
  assert.equal(pkg.name, "@balasivagn/boxci", "Unexpected npm package");
  assert.notEqual(pkg.private, true, "Package is marked private");
  assert.equal(
    pkg.repository?.url,
    "git+https://github.com/balasivagn/boxci.git",
  );
  assert.match(
    pkg.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/,
    "Only stable versions can be published",
  );
  assert.ok(
    ["release", "push", "workflow_dispatch"].includes(event),
    "Unexpected release event",
  );
  if (event === "release")
    assert.equal(
      tag,
      `v${pkg.version}`,
      "Release tag must match package.json version",
    );
  return pkg.version;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  checkRelease(pkg, {
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    tag: process.env.RELEASE_TAG,
  });
  console.log(`Release checks passed for ${pkg.name}@${pkg.version}.`);
}
