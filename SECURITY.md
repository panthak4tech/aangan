# Security policy

Report vulnerabilities privately via GitHub → Security → "Report a vulnerability".
We aim to acknowledge reports within 7 days. The latest released version is supported.

Aangan makes no network connections except for user-initiated actions documented
in Settings → Privacy.

The desktop app verifies refreshed model-catalog bytes with an embedded Minisign
public key before parsing or caching them. Catalog signatures and trusted-key
maintenance are documented in [docs/CATALOG-SIGNING.md](docs/CATALOG-SIGNING.md).
