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
| `raw.githubusercontent.com` | Model catalog and runtime manifest | Catalog refresh is initiated by the user and requires the existing consent choice. Runtime manifest access is reserved for a future user-initiated runtime install or update; that feature is not available yet. |
| `huggingface.co` | Model downloads | Reserved for a future user-initiated model download; model downloading is not available yet. |
| `*.hf.co` | Model download redirects/CDN | Reserved for redirects during a future user-initiated model download; model downloading is not available yet. |
| `github.com` | Runtime downloads | Reserved for a future user-initiated runtime install or update; that feature is not available yet. |
| `release-assets.githubusercontent.com` | Runtime download assets | Reserved for allowed redirects during a future user-initiated runtime install or update; that feature is not available yet. |
| `objects.githubusercontent.com` | Runtime download assets | Reserved for allowed redirects during a future user-initiated runtime install or update; that feature is not available yet. |

These are the only remote hosts allowed by the gate. At present, catalog
refresh is the only implemented feature that makes a gated request. The
`*.hf.co` entry means hosts whose names end in `.hf.co`; it does not allow
arbitrary lookalike domains.

The chip and activity log cover Aangan's gated requests only; they are not a
system-wide network monitor and do not report other applications' traffic.
Aangan does not launch a local runtime yet. Before runtime support ships, its
runtime will be configured not to make outbound requests and to listen only on
loopback; those local connections will not appear in this log.

The **Network access details** link in Settings opens this document in the
system browser. That browser request happens only after the user selects the
link and is outside Aangan's in-app network activity log.
