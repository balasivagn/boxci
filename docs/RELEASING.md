# Publishing BoxCI to npm

The [Publish to npm workflow](../.github/workflows/publish.yml) publishes `@balasivagn/boxci` when a maintainer publishes a stable GitHub release in `balasivagn/boxci`. Normal pushes and pull requests do not publish. Manually running this workflow validates the package with `npm publish --dry-run` and never uploads it.

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

Open [Actions → Publish to npm](https://github.com/balasivagn/boxci/actions/workflows/publish.yml), choose **Run workflow**, and select the branch to validate. This checks package identity, formatting, JavaScript/Python tests and package contents, then performs a dry-run publish. It does not validate the npm trust connection; that exchange happens during a real publish.

## Publish a reviewed version

1. On the intended release branch, bump the version in both package files with `npm version patch --no-git-tag-version` (or choose `minor`/`major`). Review and commit the version change alongside the release contents.
2. Push the reviewed commit and wait for **Check** to pass.
3. Create and publish a GitHub release with a tag exactly matching `v<package.json version>`, targeting that reviewed commit. For example, version `0.1.1` requires `v0.1.1`. Publishing the release is the explicit publish decision; a draft release does not upload a package.
4. The workflow checks the tag/version match, runs the checks again on that release's source, and publishes publicly to npm's `latest` tag. Prereleases are skipped.
5. Check the completed workflow, then verify the public package with `npm view @balasivagn/boxci version` and a fresh `npm install -g @balasivagn/boxci`. Run `boxci --help` before testing setup.

npm versions cannot be overwritten. If a publish completed but a later step or client response failed, check the registry before rerunning. If the version already exists, prepare a new version for further changes. A trust mismatch or staged-only publisher permission must be corrected in npm; do not add a token to bypass it.
