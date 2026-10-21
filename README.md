# Aangan

Find out which open AI models your PC can run, and how fast, before you download anything.

> Status: CLI v0.1; desktop v0.2.0. Windows first. Offline by default: only a user-approved catalog refresh contacts `raw.githubusercontent.com`, and no PC information is sent.

## Try it

Download `aangan.exe` from Releases, then in PowerShell:

```powershell
.\aangan.exe scan
.\aangan.exe recommend
```

The desktop installer also bundles the CLI. If you select the optional
current-user PATH setting during installation, run `aangan scan` and
`aangan recommend` from any terminal.

Speeds are **estimates** from published formulas in [docs/estimation.md](docs/estimation.md); real measured benchmarks are on the roadmap.

## Help wanted

- Run `aangan scan --json` and file a **Hardware report**.
- Add or verify models in `catalog/models.json`.
- Desktop catalog refreshes use the versioned contract in `catalog/models.v1.json`; see `catalog/schema.v1.json`.
- Add test fixtures in `fixtures/profiles/`.

License: MIT. Model weights keep their own licenses.
