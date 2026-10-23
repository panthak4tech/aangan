# Privacy

Aangan is offline by default. It does not send hardware information or usage
data. When a user chooses **Refresh catalog**, the desktop app contacts
`raw.githubusercontent.com` to download the public model catalog and its
Minisign signature. The app verifies the signature locally before using the
catalog. No information about the PC is sent.

The bundled catalog remains available offline. See
[Catalog signing](./CATALOG-SIGNING.md) for the signing and key-storage process.
