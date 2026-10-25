# Validation

v0.4.0, 25 October 2026. This record covers standalone BoxCI checks that require no live credentials, run against tag `v0.4.0` (commit `934b87e`).

## Automated coverage

Automated checks cover helper-only init (no starter or build workflow is created, and deleted legacy starters are never recreated), setup review/cancellation, existing pool adoption, local workflow and legacy-checkpoint recovery, secret-transfer retry, account switching, dynamic quota, manifest updates on pool growth, passive paused status, unmanaged-label refusal, explicit branch dispatch, application-workflow dispatch that never dispatches the reusable helper, consumer workflow discovery, native CLI fallback, redaction, credential rotation ordering, dashboard authorization/origin/read-only enforcement and bootstrap checksums. Python wake/routing/pool tests cover `ci/wake.py`.

Regression coverage verifies fresh discovery of `BOXCI_POOL` and legacy `INSTABOX_CI_POOL`, current-name precedence, authoritative recorded names, reuse without provisioning, workflow variable selection, growth on the selected manifest and refusal of invalid manifests before mutations.

The pinned SDK is exercised against a local HTTP fixture. Provider and GitHub operations use injected transports; passive discovery/validation checks verify GET-only access without resuming paused VMs. Official-CLI transports cover authentication reuse, browser-auth return and cancellation.

## Standalone check results

Run the four documented checks before a release; hosted results are in the repository's **Check** workflow.

Local run on 25 October 2026 from a clean clone of `v0.4.0` on Linux x64 with Node.js 22.23.4, npm 10.9.9 and Python 3.13.5:

| Check                                      | Result                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| `npm ci`                                   | Passed; 3 packages added, 0 vulnerabilities reported    |
| `npm test`                                 | 110 tests: 110 passed, 0 failed, 0 skipped, 0 cancelled |
| `python3 -m unittest discover -s ci/tests` | 27 tests ran, OK                                        |
| `npm run check`                            | All matched files use Prettier code style               |
| `npm pack --dry-run`                       | `@balasivagn/boxci` 0.4.0: 51 files, 438.1 kB packed    |

This environment allowed loopback listeners, so the dashboard, SDK and HTTPS certificate fixtures ran locally and passed. Environments that block loopback listeners cannot establish a complete local Node pass; the hosted suite exercises those listeners.

The **Check** workflow runs on every push and pull request. Its `test` job runs `npm ci --ignore-scripts`, `npm run check`, `npm test`, the Python tests and `npm pack --dry-run` on Ubuntu 24.04 with Node.js 22.19.0, 22, 24.5.0 and 24. A `dashboard-macos` job runs the dashboard tests on macOS 14 with Node.js 22. The `wake-helper` jobs call the local reusable wake workflow with an empty pool and assert that it routes to hosted `ubuntu-24.04` without secrets. All seven jobs passed on commit `934b87e` in [Check on `main`](https://github.com/balasivagn/boxci/actions/runs/40194922289) and [Check on `v0.4.0`](https://github.com/balasivagn/boxci/actions/runs/40195014402).

The local-workflow regression suite covers cancellation, helper-only readiness (a published helper and a connected application workflow are required), legacy setups resuming only their helper on the existing VM and runner, checkout ownership, local-edit conflicts, symlink refusal, completion-checkpoint recovery, default-branch readiness and migration file rechecks. Tests reject GitHub workflow-content, branch and PR writes, and confirm credential retries reuse the existing VM and runner.

Package dry-run verification includes documentation and architecture artifacts, and excludes scratch files, private state and development dependencies.

## Verification limits

Fresh cloud provisioning, key creation and missing-tool installation are exercised with injected transports. A brand-new account/provider consent flow and native Linux/Windows bootstrap still need verification. Browser sign-in remains delegated to official CLIs.

Manual dispatch prerequisites are documented against [GitHub's requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#configuring-a-workflow-to-run-manually). Architecture diagram verification is recorded in [the architecture guide](ARCHITECTURE.md).

Live inventory, account state, job logs and browser session data belong in ignored `.orca-scratch/`, outside source and package artifacts.
