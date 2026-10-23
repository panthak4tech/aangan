# Aangan

Find out which open AI models your PC can run, and how fast, before you download anything.

> Windows first. Offline by default: only a user-approved catalog refresh contacts
> `raw.githubusercontent.com`, and no PC information is sent.

## Try it

Download `aangan.exe` from Releases, then in PowerShell:

```powershell
.\aangan.exe scan
.\aangan.exe recommend
```

The desktop installer also bundles the CLI. If you select the optional
current-user PATH setting during installation, run `aangan scan` and
`aangan recommend` from any terminal.

In the desktop app, choose **Settings → Appearance** to follow Windows or select
Light or Dark mode.

Speeds are **estimates** from published formulas in [docs/estimation.md](docs/estimation.md); real measured benchmarks are on the roadmap.

## Help wanted

- Run `aangan scan --json` and file a **Hardware report**.
- The CLI's bundled catalog is `catalog/models.json`.
- The desktop's bundled and refreshable catalog is `catalog/models.v1.json`; see `catalog/schema.v1.json`.
- In the desktop app, open **Models → Refresh catalog** to check Aangan's curated catalog hosted on GitHub. Refresh does not search Hugging Face or download model weights. The bundled desktop catalog currently contains seven Qwen2.5 sizes; adding models requires curating their metadata in `catalog/models.v1.json`.
- Add test fixtures in `fixtures/profiles/`.

License: MIT. Model weights keep their own licenses.
