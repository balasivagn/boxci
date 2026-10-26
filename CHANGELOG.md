# Changelog

Notable changes to `@balasivagn/boxci`. Releases are published from GitHub releases; see [docs/RELEASING.md](docs/RELEASING.md). Dates are in Singapore time (UTC+8).

## 0.4.1 (27 Oct 2026)

### Fixed

- **InstaBox sign-in when signed out.** When `instabox whoami --json` fails with an empty stderr, BoxCI now reads the error message from the JSON on stdout (only that message, never the rest of stdout), so "not logged in" is recognised as needing sign-in instead of failing with `<path>/node exited 1`. In a terminal the official login flow starts. Without a terminal, the error says to run `instabox login`. ([#5](https://github.com/balasivagn/boxci/pull/5), merged 25 Oct 2026)
- **Repository inference without the GitHub CLI.** If `gh repo view` fails (for example, `gh` is signed out), the repository is read from the checkout's GitHub `git remote`, preferring `origin`. Several GitHub remotes or no GitHub remote now give specific errors suggesting `--repo`, instead of "Run inside a Git checkout". Remote URLs are never printed. ([#5](https://github.com/balasivagn/boxci/pull/5), merged 25 Oct 2026)
- **Credentialed GitHub remotes.** `init` and `migrate` accept GitHub HTTPS remotes with credentials (`https://user[:token]@github.com/owner/repo`), as produced by git `insteadOf` rewrites. Look-alike hosts are still rejected, and credentials are never printed. ([#3](https://github.com/balasivagn/boxci/pull/3), merged 25 Oct 2026)

### Added

- **Per-command help.** `boxci <command> --help`, `-h` and `boxci help [command]` show help for that command with only the flags it reads. `boxci version --help`, `boxci version -h` and `boxci help version` show the version help page instead of printing the version. `boxci help` with an unknown command, or an unknown subcommand of a command group (for example `boxci help pool frob`), exits with "Unknown command". ([#6](https://github.com/balasivagn/boxci/pull/6), merged 26 Oct 2026)
- **Help text.** `--port N` (dashboard local port, 0-65535; 0 picks a free port) is documented. `--match` is described as a case-insensitive regular expression (`--match REGEX`) instead of "contains TEXT". The first line of `boxci --help` links to https://github.com/balasivagn/boxci instead of saying "not boxci.dev". ([#6](https://github.com/balasivagn/boxci/pull/6), merged 26 Oct 2026)
- **Welcome message.** Bare `boxci` prints a short welcome with setup and migration steps; `boxci --help` still lists every command. ([c2f18c0](https://github.com/balasivagn/boxci/commit/c2f18c0426241c4980c3b71b68dd28ad31e26ed9), 25 Oct 2026)

### Documentation

- README states the Node.js requirement (`^22.23.4 || >=24.22.1`) at the start of the Quick start. The architecture guide and "Stop using BoxCI" describe the shared wake helper and what `migrate` changes (including the `permissions:` block it may add) instead of the old starter workflow. The dead boxci.dev link is removed. ([#4](https://github.com/balasivagn/boxci/pull/4), merged 26 Oct 2026)
- docs/VALIDATION.md records the v0.4.0 validation run: local checks against tag `v0.4.0` and the hosted Check results. ([#2](https://github.com/balasivagn/boxci/pull/2), merged 25 Oct 2026)
- Contributing guide, code of conduct and issue/PR templates. ([#1](https://github.com/balasivagn/boxci/pull/1), merged 25 Oct 2026)

### Tests

- Shared `isolateGitConfig` test helper (`tests/helpers/git-config.js`). It gives git-based tests an empty temporary global git config, so a machine-level `insteadOf` (for example one that adds a token) cannot change their remotes. It isolates at most once per test, so #3's tests stay safe when combined with #5, and it restores the environment afterwards. ([#5](https://github.com/balasivagn/boxci/pull/5))
