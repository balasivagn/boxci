# BoxCI

Run GitHub Actions on a small pool of InstaBox VMs that wake for CI and suspend when idle. BoxCI handles runner setup, credentials and workflow routing. An optional local dashboard shows the pool without keeping it awake.

Use it when you want dedicated, persistent Linux runners and are willing to manage an InstaBox account and renew a CI credential. Hosted GitHub runners remain a simpler choice when you do not need your own VMs. Measure your own build times and provider usage; BoxCI does not promise lower costs or faster builds.

**v0.1.0 candidate; not published to npm yet.** The intended package is **`@balasivagn/boxci`**. This project is independent of InstaBox and is **not affiliated with [boxci.dev](https://boxci.dev)**.

## Requirements and scope

- Node.js **22 or newer**, npm, Git, and access to GitHub.
- A GitHub.com repository where you have **admin access**, with Actions enabled.
- An InstaBox account with capacity for at least one additional VM, or an existing verified CI pool. Paused/stopped VMs still count toward quota. Prefer a dedicated CI account: the CI key can execute commands on all VMs in its account.
- A terminal for the official GitHub and InstaBox sign-in flows. Existing sessions are reused. BoxCI bundles the official InstaBox CLI as a fallback and can install a checksum-verified GitHub CLI privately when missing.

The starter workflow uses **Linux x64 runners, Node 24 and one build job**. It infers npm/pnpm tests from the target repository's default-branch `package.json`; use `--command` for a different command. Other language toolchains need explicit workflow setup. The starter runs for non-draft PRs and manual dispatch, with no `push` trigger. Fork PRs use hosted Ubuntu.

The commands below use a POSIX shell. Linux/Windows bootstrap and fresh-account authentication still need native verification. See [validation coverage](docs/VALIDATION.md).

## First successful CI run

### 1. Make the candidate CLI available

Clone the public source repository:

```sh
git clone https://github.com/balasivagn/boxci.git
cd boxci
npm ci
BOXCI_SOURCE="$PWD"
boxci() {
  node "$BOXCI_SOURCE/bin/boxci.js" "$@"
}
boxci --help
```

This defines `boxci` as a shell function for this terminal session, including after changing directories. In a new terminal, set `BOXCI_SOURCE` to the absolute path of this clone and define the function again. No npm publication is required.

Alternatively, [install a local packed candidate](#install-a-packed-candidate).

### 2. Choose your workflow path and review setup

| Your goal                           | Path                                                                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add a basic Node CI workflow        | Run setup below, then review and merge the generated workflow PR.                                                                                                    |
| Move existing CI jobs onto the pool | Run setup below, then follow [Migrate existing workflows](#migrate-existing-workflows). Setup still opens a starter workflow PR; migration is a separate local edit. |
| Reuse an existing pool              | Start with a dry run and read [pool discovery and recovery](docs/CONFIGURATION.md#pool-discovery-and-recovery), especially on a new machine.                         |

Change to the **application repository checkout**, replacing `/path/to/your-app`:

```sh
cd /path/to/your-app
boxci init --dry-run
```

BoxCI reuses or opens the official sign-ins, checks account quota, and displays the target repository, account, runner label, test command and planned actions. A dry run creates no VMs, runners, CI keys, repository settings or local project record; sign-in/tool bootstrap may still occur.

Confirm that the account, repository and command are correct, then run:

```sh
boxci init
```

Approve the displayed plan. New setup creates one dedicated VM by default, installs a checksum-verified GitHub runner service, transfers a validated 30-day provider key directly to an Actions secret, sets the pool variable, and opens a workflow PR. It does not merge the PR. Reruns resume saved checkpoints.

Use `--repo owner/repository` to choose the target explicitly. To override test inference, pass the same command to both preview and setup, for example:

```sh
boxci init --command "npm ci && npm run test:ci" --dry-run
boxci init --command "npm ci && npm run test:ci"
```

### 3. Review, merge and verify

Open the PR URL printed by setup. Review the generated test command, Node version and triggers, then merge through your normal repository controls. The setup PR itself can run CI before merge; draft PRs skip the generated wake/build jobs.

After merging:

```sh
boxci doctor
boxci ci run
boxci status
```

`ci run` requests a manual run of the configured workflow on the default branch; it does not wait for completion. Check the **BoxCI** run in GitHub Actions for the final result and runner assignment. `status` shows the pool and recent jobs; `doctor` checks the mapping, merge state, quota and known credential expiry.

For an optional live view:

```sh
boxci dashboard
```

The dashboard is local, authenticated and read-only. You can close it and your laptop after setup: hosted GitHub wake jobs run independently.

## Migrate existing workflows

After `init`, run from the **target repository checkout**:

```sh
boxci migrate --match blacksmith --dry-run
boxci migrate --match blacksmith
# Or choose jobs interactively:
boxci migrate
```

Migration adds a hosted `boxci-wake` job and updates selected jobs' `needs` and `runs-on`. It edits files locally; review `git diff`, commit, and push or open a PR yourself. It does not push changes. `--match` matches a regular expression against the existing `runs-on` value; `--jobs file.yml:job,...` selects explicit jobs.

Select jobs that can run on **Linux x64** and whose steps work on both the InstaBox VM and hosted Ubuntu fallback. Migration changes scheduling, not language/toolchain setup, services or caches. It scans static `runs-on` values; dynamic expressions are skipped. Review matrix jobs and complex `needs` manually.

`boxci init --migrate-workflows` runs the same migration after setup. The starter workflow is separate and is skipped by migration. If your existing CI already covers its tests, review whether to keep the starter enabled to avoid duplicate builds. Agent-assisted guidance is in [the migration skill](skills/boxci-migrate/SKILL.md).

## Everyday operations

```sh
boxci status                       # VM and GitHub runner states; passive
boxci doctor                       # account, quota, mapping, merge and expiry checks
boxci pool add --count 1 --dry-run  # preview extra capacity
boxci pool add --count 1            # review and add capacity
boxci wake                         # explicitly wake the pool
boxci ci run                       # dispatch the configured workflow
boxci ci run --ref your-test-branch # choose an explicit ref; see troubleshooting
boxci auth renew --dry-run         # preview credential rotation
boxci auth renew                   # review and rotate the CI credential
boxci dashboard                    # local read-only UI
```

Add `--repo owner/repository` outside its checkout. Use `--yes` to apply a reviewed plan without a terminal prompt and `--json` for structured results. Status, doctor and dashboard never execute guest commands or wake VMs.

One runner handles one job at a time. Pools support up to five distinct VMs, subject to actual account quota. Multiple jobs or a matrix are needed to use several VMs in parallel.

**Renew the CI credential before its 30-day expiry.** `doctor` flags known expiry within seven days. There is no automatic renewal or reminder service. See [operations and troubleshooting](docs/OPERATIONS.md) for rotation, recovery, queued jobs and stopping use.

## How routing works

![BoxCI architecture: local setup, hosted wake routing, and passive monitoring](docs/architecture/boxci.svg)

[Architecture and source map](docs/ARCHITECTURE.md) · [Interactive Archify diagram](docs/architecture/boxci.html) (download and open locally; GitHub shows HTML as source)

1. A hosted Ubuntu wake job reads the repository's pool variable and CI secret. Its privileged phase never checks out PR code.
2. For a trusted event, it wakes all reviewed pool members concurrently and checks their runner services. If the full pool is ready, it selects `["self-hosted", "Linux", "<dedicated-label>"]`; otherwise it selects hosted `ubuntu-24.04`. Fork PRs always use hosted fallback.
3. GitHub assigns each build job to an idle runner matching all selected labels. VMs keep normal idle suspension; BoxCI installs no keepalive or webhook server.

Service readiness does **not** prove GitHub connectivity. Fallback is chosen before assignment and cannot rescue a job already queued on a disconnected self-hosted runner.

See [configuration and authentication](docs/CONFIGURATION.md) for local records, repository settings and labels, and [security](SECURITY.md) for credential scope and isolation limits. Account API results are authoritative for quota; current provider details are in its [limits](https://instabox.sh/docs/limits) and [changelog](https://instabox.sh/changelog).

## Install a packed candidate

From the BoxCI source directory, with an npm global prefix writable by your user:

```sh
mkdir -p dist
npm run pack:local
npm install --global ./dist/balasivagn-boxci-0.1.0.tgz
boxci --help
```

Ensure your npm global executable directory is on `PATH`. If you prefer no global installation, use the source function above. The package remains private/unpublished; a local tarball installation does not publish it.

## Develop

```sh
npm ci
npm test
python3 -m unittest discover -s ci/tests
npm run check
npm pack --dry-run
```

No live credentials are needed. Tests use injected transports and local HTTP fixtures; the Node tests need permission to bind loopback sockets. Keep live inventory, logs and scratch files in ignored `.orca-scratch/`.

[Developer experience contract](docs/DEVELOPER_EXPERIENCE.md) · [Design tokens](docs/DESIGN.md) · [Validation](docs/VALIDATION.md)

## License

Apache-2.0. Third-party notices are in [NOTICE](NOTICE) and `vendor/`. Official provider tools and vendored fonts retain their own licenses.
