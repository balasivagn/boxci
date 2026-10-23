# Configuration and authentication

Start with the [Quick start](../README.md#quick-start). This reference explains what setup stores and how later commands find it.

## Authentication on your machine

| Service  | Authentication                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| InstaBox | Reuses the official `instabox` session or starts its official login flow. `--provider google` and `--device` are available when sign-in is needed.                      |
| GitHub   | Reuses `gh` or starts `gh auth login --web`. Repository admin access is required for runner registration and repository settings. Workflow edits stay local for review. |

No separate BoxCI account or manual token copying is required. BoxCI never reads the provider's credential-store files or prints keys. The official InstaBox npm CLI is bundled as a fallback. When `gh` is missing, BoxCI can download an official release, verify its SHA-256, and install it privately without administrator access.

`BOXCI_HOME` overrides the local data directory. `INSTABOX_API_KEY`, when set, selects SDK-backed provider reads and VM operations; official CLI authentication is still used for key management. Avoid switching provider identities between these paths. Do not put credentials in repository files or command-line arguments.

## Local project record

There is no checked-in connection file. Setup stores a private JSON project record per repository under the application data directory:

- macOS: `~/Library/Application Support/BoxCI/projects/`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/boxci/projects/`
- Windows: `%LOCALAPPDATA%\BoxCI\projects\` (home directory fallback)

Records contain account identities, VM IDs, runner names, the routing label, secret/variable names, workflow path, legacy PR/branch information and local workflow delivery status, test command, key identifiers/expiry and recovery checkpoints. Secret values are never saved. Keep these records private and outside source control. Older `InstaBox CI` / `instabox-ci` records are still read when present.

Status, doctor, dashboard, growth and renewal rely on this record as well as live APIs. Preserve it when moving your setup to another machine; changing `BOXCI_HOME` selects a different record directory. See [recovery](OPERATIONS.md#setup-was-interrupted-or-the-local-record-is-missing).

## Repository settings

Setup targets one GitHub repository:

| Setting             | Default                       | Role                                                                                                                                                                 |
| ------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actions secret      | `BOXCI_API_KEY`               | 30-day machine read/write credential used by the wake job. Choose a different name with `--secret NAME`. Its permissions cover all VMs in the provider account.      |
| Actions variable    | `BOXCI_POOL`                  | JSON array of pool members with `machine_id`, `runner_name` and `expected_name`. Growth updates the same selected variable. Legacy pools may use `INSTABOX_CI_POOL`. |
| Workflow            | `.github/workflows/boxci.yml` | Hosted wake job followed by one build job. Setup writes the workflow locally; review, commit and push it.                                                            |
| Runner registration | One per VM                    | Repository-level runner with a dedicated shared label, defaulting to `boxci-` plus a repository hash. Override with `--label`.                                       |

An existing secret cannot be read back to verify its account or contents. If setup asks for explicit reuse, inspect the intended integration and pass `--secret BOXCI_API_KEY` (or its actual name) only when appropriate. Setup does not overwrite an existing secret during this reuse; `auth renew` is the explicit rotation path.

## Pool discovery and recovery

Discovery uses these rules:

1. A saved project record's `pool_variable` is authoritative, including a custom or legacy name.
2. Without a recorded variable name, check `BOXCI_POOL` first.
3. Only when `BOXCI_POOL` is absent, check `INSTABOX_CI_POOL`.
4. If neither exists, plan a new pool using `BOXCI_POOL`.

If both names exist without a recorded choice, `BOXCI_POOL` wins. A malformed or mismatched selected manifest is an error; BoxCI does not silently switch to the other pool. Before reuse, VM names, account visibility, distinct runner registrations and the dedicated label must match. An ambiguous label requires `--label`.

A complete local record lets `init` reuse its integration without replacing services, keys or workflows. A repository variable alone identifies **pool members**, not a completed integration: it cannot recover a custom secret name, workflow path, test command or key expiry. Setup can reuse verified VMs but may still plan a local workflow and credential setup. It refuses to overwrite a different local starter workflow. On a new machine, restore your private project record when available; otherwise inspect `init --dry-run` before approving any setup. If the chosen secret already exists, explicit `--secret NAME` is required even for the preview.

### Using a different signed-in InstaBox account

When the saved pool belongs to another account, `init` reuses the current valid sign-in and offers a fresh setup plan. `boxci init --dry-run` previews it; normal `init` asks before applying, and `--yes` approves the displayed plan in automation. Declining or previewing leaves all records and resources unchanged.

On approval, BoxCI saves the complete previous record under `projects/archive/<repository>/<account-id>/<revision>.json` before replacing the active local record. The plan displays the exact archive path, which is also retained as `previous_project.archive_path` in the new record. Legacy source records remain in place. Archive files have the same private permissions as active records; keep them outside source control.

The fresh pool uses account-specific runner names, a dedicated routing label, `BOXCI_POOL_<suffix>`, `BOXCI_API_KEY_<suffix>` and `.github/workflows/boxci-<suffix>.yml`. An explicit `--secret` must name an unused secret. Existing VMs, runner registrations, secrets, variables and workflows are preserved. Review the new local workflow alongside the previous workflow: both can run until you separately retire the old integration. Switching accounts does not transfer or delete provider resources. Wake, growth and credential renewal still require the active record's account.

## Runner labels and workflow selection

GitHub schedules by `runs-on` labels, not VM name. Every member shares a dedicated custom label. The generated and migrated build jobs use:

```yaml
needs: boxci-wake
runs-on: ${{ fromJSON(needs.boxci-wake.outputs.runner) }}
```

The wake job selects either the shared self-hosted label set or hosted Ubuntu. A single build uses one runner; independent jobs or matrix entries use multiple members. Pool growth does not parallelize one job.

The starter installs Node 24 and, when detected from `packageManager`, pnpm. npm/pnpm test inference reads `package.json` on the target repository's default branch, not uncommitted local files. `--command` changes the shell command, not other language/toolchain setup or Node version. Review the local workflow diff for those changes.

Migration edits selected workflows in the current checkout. `--repo` chooses the configured pool; it does not change which directory is edited. Always run migration from the target repository's own checkout.

## Local workflow review

`init` and `migrate` write workflow changes into the target checkout. They do not create a Git branch, commit, push or open a PR. `--repo` selects GitHub metadata; it does not select a different local folder. Both commands verify a matching GitHub remote and recheck reviewed files before writing. Setup refuses symlinked workflow paths and preserves existing local changes.

`init` still performs the cloud actions in its approved plan: create or reuse the VM/runner pool, install the CI secret and set the pool variable. Its completed checkpoint is `ready_to_commit`. `status`, `doctor` and the dashboard show when the starter workflow is missing from the default branch; review, commit and push it through your normal process. The normal `ci run` dispatch requires the workflow on the default branch.

Older saved branches and PR identifiers remain in private records. Retrying an incomplete older setup writes its starter workflow locally and reuses its VM and runner; it does not update, close or replace the existing remote branch or PR. Review any existing PR yourself to avoid duplicate workflow changes.
