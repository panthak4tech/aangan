# Network access

Aangan is offline by default. It does not send hardware details, usage data, or
telemetry. Network requests are made only through the Rust `aangan-net` gate
after a user-initiated action. The gate requires HTTPS, applies a purpose-specific
host allow-list, checks every redirect, and supports the Offline mode switch.

The request targets the selected file URL and includes the `Aangan/<version>`
User-Agent. Requests do not include information about this PC. Activity records
are kept in memory only (up to 200 entries) and disappear when Aangan closes.

## Allowed hosts

| Host | Purpose | When |
|---|---|---|
| `raw.githubusercontent.com` | Model catalog and runtime manifest | Catalog refresh follows its existing consent choice. Runtime manifest refresh happens only after the user selects **Check for updates**. |
| `huggingface.co` | Model downloads | Requested only after the user selects **Download** for a fitting model. |
| `*.hf.co` | Model download redirects/CDN | Allowed only as redirects during a user-initiated model download. |
| `github.com` | Runtime downloads | Contacted only after the user selects **Install** for a manifest-listed runtime. |
| `release-assets.githubusercontent.com` | Runtime download assets | Allowed only as redirects during a user-initiated runtime download. |
| `objects.githubusercontent.com` | Runtime download assets | Allowed only as redirects during a user-initiated runtime download. |

These are the only remote hosts allowed by the gate. Catalog refresh, model
downloads, and runtime manifest/download requests all pass through it. Model
and runtime archives are checked against their expected size and SHA-256.
Transfers can resume from partial files. Enabling Offline mode blocks new
requests and cancels in-progress downloads while preserving partial data for a
later retry. The `*.hf.co` entry means hosts whose names end in `.hf.co`; it
does not allow arbitrary lookalike domains.

The chip and activity log cover Aangan's gated requests only; they are not a
system-wide network monitor and do not report other applications' traffic.
Local connections to a runtime do not appear in this log. Aangan does not
currently supervise runtime processes or enforce loopback-only runtime
bindings.

The **Network access details** link in Settings opens this document in the
system browser. That browser request happens only after the user selects the
link and is outside Aangan's in-app network activity log.
