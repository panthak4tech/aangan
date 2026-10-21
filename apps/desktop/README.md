# Aangan desktop

Aangan is an offline-first Windows desktop app built with Tauri 2, React, and
TypeScript. Hardware probing and model recommendations run through the Rust
workspace; the browser preview uses local mock hardware profiles and estimates.
The UI uses a light green semantic palette defined in `src/styles/tokens.css`;
dark mode is not implemented yet.
The production WebView CSP allows local assets and Tauri IPC only. The NSIS
installer targets the current user and does not require administrator access.
The installer bundles the `aangan` CLI and offers an unchecked option to add
the install directory to the current user's PATH. That PATH entry is removed
on uninstall only if the installer added it.
The custom NSIS template ignores unrelated processes reported by Windows
Restart Manager. If shutdown fails with error 350 while Aangan is listed, it
terminates only Aangan's reported process IDs, verifies they have exited, and
schedules locked application files for removal at reboot. Review this template
when updating Tauri's NSIS bundler.

## Desktop features

On the Scan page, save a hardware report through the native file picker or copy
its JSON to the clipboard. Settings → Data shows the app's local data folder
with actions to open or copy its path. On the Models page, enable "Show models
that won't fit" to see larger catalog entries and their estimated memory
requirements; this choice is remembered. The Scan page lists detected graphics
adapters and only shows the built-in-graphics note when no discrete GPU is
detected. Known integrated adapters are identified by PCI device ID; unrecognized
IDs are categorized as discrete.

## Development

From this directory:

```powershell
npm install
npm run tauri dev
```

Build the Windows installer with `npm run tauri build`. The bundle build stages
the CLI as a Tauri sidecar before compiling the frontend and packaging the
installer.

To preview the UI in a regular browser, run `npm run dev`. This uses mock data;
the development header lets you switch hardware presets and exercise scan
errors.

## Validation

From this directory, build the frontend:

```powershell
npm run build
```

From the repository root, validate the Rust workspace:

```powershell
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
