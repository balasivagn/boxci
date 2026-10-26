<div align="center">

# BoxCI

**GitHub Actions runners on your own InstaBox VMs.<br>They wake up for CI and pause again when idle.**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node 22.19+ / 24.5+](https://img.shields.io/badge/node-22.19%2B%20%2F%2024.5%2B-339933.svg?logo=node.js&logoColor=white)](package.json)
[![npm version](https://img.shields.io/npm/v/@balasivagn/boxci.svg)](https://www.npmjs.com/package/@balasivagn/boxci)

[Quick start](#quick-start) · [Use your agent](#set-up-with-a-coding-agent) · [How it works](#how-it-works) · [Commands](#commands) · [Migrate](#migrate-existing-jobs) · [Limits](#limits) · [Docs](#docs)

</div>

---

BoxCI turns InstaBox VMs into dedicated GitHub Actions runners for your repository. Set up, migrate your existing CI, then run and monitor it, all from one CLI. No keepalive, no webhook server, no BoxCI account.

- **Reviewable.** `--dry-run` shows the plan. Workflow changes stay local for you to review, commit and push.
- **Migrates existing CI.** `boxci migrate` retargets jobs (Blacksmith, `ubuntu-latest`) as a local diff.
- **Agent-ready.** Paste one prompt, or use the bundled [migration skill](skills/boxci-migrate/SKILL.md).
- **Safe fallback.** Fork PRs, or a pool that isn't ready, run on hosted `ubuntu-24.04`. Fork code never sees your provider key.
- **Read-only dashboard.** `boxci dashboard` is local and authenticated, and never wakes a VM.

## Quick start

Needs Node.js `^22.19.0 || >=24.5.0`, Git, admin on a GitHub repo, and an InstaBox account with room for one more VM.

```sh
npm install -g @balasivagn/boxci
cd /path/to/your-app          # the repo whose CI you want to change

boxci init --dry-run          # preview, creates nothing
boxci init                    # approve the plan; writes .github/workflows/boxci-wake.yml
boxci migrate                 # pick existing jobs to move onto the pool
```

`init` and `migrate` only edit files locally. They never create a branch, commit, push or PR. Review `git diff -- .github/workflows`, commit and push it your usual way, merge to the default branch, then:

```sh
boxci ci run --workflow ci.yml
boxci status
```

<details>
<summary>Install tips</summary>

<br>

- **Older Node:** npm only warns (`EBADENGINE`). `--version` and `--help` work, but setup stops with a certificate-trust error. Check `node --version` first.
- **`boxci: command not found`:** put npm's global bin on `PATH`, or install to a user prefix:

  ```sh
  npm install -g --prefix "$HOME/.local" @balasivagn/boxci
  export PATH="$HOME/.local/bin:$PATH"
  ```

- **Update:** rerun the install command.
- **Unreleased `main`:** `npm install -g https://github.com/balasivagn/boxci/archive/refs/heads/main.tar.gz` (swap `refs/heads/main` for a commit SHA to pin).
- **Pick the repo:** `--repo owner/repository`. `init` and `migrate` still need a checkout with a matching GitHub remote.
- **Test commands and toolchains** live in your own workflows. Init generates no test job.
- **Interrupted?** Rerun `boxci init`; it resumes. On an already-configured repo it reports "Already configured" and changes nothing.
- **HTTPS certificates:** system certificates are used automatically. See [certificate trust](docs/OPERATIONS.md#https-certificate-trust-and-interrupted-setup).
- **Existing pool?** Dry run first, and read [pool discovery and recovery](docs/CONFIGURATION.md#pool-discovery-and-recovery).

</details>

## Set up with a coding agent

Open your app's checkout in any agent with terminal access and paste:

```text
Set up BoxCI for this application's repository; use https://github.com/balasivagn/boxci as the documentation reference. Install `npm install -g @balasivagn/boxci`, check `boxci --version`, and run all setup and migration commands from this application's checkout. Reuse my current GitHub/InstaBox sign-ins and show me `boxci init --dry-run` with the target repository for approval before applying. Then complete setup, migrate compatible existing Linux x64 CI jobs with `boxci migrate`, preserve existing pools, verify with `boxci doctor` and `boxci status`, and leave all workflow changes locally for my review. Do not commit, push, or open a PR.
```

You complete the browser sign-ins and approve the plan.

## How it works

![BoxCI architecture: local setup, hosted wake routing, and passive monitoring](docs/architecture/boxci.svg)

1. **Wake.** A hosted Ubuntu job wakes every pool VM for trusted events and checks their runner services. It never checks out PR code.
2. **Route.** Pool ready: the build targets your dedicated self-hosted label. Otherwise, and always for fork PRs, it uses hosted `ubuntu-24.04`.
3. **Run.** GitHub assigns the build to an idle runner. Afterwards the VMs follow InstaBox's normal idle suspension.

More: [architecture and source map](docs/ARCHITECTURE.md) · [interactive diagram](docs/architecture/boxci.html) (download and open locally)

## Commands

| Command                       | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `boxci init`                  | Set up runner, secret and pool variable; write the wake helper   |
| `boxci migrate`               | Move existing workflow jobs onto the pool                        |
| `boxci ci run`                | Dispatch a connected workflow (`--workflow file.yml`, `--ref`)   |
| `boxci status`                | VM and runner states, recent jobs (passive)                      |
| `boxci doctor`                | Check account, quota, mapping, merge state, key expiry           |
| `boxci dashboard`             | Start or reopen the background read-only dashboard               |
| `boxci dashboard status/stop` | Check or stop the dashboard; runners are unaffected              |
| `boxci wake`                  | Explicitly wake the pool                                         |
| `boxci pool add --count 1`    | Add a VM, within your quota                                      |
| `boxci auth renew`            | Rotate the 30-day CI credential                                  |
| `boxci help [command]`        | Help for boxci or one command (also `--help`, `-h`, `--version`) |

Flags: `--dry-run` previews any change, `--yes` skips the prompt, `--json` gives structured output, `--repo` selects the repository. `status`, `doctor` and `dashboard` never run guest commands or wake VMs.

The dashboard keeps running after you close the terminal and doesn't restart on reboot. `--no-open` skips the browser, `--foreground` is for debugging, `--port N` chooses the local port (0-65535; the default, 0, picks a free port; stop a running dashboard first to change it). See [dashboard operations](docs/OPERATIONS.md#check-the-pool).

## Migrate existing jobs

```sh
boxci migrate --match blacksmith --dry-run
boxci migrate --match blacksmith
```

No flags picks jobs interactively; `--jobs file.yml:job,...` names them; `boxci init --migrate-workflows` migrates right after setup. Rerunning reuses the existing pool and helper.

The wake logic lives in `.github/workflows/boxci-wake.yml`. Your workflow calls it, and chosen jobs consume its output:

```yaml
jobs:
  boxci-wake:
    uses: ./.github/workflows/boxci-wake.yml
    with:
      pool: ${{ vars.BOXCI_POOL }}
      runner-label: your-boxci-label
    secrets:
      api-key: ${{ secrets.BOXCI_API_KEY }}
  test:
    needs: boxci-wake
    runs-on: ${{ fromJSON(needs.boxci-wake.outputs.runner) }}
```

Commit the helper and its callers together. To have your agent do it, point it at [`skills/boxci-migrate/SKILL.md`](skills/boxci-migrate/SKILL.md) and ask, e.g. "move our Blacksmith test jobs onto BoxCI".

- `--match` is a case-insensitive regular expression tested against each job's static `runs-on`. `--jobs` wins over `--match`. Dynamic expressions are skipped.
- Pick Linux x64 jobs that also work on the hosted fallback. Check matrix jobs and complex `needs` by hand.
- Only scheduling changes. Toolchains, services and caches stay as they are.
- Generated inline wake blocks can be extracted. Customized ones and conflicting helper files need manual review.
- A starter workflow left by an older release is kept as a legacy file. Remove it yourself if redundant.

## Limits

- **Requirements:** GitHub.com repo with admin access and Actions enabled. Paused VMs still count toward InstaBox quota. Existing GitHub and InstaBox sign-ins are reused; BoxCI bundles the InstaBox CLI and can install a checksum-verified GitHub CLI privately.
- **Use a dedicated InstaBox account for CI.** The CI key can run commands on every VM in its account.
- **Capacity:** one job per runner. Up to five VMs, within quota. More VMs help only with multiple jobs or a matrix. BoxCI never deletes another VM to free quota.
- **Cost and speed:** no promises. BoxCI charges nothing, but InstaBox usage and hosted wake/fallback jobs bill as usual, and there is no spending cap. See InstaBox [limits](https://instabox.sh/docs/limits).
- **Credential expires every 30 days** with no automatic renewal. `boxci doctor` warns within seven days; run `boxci auth renew`. If it lapses, jobs fall back to hosted Ubuntu. See [renewing](docs/OPERATIONS.md#renew-the-ci-credential).
- **Queued job after wake:** runner readiness doesn't prove GitHub connectivity, and fallback is chosen before assignment, so it can't rescue a job already queued. See [troubleshooting](docs/OPERATIONS.md#a-job-stays-queued-after-wake).
- **Status:** v0.4.1, early. POSIX shell commands only; native Linux/Windows bootstrap is unverified ([validation](docs/VALIDATION.md)). No automatic uninstall; see [stop using BoxCI](docs/OPERATIONS.md#stop-using-boxci).
- **Affiliation:** independent open source. Not built or endorsed by InstaBox, and not affiliated with boxci.dev.

## Docs

| Guide                                  | Covers                                                |
| -------------------------------------- | ----------------------------------------------------- |
| [Configuration](docs/CONFIGURATION.md) | Sign-in, local records, repo settings, pool discovery |
| [Operations](docs/OPERATIONS.md)       | Renewal, adding capacity, recovery, troubleshooting   |
| [Architecture](docs/ARCHITECTURE.md)   | Setup, CI and monitoring paths                        |
| [Validation](docs/VALIDATION.md)       | What is tested and what isn't                         |
| [Releasing](docs/RELEASING.md)         | npm trusted publishing, GitHub releases               |
| [Security](SECURITY.md)                | Credential scope and isolation limits                 |

## Contributing

Ideas, feature requests and collaboration are welcome: [open an issue](https://github.com/balasivagn/boxci/issues/new). Tests need no live credentials.

```sh
git clone https://github.com/balasivagn/boxci.git
cd boxci && npm ci
npm test
python3 -m unittest discover -s ci/tests
npm run check
npm pack --dry-run
```

`ci/wake.py` and `vendor/install.sh` are security-sensitive; changes need matching Python tests (see [AGENTS.md](AGENTS.md)). Keep scratch files in the ignored `.orca-scratch/`. More: [developer experience](docs/DEVELOPER_EXPERIENCE.md) · [design tokens](docs/DESIGN.md) · [project site](docs/SITE.md).

## License

[Apache-2.0](LICENSE). Third-party notices in [NOTICE](NOTICE) and `vendor/`. Provider tools and vendored fonts keep their own licenses.
