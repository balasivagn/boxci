# Developer experience contract

The developer supplies a repository and a real test command only when it cannot be inferred. Account IDs, machine IDs, package checksums, runner registration tokens, workflow routing, provider keys and GitHub secret transfer are handled by the tool.

## Entry point

`boxci init` inside a Git checkout. `boxci migrate` (or `init --migrate-workflows`) rewrites selected existing workflow jobs in that checkout to add `boxci-wake` and dynamic `runs-on`; review the git diff before push. Existing `gh` context identifies the repository. `--repo` is the escape hatch; never silently select another repository. Before a cloud mutation, display the provider account, target repository, VM count/quota, credential scope and exact actions, then ask for one approval. `--dry-run` and `--yes` support automation.

An existing provider session needs no browser visit. Otherwise delegate directly to `instabox login`: the official CLI owns the callback server and returns to the waiting command. GitHub does the same through `gh auth login --web`. These are two independently controlled services; BoxCI cannot remove their consent steps. It should never add a third login. User cancellation or a timeout returns an actionable error; it must not loop or open repeated browser tabs.

InstaBox's official npm CLI is bundled as a fallback. GitHub CLI is reused or downloaded from its official release, verified against its official SHA-256, and stored privately. No Homebrew/admin step is required on supported platforms. A network/bootstrap failure explains the official manual fallback.

## Existing pools

Setup can adopt a verified pool from the saved local project record or from a repository Actions variable when runners, labels and VM IDs still match. A recorded `pool_variable` is authoritative. Otherwise discovery checks `BOXCI_POOL`, then the legacy `INSTABOX_CI_POOL` only if the current name is absent. The selected name is retained for workflow generation and growth; invalid manifests stop setup rather than falling through to another pool.

A complete record preserves the existing integration. A bare repository variable identifies VM/runner membership, not workflow completion or credential metadata; setup must still review the remaining integration actions. It preserves existing services, keys and consumer workflows when `managed_workflow` is false. See [configuration](CONFIGURATION.md#pool-discovery-and-recovery) and [recovery](OPERATIONS.md#setup-was-interrupted-or-the-local-record-is-missing).

## Recovery

The project lock prevents concurrent setup writes. Checkpoints are saved after VM creation, runner installation, workflow upload, credential installation and PR creation. A retry checks which resources already exist. Owned VMs can be recovered after a lost create response. A registered pending runner must prove its name/repository and active service in its recorded VM before being adopted. Unregistered partial directories are never overwritten; the error identifies the next inspection step.

Credential values are deliberately not checkpointed. An orphan key identifier is retained and can be retired on reviewed retry. PR failures reuse the uploaded workflow and installed secret. Renewal saves pending identifiers, installs the new key first, and retires recorded old keys afterwards.

## Daily use

Status and dashboard are passive. Paused is a valid VM state; offline is a separate GitHub observation. CPU/RAM figures describe allocations, not invented live measurements. Queue counts describe only fetched recent jobs. API failures remain visible errors, not a fabricated healthy/offline state. Recent jobs are paginated and bounded.

`boxci pool add` checks current account quota. It never deletes another VM to make room. It updates the actual variable consumed by the workflow. Additional VM capacity does not automatically parallelize a single build job.

## Distribution gates

BoxCI is distributed on npm as `@balasivagn/boxci`; source and packed installs also work. See [releasing](RELEASING.md) for the publication workflow. Linux/Windows live bootstrap and fresh-account browser authentication require their own environment verification; injected tests do not substitute for those claims.
