# Security model

- Provider browser auth is delegated to the official InstaBox CLI. The app never reads or duplicates its credential store. GitHub auth remains in `gh`.
- A local CLI API-key environment uses the official InstaBox SDK for VM operations; `Sandbox.connect(..., {resume:false})` is used for passive connections. Credentials are never sent to the browser.
- Local HTTPS uses Node's configured CA roots plus the operating system's trusted roots, including configured extra CA certificates. Certificate and hostname verification remain enabled. BoxCI does not install certificates, change the system trust store or retry cloud mutations after TLS failures.
- New CI keys have only `machines:read` and `machines:write`, expire after 30 days, and are validated against the selected account/VM before secret transfer. These scopes cover command execution across the whole account. They do not provide per-VM isolation.
- CI credential values travel through process stdin or environment, never shell arguments, logs or saved configuration. Local project checkpoints contain only resource and key identifiers/expiry. Files use private permissions and atomic replacement.
- Account changes are refused before setup mutations. A dedicated label must resolve exactly to the reviewed pool, with distinct VM IDs and runner names. Provider names are checked before executing setup scripts.
- Workflow generation and migration leave local diffs in a matching Git checkout. They do not create remote branches, commits or PRs. Reviewed contents and regular workflow paths are rechecked before writes; existing local edits are preserved.
- Installer packages come from the scope-specific GitHub runner version and require its published SHA-256. Existing directories and registrations are never replaced. Commands are not retried blindly.
- A failed key transfer records its orphan identifier without saving the secret. A reviewed retry retires it before recreating. Renewal preserves the old working key until the new key is validated and installed; failed retirement is recorded for follow-up.
- Dashboard: background worker with private runtime records/logs; process control uses a separate loopback connection authenticated with an independent random key, instance identity and signed request/response nonces. The control key is never sent to a potentially stale local port. Stop never signals a PID from a saved record. Browser HTTP routes retain loopback binding, host/origin checks, authenticated browser session, HttpOnly/SameSite cookie, local assets, restrictive CSP, no mutation API. URLs are restricted to GitHub for outbound job links. Rendered data uses `textContent`.
- Wake CI uses the existing tested Python helper, fixed provider endpoint, no credential-forwarding redirects, bounded retries/deadlines and no PR checkout in the privileged phase. Forks never invoke cloud wake. Hosted fallback happens before assignment.
- No deletion, snapshotting, secret delivery, background alerting or periodic keepalive feature is installed.

BoxCI is an early release, not a hosted service. Report security concerns privately to the repository owner. Do not post credentials in issues.
