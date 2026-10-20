# Aangan — instructions for Copilot

Aangan is an open-source, offline-first Windows desktop app that profiles the PC
and recommends local LLMs. It is MIT licensed.

## Layout

- `crates/aangan-types`: JSON contract
- `crates/hwprobe`: hardware probe
- `crates/fitcalc`: pure estimator
- `crates/aangan-cli`: command-line interface
- `apps/desktop`: React + Vite UI
- `apps/desktop/src-tauri`: Tauri 2 shell
- UI talks to Rust only through `apps/desktop/src/api/`.

## Commands

Run the relevant checks before declaring a task done:

- Rust: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`
- UI (from `apps/desktop`): `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`

## Hard rules

- No network access in code unless the task says so. Any network call must be user-initiated, go through Rust (not the webview), target one allow-listed host, and be documented in Settings → Privacy.
- No hard-coded colors in UI code. Use CSS variables from `src/styles/tokens.css` with semantic names. Keep the UI theme-able (light now, dark later).
- Never use WMI AdapterRAM. GPU detection uses DXGI + NVML.
- Always label speeds as "Estimated" or "Measured".
- Every change needs unit tests; do not lower coverage thresholds or edit `.github/rulesets/`.
- Use Conventional Commits and sign off every commit with `git commit -s`. Keep PRs small.
- If something is ambiguous, state the assumption in the PR description instead of guessing silently.
- Prefer small, readable changes. Explain why before adding dependencies.
- Rust code uses the 2021 edition. Do not use `unwrap()` or `expect()` in library code, except for the compiled-in catalog; return `Result`.
- Keep `fitcalc` pure: no I/O, network, or OS calls. Every formula change needs a test.
- Put Windows-only code behind `#[cfg(windows)]` and provide a harmless stub elsewhere.
- JSON field names in `aangan-types` are a public snake_case contract; do not rename them casually.
- Keep Clippy clean with `-D warnings`.
- Do not add dependencies with GPL/AGPL licenses.
