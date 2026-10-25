import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { readFile } from "node:fs/promises";
import { filterJobs } from "../src/migrate.js";
import { version } from "../src/version.js";

const cli = fileURLToPath(new URL("../bin/boxci.js", import.meta.url));
const run = (...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: "" },
    encoding: "utf8",
  });
test("bare CLI welcomes users with setup and migration steps without external CLIs", () => {
  for (const args of [[], ["--no-color"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      new RegExp(`^BoxCI v${version.replaceAll(".", "\\.")}\\n`),
    );
    assert.match(result.stdout, /GitHub Actions on InstaBox\./);
    assert.match(result.stdout, /Get started: boxci init/);
    assert.match(result.stdout, /Existing CI\? Run boxci migrate after init\./);
    assert.match(result.stdout, /application's checkout/);
    assert.match(result.stdout, /review, commit,\s+and push/);
    assert.match(result.stdout, /boxci --help/);
    assert.doesNotMatch(result.stdout, /\x1b|--provider/);
    assert.equal(result.stderr, "");
  }
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
  assert.match(result.stdout, /dashboard status/);
  assert.match(result.stdout, /dashboard stop/);
  assert.match(result.stdout, /--foreground/);
  assert.doesNotMatch(result.stdout, /Get started:/);
});
const globalHelp = () => run("--help").stdout;
const commandFlags = {
  version: ["--version", "-v", "--json"],
  init: ["--repo", "--dry-run", "--yes", "--count", "--label", "--secret"],
  status: ["--repo", "--json"],
  doctor: ["--repo", "--json"],
  wake: ["--repo", "--json"],
  migrate: ["--match REGEX", "--jobs", "--dry-run", "--yes", "--repo"],
  dashboard: ["--port N", "--no-open", "--foreground", "--session-file"],
  "dashboard status": ["--repo", "--json"],
  "dashboard stop": ["--repo", "--json"],
  "auth renew": ["--dry-run", "--yes", "--provider", "--device"],
  "pool add": ["--count N", "--dry-run", "--yes"],
  "ci run": ["--workflow", "--ref", "--repo"],
};
test("every subcommand has its own help through --help, -h and boxci help", () => {
  const global = globalHelp();
  for (const [command, flags] of Object.entries(commandFlags)) {
    const words = command.split(" ");
    const outputs = [
      run(...words, "--help"),
      run(...words, "-h"),
      run("help", ...words),
    ];
    for (const result of outputs) {
      assert.equal(result.status, 0, `${command}: ${result.stderr}`);
      assert.equal(result.stderr, "", command);
      assert.equal(result.stdout, outputs[0].stdout, command);
    }
    const text = outputs[0].stdout;
    assert.notEqual(text, global, `${command} printed the global help`);
    assert.ok(text.startsWith(`Usage: boxci ${command}`), command);
    for (const flag of flags)
      assert.ok(text.includes(flag), `${command} help lacks ${flag}`);
  }
});
test("command groups show their only subcommand's help", () => {
  for (const [group, sub] of [
    ["auth", "auth renew"],
    ["pool", "pool add"],
    ["ci", "ci run"],
  ])
    assert.equal(
      run(group, "--help").stdout,
      run(...sub.split(" "), "-h").stdout,
    );
});
test("boxci version --help, -h and boxci help version show the version page, not the version", () => {
  for (const args of [
    ["version", "--help"],
    ["version", "-h"],
    ["help", "version"],
    ["version", "--json", "--help"],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.ok(result.stdout.startsWith("Usage: boxci version"), args.join(" "));
    assert.notEqual(result.stdout.trim(), version);
  }
  assert.equal(run("version").stdout.trim(), version);
});
test("boxci help with an unknown subcommand of a command group is an unknown command", () => {
  for (const group of ["pool", "auth", "ci", "dashboard"]) {
    const result = run("help", group, "bogus");
    assert.equal(result.status, 1, group);
    assert.equal(result.stdout, "", group);
    assert.match(result.stderr, /Unknown command\. Run boxci --help\./);
    // Without help the command itself is refused too.
    assert.equal(run(group, "bogus").status, 1, group);
  }
  // Like `boxci unknown --help`, a flag request falls back to the global help.
  const flagged = run("pool", "bogus", "--help");
  assert.equal(flagged.status, 0);
  assert.equal(flagged.stdout, globalHelp());
});
test("-h and boxci help print the global help; unknown commands are handled", () => {
  const global = globalHelp();
  for (const args of [["-h"], ["help"], ["-h", "--no-color"]]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, global);
  }
  const unknown = run("help", "frobnicate");
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Unknown command\. Run boxci --help\./);
  const flagged = run("frobnicate", "--help");
  assert.equal(flagged.status, 0);
  assert.equal(flagged.stdout, global);
});
test("global help documents -h, boxci help, --port and --match as a case-insensitive regex", () => {
  const text = globalHelp();
  assert.match(text, /--help, -h/);
  assert.match(text, /boxci help \[command\]/);
  assert.match(text, /--port N\s+dashboard: local port, 0-65535/);
  assert.match(
    text,
    /--match REGEX\s+migrate: select jobs whose runs-on matches REGEX/,
  );
  assert.match(text, /case-insensitive regular expression/);
  assert.doesNotMatch(text, /contains TEXT/);
  assert.match(
    run("migrate", "--help").stdout,
    /--match REGEX\s+Select jobs whose runs-on matches REGEX \(case-insensitive\)/,
  );
});
test("--match really is a case-insensitive regular expression", () => {
  const jobs = [
    { name: "a", relPath: ".github/workflows/ci.yml", runsOn: "ubuntu-24.04" },
    {
      name: "b",
      relPath: ".github/workflows/ci.yml",
      runsOn: "Self-Hosted-Big",
    },
    { name: "c", relPath: ".github/workflows/ci.yml", runsOn: "macos-14" },
  ];
  const names = (match) => filterJobs(jobs, { match }).map((j) => j.name);
  assert.deepEqual(names("^self-hosted"), ["b"]);
  assert.deepEqual(names("UBUNTU-2[0-9]"), ["a"]);
  assert.deepEqual(names("ubuntu|macos"), ["a", "c"]);
  assert.deepEqual(names("^macos$"), []);
  assert.throws(() => names("("), SyntaxError);
});
test("README documents boxci help, --port and the case-insensitive --match regex", async () => {
  const readme = await readFile(
    fileURLToPath(new URL("../README.md", import.meta.url)),
    "utf8",
  );
  assert.match(readme, /`boxci help \[command\]`/);
  assert.match(readme, /`--port N` chooses the local port \(0-65535/);
  assert.match(readme, /`--match` is a case-insensitive regular expression/);
});
