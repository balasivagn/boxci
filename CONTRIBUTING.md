# Contributing to BoxCI

Thanks for helping improve BoxCI. Issues and pull requests are welcome.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security issues

Do not report security problems in public issues, and never post credentials, API keys, tokens or private logs. Read [SECURITY.md](SECURITY.md) and report security concerns privately to the repository owner.

## Development setup

You need Node.js 22.19+ (22.x) or 24.5+ (see `engines` in [package.json](package.json)), Python 3 and Git. The test suites need no live InstaBox or GitHub credentials.

```sh
git clone https://github.com/balasivagn/boxci.git
cd boxci
npm ci
```

## Checks

Run all four checks before opening a pull request:

```sh
npm test
python3 -m unittest discover -s ci/tests
npm run check
npm pack --dry-run
```

- `npm test` runs the Node test suite in `tests/` with `node --test`. Tests use injected transports and local HTTP fixtures, so they need permission to bind loopback sockets.
- `python3 -m unittest discover -s ci/tests` runs the Python tests for the wake helper, `ci/wake.py`.
- `npm run check` verifies formatting with the pinned Prettier version. Run `npm run format` to fix formatting.
- `npm pack --dry-run` lists the files that would be published. Check that no scratch files or private state are included.

The [Check workflow](.github/workflows/check.yml) runs `npm ci --ignore-scripts`, `npm run check`, `npm test`, the Python tests and `npm pack --dry-run` on Node 22.19.0, 22, 24.5.0 and 24 for every push and pull request. It also runs the dashboard tests on macOS and exercises the shared wake workflow.

To try a packed build locally, create the tarball in `dist/` and install it globally with `npm install --global` and the path of the `.tgz` file it prints:

```sh
mkdir -p dist
npm run pack:local
```

## Guidelines

[AGENTS.md](AGENTS.md) holds the project rules. In particular:

- `ci/wake.py` and `vendor/install.sh` are security-sensitive. Changes to wake or security behaviour need matching Python tests and workflow validation.
- Use the official InstaBox CLI browser authentication and the official SDK. Never read credential-store files, add another login flow, or print token values.
- Read-only monitoring must never execute guest commands, connect with SDK resume enabled, or wake VMs.
- Keep live inventory, logs and scratch files in the ignored `.orca-scratch/` directory. Never commit private provider, GitHub or local state.
- `web/tokens.css` owns visual tokens. Browser data renders with `textContent`.

Background reading: [architecture](docs/ARCHITECTURE.md), [developer experience contract](docs/DEVELOPER_EXPERIENCE.md), [design tokens](docs/DESIGN.md) and [validation coverage](docs/VALIDATION.md).

## Pull requests

- Keep each pull request focused on one change and describe what it changes and why.
- Add or update tests for behaviour changes.
- Update the README or `docs/` when user-facing behaviour changes.
- Make sure the four checks above pass locally and in the Check workflow.

Publishing a new `@balasivagn/boxci` version to npm is a separate reviewed release step; see [releasing](docs/RELEASING.md). Pull requests should not publish packages.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
