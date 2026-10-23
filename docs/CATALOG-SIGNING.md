# Catalog signing

The desktop app accepts refreshed catalog data only when its exact bytes have a
valid Minisign signature from a trusted Aangan key. This protects users if the
GitHub account or repository is compromised. Schema validation still runs
after signature verification.

## Key storage

The primary and backup public keys are committed in `catalog/`. Their matching
private keys must remain offline on maintainer-controlled devices. Never commit
private keys, upload them to GitHub, or store them in GitHub Actions secrets.
The backup key should be kept offline and used only if the primary is lost.

## Signing a catalog update

After updating `catalog/models.v1.json`, run this from the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/catalog/sign.ps1
```

The script signs the file with the local primary key and verifies the resulting
signature against `catalog/aangan-catalog.pub`. Commit both
`catalog/models.v1.json` and `catalog/models.v1.json.minisig` in the same
pull request, using `git commit -s`. CI rejects a missing or invalid signature.
Do not use Minisign's legacy `-l` signature format.

If the primary key is unavailable, use the offline backup key and its matching
public key:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/catalog/sign.ps1 `
  -Key "$env:USERPROFILE\.minisign\aangan-catalog-backup.key" `
  -PublicKey "catalog\aangan-catalog-backup.pub"
```

Catalog JSON and signature files use LF bytes. `.gitattributes` disables line
ending conversion for the catalog files and test fixtures; do not rewrite a
signed file with a tool that changes its bytes after signing.

## Lost keys and rotation

If the primary key is lost, sign with the offline backup key. The app already
trusts both public keys, so using the backup does not require an app update.
To rotate keys, ship an app release with the new public key list. Keep the old
key trusted for one release so catalogs signed during the transition remain
verifiable.
