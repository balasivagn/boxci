// Per-command help for `boxci <command> --help`, `-h` and `boxci help <command>`.
// Lists only the flags each command reads; global flags are in `boxci --help`.
const common = {
  repo: "  --repo owner/repository     Otherwise inferred from the current Git checkout",
  dryRun:
    "  --dry-run                   Review without changing VMs/GitHub/local project",
  yes: "  --yes                       Apply the displayed plan without a terminal prompt",
  json: "  --json                      Machine-readable result; diagnostics go to stderr",
  noColor:
    "  --no-color                  Disable colors and animation; respects NO_COLOR",
  provider:
    "  --provider google|github    Only used if InstaBox sign-in is needed",
  device:
    "  --device                    Use InstaBox's native device login (GitHub)",
};
const page = (usage, summary, lines) =>
  `Usage: ${usage}\n\n${summary}\n\n${lines.join("\n")}\n`;
const dashboardStatus = page(
  "boxci dashboard status [options]",
  "Check the local dashboard process.",
  [common.repo, common.json],
);
const dashboardStop = page(
  "boxci dashboard stop [options]",
  "Stop the local dashboard; cloud runners stay as-is.",
  [common.repo, common.json],
);
const authRenew = page(
  "boxci auth renew [options]",
  "Review and rotate the repository CI credential.",
  [
    common.repo,
    common.dryRun,
    common.yes,
    common.provider,
    common.device,
    common.json,
    common.noColor,
  ],
);
const poolAdd = page(
  "boxci pool add [--count N] [options]",
  "Review and add dedicated VM/runners to the existing pool (at most five VMs).",
  [
    "  --count N                   Number of VMs/runners to add (default 1)",
    common.repo,
    common.dryRun,
    common.yes,
    common.provider,
    common.device,
    common.json,
    common.noColor,
  ],
);
const ciRun = page(
  "boxci ci run [--workflow file.yml] [--ref REF] [options]",
  "Run a connected CI workflow through workflow_dispatch.",
  [
    "  --workflow file.yml         Select your application workflow (under .github/workflows)",
    "  --ref REF                   Branch or ref to test (default: the base branch)",
    common.repo,
    common.json,
    common.noColor,
  ],
);
const pages = {
  init: page(
    "boxci init [options]",
    "Set up runners and write only the shared wake helper. Run it from the\napplication checkout whose GitHub Actions you want to configure.",
    [
      common.repo,
      common.dryRun,
      common.yes,
      "  --count N                   Number of dedicated VMs/runners (default 1)",
      "  --label NAME                Dedicated runner label (default: boxci- plus a repository hash)",
      "  --secret NAME               Explicitly choose/reuse an Actions secret",
      '  --command "install && test" Legacy setup metadata; no test job is generated',
      "  --migrate-workflows         After init, interactively migrate existing workflows",
      common.provider,
      common.device,
      common.json,
      common.noColor,
    ],
  ),
  status: page(
    "boxci status [options]",
    "Pool, VM states, runners and recent CI. Never wakes VMs.",
    [common.repo, common.json, common.noColor],
  ),
  doctor: page(
    "boxci doctor [options]",
    "Explain setup, account and credential problems. Never wakes VMs.",
    [common.repo, common.json, common.noColor],
  ),
  wake: page(
    "boxci wake [options]",
    "Explicitly wake the configured pool, then show its status.",
    [common.repo, common.json, common.noColor],
  ),
  migrate: page(
    "boxci migrate [--match REGEX | --jobs file.yml:job,...] [options]",
    "Rewire selected workflow jobs to the InstaBox pool. Run it from the\napplication checkout; workflow edits stay local for review.",
    [
      "  --match REGEX               Select jobs whose runs-on matches REGEX (case-insensitive)",
      "  --jobs file.yml:job,...     Explicit job list (under .github/workflows); overrides --match",
      common.repo,
      common.dryRun,
      common.yes,
      common.json,
      common.noColor,
    ],
  ),
  dashboard: page(
    "boxci dashboard [status|stop] [options]",
    "Start/reopen the local dashboard in the background.\n\n  boxci dashboard status      Check the local dashboard process\n  boxci dashboard stop        Stop the local dashboard; cloud runners stay as-is",
    [
      "  --port N                    Local dashboard port, 0-65535 (default 0: a free port)",
      "  --no-open                   Keep the dashboard server without opening a browser",
      "  --foreground                Run the dashboard in this terminal for debugging",
      "  --session-file PATH         Write browser authorization to a private file",
      common.repo,
      common.json,
    ],
  ),
  "dashboard status": dashboardStatus,
  "dashboard stop": dashboardStop,
  auth: authRenew,
  "auth renew": authRenew,
  pool: poolAdd,
  "pool add": poolAdd,
  ci: ciRun,
  "ci run": ciRun,
};
/**
 * Help for the given command words, or null for an unknown command.
 * @param {string[]} words
 */
export function commandHelp(words) {
  const [command, sub] = words;
  if (sub !== undefined && pages[`${command} ${sub}`])
    return pages[`${command} ${sub}`];
  return Object.hasOwn(pages, command ?? "") ? pages[command] : null;
}
