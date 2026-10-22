# Validation

v0.1.0, 23 October 2026. This record covers standalone BoxCI checks that require no live credentials.

## Automated coverage

Automated checks cover setup review/cancellation, existing pool adoption, PR response recovery, secret-transfer retry, account switching, dynamic quota, manifest updates on pool growth, passive paused status, unmanaged-label refusal, explicit branch dispatch, native CLI fallback, redaction, credential rotation ordering, dashboard authorization/origin/read-only enforcement and bootstrap checksums. Python wake/routing/pool tests cover `ci/wake.py`.

Regression coverage verifies fresh discovery of `BOXCI_POOL` and legacy `INSTABOX_CI_POOL`, current-name precedence, authoritative recorded names, reuse without provisioning, workflow variable selection, growth on the selected manifest and refusal of invalid manifests before mutations.

The pinned SDK is exercised against a local HTTP fixture. Provider and GitHub operations use injected transports; passive discovery/validation checks verify GET-only access without resuming paused VMs. Official-CLI transports cover authentication reuse, browser-auth return and cancellation.

## Standalone check results

- The Node suite reported 41 passes and two failures caused by sandbox denial of loopback socket binding (`listen EPERM` in the dashboard and SDK HTTP fixtures). Those two tests require an environment that permits local listeners; this record does not claim a complete Node pass.
- All 23 Python wake/routing/pool tests and Prettier checks passed.
- Package dry-run verification includes the documentation and architecture artifacts, and excludes scratch files, private state and development dependencies.

## Verification limits

Fresh cloud provisioning, key creation and missing-tool installation are exercised with injected transports. A brand-new account/provider consent flow and native Linux/Windows bootstrap still need verification. Browser sign-in remains delegated to official CLIs.

Manual dispatch prerequisites are documented against [GitHub's requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow#configuring-a-workflow-to-run-manually). Architecture diagram verification is recorded in [the architecture guide](ARCHITECTURE.md).

Live inventory, account state, job logs and browser session data belong in ignored `.orca-scratch/`, outside source and package artifacts.
