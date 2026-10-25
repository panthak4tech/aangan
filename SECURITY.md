# Security policy

Report vulnerabilities privately via GitHub → Security → "Report a vulnerability".
We aim to acknowledge reports within 7 days. The latest released version is supported.

The only app network feature is **Refresh catalog**. It contacts
`raw.githubusercontent.com` only after the user consents (or has chosen to always
allow refreshes in Settings), and sends no hardware or usage information.

The desktop app verifies refreshed model-catalog bytes with an embedded Minisign
public key before parsing or caching them. Catalog signatures and trusted-key
maintenance are documented in [docs/CATALOG-SIGNING.md](docs/CATALOG-SIGNING.md).

Release installers are not Authenticode-signed yet. SHA-256 checksums are
published for every release; GitHub Actions build provenance attestations will
be available starting with v0.4.0. See
[Verifying your download](README.md#verifying-your-download).
