import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const PACKAGED_PATHS = ["bin", "src", "web", "ci/wake.py", "vendor", "skills"];

export function compareVersions(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// Returns a list of problems; empty means npm and main agree.
export function findDrift({ local, published, changedSinceTag }) {
  const problems = [];
  const order = compareVersions(local, published);
  if (order > 0)
    problems.push(
      `package.json is ${local} but npm latest is ${published}: publish a GitHub release tagged v${local}.`,
    );
  else if (order === 0 && changedSinceTag.length)
    problems.push(
      `main has unreleased changes to packaged files since v${published} (${changedSinceTag.join(", ")}). Bump the version and publish a release.`,
    );
  return problems;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function main() {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const res = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/latest`,
  );
  if (!res.ok) throw new Error(`npm registry returned ${res.status}`);
  const published = (await res.json()).version;
  let changedSinceTag = [];
  try {
    changedSinceTag = git(
      "diff",
      "--name-only",
      `v${published}..HEAD`,
      "--",
      ...PACKAGED_PATHS,
    )
      .split("\n")
      .filter(Boolean);
  } catch {
    console.log(`::warning::Tag v${published} not found; skipping file diff.`);
  }
  const problems = findDrift({
    local: pkg.version,
    published,
    changedSinceTag,
  });
  if (!problems.length) {
    console.log(`npm latest ${published} matches main.`);
    return;
  }
  for (const p of problems) console.log(`::warning::${p}`);
  // Pushes only warn; the daily schedule fails so the miss is noticed.
  if (process.env.GITHUB_EVENT_NAME === "schedule") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
