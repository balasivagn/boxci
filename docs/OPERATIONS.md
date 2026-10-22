# Operations and troubleshooting

Commands here assume `boxci` is available through the source function or a packed installation, and you are in the target repository checkout. Otherwise add `--repo owner/repository`; migration still requires that repository's checkout. See [installation and setup](../README.md#first-successful-ci-run).

## Check the pool

```sh
boxci status
boxci doctor
boxci dashboard
```

These commands read provider state and GitHub APIs without waking VMs or executing guest commands. The dashboard binds to `127.0.0.1`, uses an authenticated local browser session and serves assets locally. No SDK key reaches the browser. Closing it has no effect on CI. Use `--no-open` to start it without opening a browser.

VM state and GitHub runner state are separate observations:

| Observation                | Meaning / next step                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| VM paused, runner offline  | Normal between builds; a trusted CI event can wake it.                                                |
| VM running, runner idle    | GitHub reports an online runner with no active job.                                                   |
| VM running, runner busy    | A job is assigned; one runner runs one job at a time.                                                 |
| VM running, runner offline | The service may still be reconnecting or need inspection. Running does not prove GitHub connectivity. |
| An API error               | The observation failed. Do not interpret it as a healthy or offline pool.                             |

Dashboard jobs are a bounded recent history, with eight rows per page. It is not a full repository queue or usage report.

## Renew the CI credential

New CI credentials expire after 30 days. `doctor` flags a known expiry when seven days or fewer remain. There is no automatic rotation or reminder service; schedule your own renewal before expiry.

```sh
boxci auth renew --dry-run
boxci auth renew
boxci doctor
```

Review the account, repository and secret name before approving. Renewal validates and installs the new credential before retiring recorded previous keys. Failed retirement remains recorded for follow-up. If rotation fails, rerun the reviewed renewal rather than creating or pasting replacement keys manually. Externally managed/reused secrets may have unknown expiry because GitHub cannot return their values or metadata about the provider key.

An expired or missing CI key causes the generated wake helper to choose hosted fallback. It does not renew itself. The credential has machine read/write permissions across the provider account; use a dedicated CI account when possible.

## Add capacity

```sh
boxci pool add --count 1 --dry-run
boxci pool add --count 1
```

Growth checks current account quota, creates additional dedicated VMs/runners and updates the variable the workflow already consumes. The limit is five pool VMs and may be lower under your account quota. Paused/stopped VMs count; BoxCI never deletes another VM to free slots. Use multiple jobs or a matrix to make use of added capacity.

## Setup was interrupted or the local record is missing

For an interrupted setup, use the same account and repository:

```sh
boxci doctor
boxci init --dry-run
boxci init
```

Setup checkpoints completed stages and verifies recoverable resources. It refuses to replace existing runner registrations/directories. If it reports ambiguous leftovers, inspect the named resources before retrying. Do not delete the project record to force setup to start over.

