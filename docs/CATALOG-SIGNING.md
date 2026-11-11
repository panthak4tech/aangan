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

Before signing a generated catalog, verify its architecture metadata against
the GGUF headers:

```powershell
python tools/catalog/verify_catalog.py --limit 5
python tools/catalog/verify_catalog.py
```

The verifier probes the first quant file for each model, compares its layer,
KV-head, head-dimension, and context-length values with the catalog, and exits
with an error if any mismatch is found. It waits at least one second between
uncached requests and stores probe results under `tools/catalog/.cache/`;
the cache is local and must not be committed. A mismatch report does not modify
the catalog or the source list. Fix the source metadata, rebuild the catalog,
and verify it again before signing. The catalog's `verified` field remains
curated in `catalog/sources.yml`; it is not changed automatically by this tool.
If a model's upstream config metadata differs from its GGUF header, a
model-specific `arch_overrides` object in `catalog/sources.yml` can record the
header-verified architecture values; run the verifier again after rebuilding.

After verification and updating `catalog/models.v1.json`, run this from the
repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/catalog/sign.ps1
```

The script signs the file with the local primary key and verifies the resulting
signature against `catalog/aangan-catalog.pub`. Before signing, it rejects any
public key not embedded in the desktop app's trusted key list. Commit both
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
