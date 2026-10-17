# Instructions for Copilot

Project: Aangan, a Rust workspace (`aangan-types`, `hwprobe`, `fitcalc`, `aangan-cli`) and a Tauri 2 + React desktop app.

- Rust 2021. No `unwrap()`/`expect()` in library code except the compiled-in catalog. Return `Result`.
- Keep `fitcalc` pure: no I/O, no network, no OS calls. Every formula change needs a test.
- Windows-only code lives behind `#[cfg(windows)]` with a harmless stub elsewhere.
- No network calls, no telemetry, ever, unless the user explicitly consents in the UI.
- JSON field names are snake_case and are a public contract (`aangan-types`); don't rename them casually.
- Prefer small, focused changes. Keep Clippy clean (`-D warnings`).
- License is MIT. Do not add dependencies with GPL/AGPL licenses.
