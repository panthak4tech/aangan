# Aangan

Find out which open AI models your PC can run, and how fast, before you download anything.

> Status: v0.1 (command line). Windows first. Offline: nothing is sent anywhere.

## Try it

Download `aangan.exe` from Releases, then in PowerShell:

```powershell
.\aangan.exe scan
.\aangan.exe recommend
```

Speeds are **estimates** from published formulas in [docs/estimation.md](docs/estimation.md); real measured benchmarks are on the roadmap.

## Help wanted

- Run `aangan scan --json` and file a **Hardware report**.
- Add or verify models in `catalog/models.json`.
- Add test fixtures in `fixtures/profiles/`.

License: MIT. Model weights keep their own licenses.
