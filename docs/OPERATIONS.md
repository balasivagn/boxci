# Operations and troubleshooting

Commands here assume `boxci` is available through `npm install -g @balasivagn/boxci` (or a source or locally packed installation), and you are in the target repository checkout. For monitoring from elsewhere, add `--repo owner/repository`; init and migration require that repository's matching checkout. See [installation and setup](../README.md#quick-start).

## Check the pool

```sh
boxci status
boxci doctor
boxci dashboard
boxci dashboard status
boxci dashboard stop
```

These commands read provider state and GitHub APIs without waking VMs or executing guest commands. The dashboard binds to `127.0.0.1`, uses an authenticated local browser session and serves assets locally. No SDK key reaches the browser. `boxci dashboard` starts a detached process and returns your terminal immediately. It remains available after that terminal closes. Running the command again reopens the same instance for this repository; it also restarts an instance from an older CLI version. Closing the browser has no effect on CI. The background server does not poll provider APIs when no browser is requesting status.

`boxci dashboard status` checks only the local process. `boxci dashboard stop` stops it without touching VMs, runner registrations, credentials or workflows. These commands use a separate authenticated local control connection; the browser API stays read-only. Add `--repo owner/repository` when running outside its checkout, including when GitHub is unavailable and repository inference cannot run.

Use `--no-open` to start without opening a browser, or `--foreground` to keep the dashboard in the terminal for debugging. Runtime records and logs are private files under the BoxCI data directory's `dashboards/` folder. Session/control tokens are not printed in terminal or JSON output; an explicitly requested `--session-file PATH` writes browser authorization information to a private file for local automation. Keep it out of source control.

The dashboard does not install an OS startup service and does not restart automatically after a reboot. Reopen it with `boxci dashboard`. If an old tab reports `ERR_CONNECTION_REFUSED`, run the command again and use the fresh tab it opens. Closing a foreground dashboard's terminal stops that instance.

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

If an older release fails with **Provider key metadata missing or invalid**, update the CLI and rerun `init` for the same repository. The saved VM and runner are reused. Current releases checkpoint credential requests before creation and recover their metadata through the official CLI. Keys created by an older release without a recorded request are left untouched; inspect `instabox keys ls` before deciding whether an unused key should be retired.

The terminal shows the target repository, saved runner names and active setup step. Colors and progress animation are enabled in interactive terminals; use `--no-color` to disable both, or `NO_COLOR=1` to disable colors. JSON and redirected output remain plain.

