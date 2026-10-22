---
name: boxci-migrate
description: >-
  Move existing GitHub Actions jobs onto an InstaBox BoxCI pool after boxci init.
  Use when the user wants Blacksmith-like runs-on migration with wake-from-pause,
  or asks to retarget dev-test-*.yml workflows to InstaBox.
---

# BoxCI workflow migration

BoxCI provisions runners with `boxci init` (GitHub secret, pool variable, optional `boxci.yml` PR). To **retarget existing workflows** instead of only using the starter workflow, run **`boxci migrate`** from the **target repository checkout** (same machine that ran init).

## Prerequisites

- `boxci init` completed for this repo (pool + `BOXCI_API_KEY` + `BOXCI_POOL` on GitHub).
- Local project record exists (`boxci status` works).
- Git checkout of that repository.

## Interactive (recommended)

```sh
cd /path/to/your-app
boxci migrate
```

The CLI lists jobs with a **static** `runs-on` (e.g. `blacksmith-4vcpu-ubuntu-2404`, `ubuntu-latest`, `[self-hosted, macOS, ARM64, ci]`). Pick by number, `all`, or a substring such as `blacksmith`.

It **edits workflow files locally**:

- Adds a `boxci-wake` job (hosted Ubuntu, pool wake, same logic as `boxci.yml`).
- For each selected job: `needs: boxci-wake` (merged with existing `needs`) and `runs-on: ${{ fromJSON(needs.boxci-wake.outputs.runner) }}`.

Then: **review `git diff`**, commit, and push (or open your own PR).

## One-shot with init

```sh
boxci init --migrate-workflows
```

After setup finishes, runs the same interactive migration if a pool exists.

## Non-interactive

```sh
boxci migrate --dry-run --match blacksmith --yes    # plan only
boxci migrate --match blacksmith --yes              # apply all matching jobs
boxci migrate --jobs dev-test-backend.yml:install,dev-test-backend.yml:test --yes
```

## Agent guidance

- Do **not** hand-edit dozens of YAML files if `boxci migrate` can select them; run the CLI and let the user approve the plan.
- Migration is **deterministic** (no LLM required). Use the user's local model only for **choosing** which jobs to move if they prefer natural language — map their intent to `--match` or `--jobs`.
- Skips `boxci.yml` / `boxci-wake.yml` and jobs already using dynamic `runs-on`.
- Does not replace `boxci init` (runners, secrets, and pool variable still come from init).
- Matrix jobs and exotic `needs` shapes may need manual follow-up; inspect the diff.

## Verify

```sh
boxci doctor
boxci wake
# push branch, run a workflow or boxci ci run if boxci.yml is merged
```
