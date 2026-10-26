# Publishing BoxCI to npm

The [Publish to npm workflow](../.github/workflows/publish.yml) publishes `@balasivagn/boxci` when a push to `main` carries a version npm does not have yet, or when a maintainer publishes a stable GitHub release in `balasivagn/boxci`. Pull requests never publish. Manually running this workflow validates the package with `npm publish --dry-run` and never uploads it.

## One-time npm connection

In the package's [npm settings](https://www.npmjs.com/package/@balasivagn/boxci/access), add a **GitHub Actions trusted publisher** with these exact values:

| Setting              | Value                                                       |
| -------------------- | ----------------------------------------------------------- |
| Organization or user | `balasivagn`                                                |
| Repository           | `boxci`                                                     |
| Workflow filename    | `publish.yml` (filename only)                               |
| Environment          | Leave blank; the workflow does not use a GitHub environment |
| Allowed actions      | Enable direct publishing with `npm publish`                 |

The npm account owner completes any required 2FA in npm. No `NPM_TOKEN` or `NODE_AUTH_TOKEN` secret is needed in GitHub. The workflow uses Node 24, npm's OIDC authentication and GitHub-hosted Ubuntu; provenance is generated automatically. See [npm's trusted publishing guide](https://docs.npmjs.com/trusted-publishers/) for requirements and troubleshooting. A newly configured publisher must complete its first publish within two days or be recreated.

## Validate without publishing

Open [Actions → Publish to npm](https://github.com/balasivagn/boxci/actions/workflows/publish.yml), choose **Run workflow**, and select the branch to validate. This checks package identity, formatting, JavaScript/Python tests and package contents, then performs a dry-run publish. Only this manual path assigns a temporary `validation.<run-id>.<attempt>` prerelease version inside the disposable CI checkout so npm will accept a preview even when the source version is already published. Nothing is uploaded or tagged in Git. It does not validate the npm trust connection; that exchange happens during a real publish.

## Publish a reviewed version

Merging to `main` publishes. The PR review is the release decision.

1. On the release branch, bump the version in both package files with `npm version patch --no-git-tag-version` (or choose `minor`/`major`). Set the date in `CHANGELOG.md`. Review and commit the version change alongside the release contents.
2. Open a PR and wait for **Check** to pass. Protect `main` so only reviewed PRs with passing checks can merge.
3. Merge. The workflow runs on the push to `main`. If `package.json` has a version npm does not have yet, it runs the checks again on that commit and publishes publicly to npm's `latest` tag, then creates the `v<version>` GitHub release and tag. If the version is already on npm, it does nothing, so merges without a bump do not publish.
4. Check the completed workflow, then verify the public package with `npm view @balasivagn/boxci version` and a fresh `npm install -g @balasivagn/boxci`. Run `boxci --help` before testing setup.

Publishing a GitHub release by hand with a tag exactly matching `v<package.json version>` still works as a fallback; the workflow checks the tag/version match and skips prereleases and drafts.

The [Release drift](../.github/workflows/release-drift.yml) workflow warns when `main` has changes to packaged files without a version bump, or a version npm does not have, and fails daily until it is resolved.

npm versions cannot be overwritten. If a publish completed but a later step or client response failed, check the registry before rerunning. If the version already exists, prepare a new version for further changes. A trust mismatch or staged-only publisher permission must be corrected in npm; do not add a token to bypass it.