A new machine or changed `BOXCI_HOME` may have no record. Restore the private per-repository record from your previous data directory when available, then verify the account and run `status`/`doctor`. A record includes integration details that the repository pool variable cannot reconstruct. Without it, review [pool discovery](CONFIGURATION.md#pool-discovery-and-recovery) and the setup dry run. An existing `BOXCI_API_KEY` requires explicit `--secret BOXCI_API_KEY` to acknowledge reuse; a custom secret requires its actual name. Existing workflow files are never overwritten, so a lost record can require manual reconciliation rather than a new setup.

If a project lock remains after a crash, first verify that its owning setup process has exited. Only then remove the specific stale lock identified by the error. Never remove an active setup's lock.

## A job stays queued after wake

1. Inspect the wake job's logs in GitHub Actions to see whether it selected the self-hosted pool or hosted Ubuntu.
2. Run `boxci status` and check the repository's **Settings → Actions → Runners** for the selected label, connectivity and busy state.
3. Allow a resumed service time to reconnect. If all matching runners are busy, the job waits for capacity. If a running VM remains offline, inspect its runner service through the official provider tools.
4. After resolving connectivity, let the queued job start or cancel and rerun through GitHub as appropriate.

The wake helper checks active runner services, not GitHub connectivity. Hosted fallback is selected before assignment and cannot move a job already queued on a self-hosted label. `boxci wake` explicitly wakes the VMs; it does not repair registrations or change a queued job's routing.

## Common setup and workflow problems

| Problem                                                                | Action                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boxci: command not found`                                             | Run `npm install -g @balasivagn/boxci`, then put your npm global executable directory on `PATH`. See the README for the user-owned prefix option.                                                                                                                                                                                                                        |
| Cannot install the package                                             | Check npm registry connectivity and Node.js 22.19+ (22.x) or 24.5+. As a fallback, install from the source checkout or a local tarball.                                                                                                                                                                                                                                  |
| Sign-in is needed in automation                                        | Run `boxci init` interactively first. `--yes` skips plan confirmation, not service authentication.                                                                                                                                                                                                                                                                       |
| Account changed                                                        | Sign back into the account named by the project record. BoxCI refuses mutations across identities. Check `INSTABOX_API_KEY` if set as well as CLI sign-in.                                                                                                                                                                                                               |
| Repository admin access missing                                        | Use an account with repository admin permissions for runner registration, the CI secret and pool variable. Workflow files are edited locally.                                                                                                                                                                                                                            |
| Test commands or toolchains                                            | Configure these in your existing application workflows. Init creates no build/test jobs; `--command` is legacy metadata only.                                                                                                                                                                                                                                            |
| Existing secret requires explicit reuse                                | Verify the intended secret/account, then pass `--secret NAME` to preview and setup. This does not validate the stored secret's contents.                                                                                                                                                                                                                                 |
| Pool VM missing/renamed, label ambiguous or unmanaged runner shares it | Check the selected manifest against provider VM names and GitHub registrations. Use a dedicated custom label and reconcile the mapping before retrying.                                                                                                                                                                                                                  |
| `ci run` says publish the workflow first                               | Review the local workflow diff, then commit, push and merge through your normal process before dispatch. `--ref your-test-branch` explicitly chooses another ref, but [GitHub requires the dispatchable workflow on the default branch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#configuring-a-workflow-to-run-manually). |
| CI never runs on a push or a draft PR                                  | Your existing application workflow owns its triggers; the shared wake helper skips draft PRs. Review the caller YAML.                                                                                                                                                                                                                                                    |
| Migrated workflows or tests run twice                                  | Check for a legacy starter from an older release and remove it through your normal review. Init no longer creates or restores starter workflows.                                                                                                                                                                                                                         |
| Fork PR uses hosted Ubuntu                                             | Expected: untrusted fork code never receives the provider wake key.                                                                                                                                                                                                                                                                                                      |
| `migrate` finds no jobs                                                | Run in the target checkout. Only static `runs-on` jobs are scanned; starter/wake files and dynamic expressions are skipped. Review complex YAML manually.                                                                                                                                                                                                                |
| Bootstrap download/checksum failure                                    | Do not run an unverified download. Install the official CLI using [GitHub CLI instructions](https://cli.github.com/) or [InstaBox documentation](https://instabox.sh/docs), then retry.                                                                                                                                                                                  |

## HTTPS certificate trust and interrupted setup

BoxCI automatically adds the operating system's trusted certificates to Node's configured CA roots before making HTTPS requests, including when using the bundled official InstaBox CLI. Existing `NODE_EXTRA_CA_CERTS` configuration is preserved. No `NODE_OPTIONS` setting is needed. This uses [Node's certificate APIs](https://nodejs.org/docs/latest-v22.x/api/tls.html#tlssetdefaultcacertificatescerts), available in Node 22.19+ and 24.5+.

If your network's CA is not trusted by the operating system or your configured extra CA file, certificate verification still fails. Ask your network administrator to install the approved root certificate. Expired certificates and hostname mismatches are also rejected.

After a failed setup, keep the saved project record and rerun `boxci init --dry-run` from the same repository. Check that it says **Resume saved setup**, lists the existing runner, and plans no new VMs. Then rerun `boxci init` to approve completion. BoxCI rechecks the account, VM name and dedicated runner label before continuing. It preserves the VM and registration, creates a replacement credential when the previous secret was not transferred, and retires only recorded previous keys after successful delivery to GitHub.

## Stop using BoxCI

There is no automatic uninstall/teardown command. Review and perform cleanup explicitly:

1. Move affected jobs back to your intended runners: in each migrated workflow, restore the original `runs-on`, and remove `boxci-wake` from the job's `needs` and delete the `boxci-wake` job that `boxci migrate` added. Then remove the shared wake helper `.github/workflows/boxci-wake.yml` written by `init`, plus any legacy starter workflow (`.github/workflows/boxci.yml`) left by an older release, through your normal PR process. Ensure no workflow still targets the pool, and let active jobs finish or cancel them.
2. Remove the dedicated repository runner registrations in GitHub settings and stop their services through official provider access.
3. Revoke the dedicated CI key through the official InstaBox tooling, then remove its GitHub Actions secret and selected pool variable after checking they are not shared by another workflow.
4. Review the dedicated VMs in the provider console and remove them manually only when no longer needed. Uninstalling the local npm CLI or closing the dashboard does not remove VMs or change provider usage.
5. After cloud cleanup, remove the local project record and any local BoxCI installation you no longer need.

Verify account, VM names and repository ownership throughout cleanup. Keep the record until the resources it identifies have been reviewed.
