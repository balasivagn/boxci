# Security model

- Provider browser auth is delegated to the official InstaBox CLI. The app never reads or duplicates its credential store. GitHub auth remains in `gh`.
- A local CLI API-key environment uses the official InstaBox SDK for VM operations; `Sandbox.connect(..., {resume:false})` is used for passive connections. Credentials are never sent to the browser.
- New CI keys have only `machines:read` and `machines:write`, expire after 30 days, and are validated against the selected account/VM before secret transfer. These scopes cover command execution across the whole account. They do not provide per-VM isolation.
- Values travel through process stdin or environment, never shell arguments, logs or saved configuration. Local checkpoints contain only resource and key identifiers/expiry. Files use private permissions and atomic replacement.
- Account changes are refused before setup mutations. A dedicated label must resolve exactly to the reviewed pool, with distinct VM IDs and runner names. Provider names are checked before executing setup scripts.
- Installer packages come from the scope-specific GitHub runner version and require its published SHA-256. Existing directories and registrations are never replaced. Commands are not retried blindly.
- A failed key transfer records its orphan identifier without saving the secret. A reviewed retry retires it before recreating. Renewal preserves the old working key until the new key is validated and installed; failed retirement is recorded for follow-up.
- Dashboard: loopback binding, host/origin checks, authenticated browser session, HttpOnly/SameSite cookie, local assets, restrictive CSP, no mutation API. URLs are restricted to GitHub for outbound job links. Rendered data uses `textContent`.
- Wake CI uses the existing tested Python helper, fixed provider endpoint, no credential-forwarding redirects, bounded retries/deadlines and no PR checkout in the privileged phase. Forks never invoke cloud wake. Hosted fallback happens before assignment.
- No deletion, snapshotting, secret delivery, background alerting or periodic keepalive feature is installed.

This candidate is not a public service. Report security concerns privately to the repository owner. Do not post credentials in issues.