A new machine or changed `BOXCI_HOME` may have no record. Restore the private per-repository record from your previous data directory when available, then verify the account and run `status`/`doctor`. A record includes integration details that the repository pool variable cannot reconstruct. Without it, review [pool discovery](CONFIGURATION.md#pool-discovery-and-recovery) and the setup dry run. An existing `BOXCI_API_KEY` requires explicit `--secret BOXCI_API_KEY` to acknowledge reuse; a custom secret requires its actual name. Existing workflow files are never overwritten, so a lost record can require manual reconciliation rather than a new setup.

If a project lock remains after a crash, first verify that its owning setup process has exited. Only then remove the specific stale lock identified by the error. Never remove an active setup's lock.

## A job stays queued after wake

1. Inspect the wake job's logs in GitHub Actions to see whether it selected the self-hosted pool or hosted Ubuntu.
2. Run `boxci status` and check the repository's **Settings → Actions → Runners** for the selected label, connectivity and busy state.
3. Allow a resumed service time to reconnect. If all matching runners are busy, the job waits for capacity. If a running VM remains offline, inspect its runner service through the official provider tools.
4. After resolving connectivity, let the queued job start or cancel and rerun through GitHub as appropriate.

The wake helper checks active runner services, not GitHub connectivity. Hosted fallback is selected before assignment and cannot move a job already queued on a self-hosted label. `boxci wake` explicitly wakes the VMs; it does not repair registrations or change a queued job's routing.

## Common setup and workflow problems

| Problem                                                                | Action                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boxci: command not found`                                             | Define the source function in this terminal, or put your npm global executable directory on `PATH` after installing the tarball.                                                                                                                                                                   |
| Cannot clone the candidate                                             | Check the public repository URL and GitHub connectivity. The npm package is not published; use the source checkout or a local tarball.                                                                                                                                                             |
| Sign-in is needed in automation                                        | Run `boxci init` interactively first. `--yes` skips plan confirmation, not service authentication.                                                                                                                                                                                                 |
| Account changed                                                        | Sign back into the account named by the project record. BoxCI refuses mutations across identities. Check `INSTABOX_API_KEY` if set as well as CLI sign-in.                                                                                                                                         |
| Repository admin access or workflow scope missing                      | Use an account with repo admin permissions and complete any official GitHub consent requested for workflow upload.                                                                                                                                                                                 |
| No unambiguous test command                                            | Set `--command "your install and test command"`; inspect the generated workflow for required toolchains. Inference reads default-branch `package.json`.                                                                                                                                            |
| Existing secret requires explicit reuse                                | Verify the intended secret/account, then pass `--secret NAME` to preview and setup. This does not validate the stored secret's contents.                                                                                                                                                           |
| Pool VM missing/renamed, label ambiguous or unmanaged runner shares it | Check the selected manifest against provider VM names and GitHub registrations. Use a dedicated custom label and reconcile the mapping before retrying.                                                                                                                                            |
| `ci run` says merge first                                              | Merge the setup PR, then dispatch. `--ref your-test-branch` explicitly chooses another ref, but [GitHub requires the dispatchable workflow on the default branch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#configuring-a-workflow-to-run-manually). |
| CI never runs on a push or a draft PR                                  | The starter has PR/manual triggers, skips draft PRs, and has no `push` trigger. Review its YAML if you need different triggers.                                                                                                                                                                    |
| Migrated workflows or tests run twice                                  | Migration preserves triggers and leaves the separate starter workflow in place. Review whether both should be enabled.                                                                                                                                                                             |
| Fork PR uses hosted Ubuntu                                             | Expected: untrusted fork code never receives the provider wake key.                                                                                                                                                                                                                                |
| `migrate` finds no jobs                                                | Run in the target checkout. Only static `runs-on` jobs are scanned; starter/wake files and dynamic expressions are skipped. Review complex YAML manually.                                                                                                                                          |
| Bootstrap download/checksum failure                                    | Do not run an unverified download. Install the official CLI using [GitHub CLI instructions](https://cli.github.com/) or [InstaBox documentation](https://instabox.sh/docs), then retry.                                                                                                            |

## Stop using BoxCI

There is no automatic uninstall/teardown command. Review and perform cleanup explicitly:

1. Move affected jobs back to your intended runners and remove their BoxCI wake dependencies/jobs. Disable or remove the starter workflow through your normal PR process. Ensure no workflow still targets the pool, and let active jobs finish or cancel them.
2. Remove the dedicated repository runner registrations in GitHub settings and stop their services through official provider access.
3. Revoke the dedicated CI key through the official InstaBox tooling, then remove its GitHub Actions secret and selected pool variable after checking they are not shared by another workflow.
4. Review the dedicated VMs in the provider console and remove them manually only when no longer needed. Uninstalling the local npm CLI or closing the dashboard does not remove VMs or change provider usage.
5. After cloud cleanup, remove the local project record and any local candidate installation you no longer need.

Verify account, VM names and repository ownership throughout cleanup. Keep the record until the resources it identifies have been reviewed.
