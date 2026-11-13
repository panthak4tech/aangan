# Aangan

Find out which open AI models your PC can run, and how fast, before choosing one to download.

> Status: desktop app and CLI v0.4.0. Windows first. Offline by default: your
> hardware details never leave your PC. The optional **Refresh catalog** action
> contacts `raw.githubusercontent.com` only with your permission.

See [Network access](docs/NETWORK.md) for the complete host allow-list, request
purposes, and privacy details.

## Install

Download the Windows installer from [Releases](https://github.com/panthak4tech/aangan/releases), run it, and open Aangan. The installer also bundles the CLI. Select the optional current-user PATH setting during installation to run `aangan` from any terminal, or use the executable directly:

```powershell
.\aangan.exe scan
.\aangan.exe recommend
```

## Verifying your download

Aangan's installer is **not code-signed yet**, so Windows SmartScreen or
antivirus software may warn about it. Compare the installer's SHA-256 with
`SHA256SUMS.txt` on the release page:

```powershell
$installer = Get-ChildItem .\Aangan_*_x64-setup.exe | Select-Object -First 1
(Get-FileHash $installer.FullName -Algorithm SHA256).Hash
```

For releases built starting with v0.4.0, optionally verify its GitHub build
provenance (requires the GitHub CLI):

```powershell
gh attestation verify $installer.FullName --repo panthak4tech/aangan
```

Release installers are built from this repository by GitHub Actions. See
[SECURITY.md](SECURITY.md) for the security policy.

In the desktop app, choose **Settings → Appearance** to follow Windows or select
Light or Dark mode.

## Downloading models

Model files are downloaded only after you select **Download** for a fitting
recommendation. Downloads use the curated catalog's file URL and are checked
against its expected size and SHA-256 before being marked complete. Transfers
can be paused and resumed; **Offline mode** blocks and cancels in-progress
network requests.

Choose the destination in **Settings → Model storage**. Aangan keeps track of
previously selected model folders so their files remain visible and manageable
after you change the destination. You can open folders or delete model and
incomplete files there. Model weights retain their publishers' licenses.

Speeds are **estimates** from published formulas in [docs/estimation.md](docs/estimation.md); real measured benchmarks are on the roadmap.

## Help wanted

- Run `aangan scan --json` and file a **Hardware report**.
- The CLI's bundled catalog is `catalog/models.json`.
- The desktop's bundled and refreshable catalog is `catalog/models.v1.json`; see `catalog/schema.v1.json`.
- In the desktop app, open **Models → Refresh catalog** to check Aangan's curated catalog hosted on GitHub. Refresh does not search Hugging Face or download model weights; selecting a model's **Download** button is a separate, user-initiated action. The bundled desktop catalog currently contains seven Qwen2.5 sizes; adding models requires curating their metadata in `catalog/models.v1.json`.
- Add test fixtures in `fixtures/profiles/`.

License: MIT. Model weights keep their own licenses.
