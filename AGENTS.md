# BoxCI

Standalone CLI-first GitHub Actions integration; InstaBox is the first provider. Do not modify external consumer repositories as a side effect of development here.

- Use official InstaBox CLI browser authentication and the official SDK. Never read credential-store files, implement another login, or print token values.
- `ci/wake.py` and `vendor/install.sh` are security-sensitive. Changes to wake/security behaviour need matching Python tests and workflow validation.
- Read-only monitoring must never execute guest commands, connect with SDK resume enabled, or wake VMs.
- Account ownership, VM names and dedicated runner labels must be checked before a mutation. Never replace registrations/directories or delete VMs to free quota.
- Keep source and tests here. Scratch/logs/live inventory go in ignored `.orca-scratch/`. Never commit private provider/GitHub/local state.
- Use `npm test`, `python3 -m unittest discover -s ci/tests`, `npm run check`, and `npm pack --dry-run`. These tests need no live credentials.
- `web/tokens.css` owns visual tokens. Browser data renders with textContent; maintain loopback binding, host/origin checks, authenticated sessions and the read-only API.
- Publishing `@balasivagn/boxci` to npm is a separate reviewed release step. The npm package remains private until then.
