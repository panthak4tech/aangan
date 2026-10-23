# Contributing

Thanks for helping! Small pull requests are welcome.

## Workflow

1. Fork the repository and create a focused branch from `main`.
2. Make your changes and add or update tests.
3. Run the relevant checks listed below.
4. Open a pull request with a [Conventional Commit](https://www.conventionalcommits.org/) title. Use a type such as `feat`, `fix`, `docs`, `test`, `build`, `ci`, or `chore`; optional scopes include `cli`, `desktop`, `ui`, `core`, `hwprobe`, `fitcalc`, `types`, `catalog`, `installer`, `ci`, `repo`, and `deps`.

## Sign-off

Sign off every commit with `git commit -s`. This certifies the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).

## Checks

From the repository root, run:

```sh
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

From `apps/desktop`, run:

```sh
npm run lint
npm run typecheck
npm run test
npm run build
```

Maintainers should follow the [release checklist](docs/releasing.md) before
creating a version tag.

Estimator changes need a test (see `crates/fitcalc/tests`). For catalog changes,
values must come from the GGUF file header; set `"verified": true` only then.

No Contributor License Agreement (CLA) is required. By contributing, you agree
your work is licensed under the MIT license.

## Dependency notices

After changing Rust or production frontend dependencies, regenerate the
committed `THIRD_PARTY_NOTICES.md` with `npm run notices` from `apps/desktop`.
The app opens this bundled text file offline; it does not embed the dependency
list in the webview. Release CI verifies the committed file with
`npm run notices:check`. Regeneration requires the `cargo-about` CLI and the
project's npm dependencies:

```sh
cargo install --locked --features cli --version 0.9.2 cargo-about
cd apps/desktop
npm run notices
```
