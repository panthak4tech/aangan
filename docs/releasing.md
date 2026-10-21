# Releasing Aangan

The `v0.3.0` release is a Windows x64 desktop release. The bundled CLI remains
versioned independently from the desktop app.

## Before tagging

- Merge the release features and confirm all required CI, review, and security
  checks pass.
- Bump the desktop version consistently in `apps/desktop/package.json`,
  `apps/desktop/package-lock.json`, `apps/desktop/src-tauri/Cargo.toml`, and
  `apps/desktop/src-tauri/tauri.conf.json`.
- Run the documented Rust and desktop checks in `CONTRIBUTING.md`.
- Test a clean Windows machine: fresh install, upgrade from the previous
  release, and uninstall. Verify the CLI PATH option both selected and
  unselected; uninstall must remove only an installer-managed PATH entry.
- Review the false-positive submission flow and confirm no hardware profile is
  uploaded.
- Configure the GitHub `release` environment with a required reviewer before
  creating the release tag.

## Drafting and publishing

After the version bump is merged, create and push the matching tag:

```powershell
git tag -a v0.3.0 -m "Aangan v0.3.0"
git push origin v0.3.0
```

The `Release` workflow waits for approval on the protected `release`
environment, validates that the tag matches the desktop version, builds the
Windows NSIS installer (including the CLI sidecar), calculates a SHA-256
checksum, and creates a **draft** GitHub release with generated notes.

Review the installer, checksum, and release notes in the draft. Publish the
release manually only after the clean-machine checks and release approval are
complete. The workflow never publishes a release automatically.
