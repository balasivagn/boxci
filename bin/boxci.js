#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { App } from "../src/engine.js";
import { dashboard } from "../src/dashboard.js";
import { redact } from "../src/process.js";
import { Terminal } from "../src/terminal.js";
import { version } from "../src/version.js";
let terminal = new Terminal();
let output = new Terminal({ stream: process.stdout });
const help = `boxci v${version} — BoxCI: GitHub Actions on InstaBox (not boxci.dev)

Install globally from anywhere. Run init and migrate from the application
checkout whose GitHub Actions you want to configure.

  boxci init                  Detect sign-ins, review one setup plan, finish setup
  boxci status                Pool, VM states, runners and recent CI
  boxci doctor                Explain setup, account and credential problems
  boxci auth renew            Review and rotate the repository CI credential
  boxci pool add --count 1    Review and add dedicated VM/runners
  boxci wake                  Explicitly wake the configured pool
  boxci ci run                Run the merged workflow (--ref tests a branch)
  boxci migrate               Rewire selected workflow jobs to the InstaBox pool
  boxci dashboard             Open the optional, local, read-only dashboard

  --repo owner/repository     Otherwise inferred from the current Git checkout
  --version, -v               Show the installed CLI version
  --migrate-workflows         After init, interactively migrate existing workflows
  --match TEXT                migrate: select jobs whose runs-on contains TEXT
  --jobs file.yml:job,...     migrate: explicit job list (under .github/workflows)
  --dry-run                   Review without changing VMs/GitHub/local project
  --yes                       Apply the displayed plan without a terminal prompt
  --json                      Machine-readable result; diagnostics go to stderr
  --no-color                  Disable colors and animation; respects NO_COLOR
  --provider google|github    Only used if InstaBox sign-in is needed
  --device                    Use InstaBox's native device login (GitHub)
  --secret NAME               Explicitly choose/reuse an Actions secret
  --command "install && test" Override the detected test command
  --no-open                   Keep the dashboard server without opening a browser

Existing provider/GitHub sessions are reused. No BoxCI account or token pasting.
InstaBox CLI is used directly, with the bundled official npm CLI as fallback.
GitHub CLI sign-in is reused; if missing, an official checksum-verified copy is installed privately.
`;
const strings = [
  "repo",
  "count",
  "provider",
  "secret",
  "command",
  "label",
  "ref",
  "port",
  "session-file",
  "match",
  "jobs",
];
const bools = [
  "help",
  "json",
  "yes",
  "dry-run",
  "device",
  "no-open",
  "migrate-workflows",
  "no-color",
  "version",
];
const options = Object.fromEntries([
  ...strings.map((k) => [k, { type: "string" }]),
  ...bools.map((k) => [k, { type: "boolean" }]),
]);
options.version.short = "v";
try {
  const { values, positionals } = parseArgs({
    options,
    allowPositionals: true,
  });
  if (values.version || positionals[0] === "version") {
    console.log(values.json ? JSON.stringify({ version }) : version);
    process.exit(0);
  }
  if (values.help || !positionals.length) {
    console.log(help);
    process.exit(0);
  }
  const opts = { ...values, dryRun: values["dry-run"] };
  terminal = new Terminal({ plain: values.json || values["no-color"] });
  output = new Terminal({
    stream: process.stdout,
    plain: values.json || values["no-color"],
  });
  const emit = (event) => {
    if (values.json) return;
    if (event.type === "plan") {
      terminal.plan(event.plan);
    } else if (event.type === "migrate-plan") {
      const p = event.plan;
      console.error(
        `\n${p.repo} · migrate ${p.jobs.length} job(s) · label ${p.label}\n`,
      );
      for (const j of p.jobs)
        console.error(`  ${j.workflow} → ${j.job}  (was ${j.runs_on})`);
      for (const e of p.edits) console.error(`  write ${e.relPath}`);
    } else if (event.type === "step") terminal.step(event.message);
    else if (event.type === "complete" || event.type === "adopted")
      terminal.finish();
    else if (event.message) console.error(event.message);
  };
  const app = new App({ emit });
  const approve = async (plan) => {
    terminal.finish();
    if (!process.stdin.isTTY)
      throw new Error(
        "Use --dry-run to inspect the plan, then --yes in automation.",
      );
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    try {
      return /^y(es)?$/i.test(
        (
          await rl.question(
            terminal.paint(
              "yellow",
              plan?.incomplete
                ? "Continue this saved setup? [y/N] "
                : "Apply this plan? [y/N] ",
            ),
          )
        ).trim(),
      );
    } finally {
      rl.close();
    }
  };
  let result;
  const [command, sub] = positionals;
  const migrateApprove = async (plan) => {
    if (opts.yes) return true;
    return approve(plan);
  };
  if (command === "init") {
    result = await app.init(opts, approve);
    if (
      result &&
      !opts.dryRun &&
      opts["migrate-workflows"] &&
      result.pool?.length
    ) {
      try {
        await app.migrate({ ...opts, dryRun: false }, migrateApprove);
      } catch (e) {
        console.error("boxci migrate: " + redact(e.message));
      }
    }
  } else if (command === "status") result = await app.status(opts);
  else if (command === "doctor") result = await app.doctor(opts);
  else if (command === "pool" && sub === "add")
    result = await app.add(opts, approve);
  else if (command === "auth" && sub === "renew")
    result = await app.renew(opts, approve);
  else if (command === "wake") result = await app.wake(opts);
  else if (command === "ci" && sub === "run") result = await app.ciRun(opts);
  else if (command === "migrate")
    result = await app.migrate(opts, migrateApprove);
  else if (command === "dashboard") {
    await dashboard(app, opts);
    result = null;
  } else throw new Error("Unknown command. Run boxci --help.");
  if (result) {
    terminal.finish();
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else if (command === "status") {
      console.log(
        `\n${output.paint("bold", result.repo)} · checked ${result.checked_at}\n`,
      );
      for (const m of result.members)
        console.log(
          `${m.name.padEnd(24)} ${output.paint(m.vm.state === "running" ? "green" : "yellow", m.vm.state.padEnd(12))} GitHub ${output.paint(m.runner.status === "online" && !m.runner.busy ? "green" : "yellow", m.runner.busy ? "busy" : m.runner.status === "online" ? "idle" : m.runner.status)}`,
        );
      if (result.pr && !result.pr.merged)
        console.log(`\nCI migration awaits merge: ${result.pr.url}`);
      if (result.history_error)
        console.error("History unavailable: " + result.history_error);
    } else if (command === "doctor") {
      for (const check of result.checks)
        console.log(
          `${output.paint(check.ok ? "green" : "yellow", check.ok ? "✓" : "!")} ${check.name}: ${check.detail}`,
        );
    } else if (values["dry-run"])
      console.log("Plan only. No setup changes made.");
    else if (command === "migrate")
      console.log(result.message || "Migration applied.");
    else
      console.log(
        result.pr_url
          ? `\n${output.paint("green", "✓ Ready:")} ${result.pr_url}\nboxci status · boxci migrate · boxci dashboard`
          : result.message || "Done.",
      );
  }
} catch (error) {
  terminal.finish(false);
  const tone = /^(Setup cancelled|Cancelled\.)/i.test(error.message)
    ? "dim"
    : "red";
  console.error(terminal.paint(tone, "boxci: ") + redact(error.message));
  process.exitCode = 1;
}
