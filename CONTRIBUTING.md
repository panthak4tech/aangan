# Contributing

Thanks for helping! Small PRs are welcome.

- Sign off every commit (`git commit -s`). This certifies the [Developer Certificate of Origin](https://developercertificate.org/).
- Run `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`.
- Estimator changes need a test (see `crates/fitcalc/tests`).
- Catalog changes: values must come from the GGUF file header; set `"verified": true` only then.
- By contributing you agree your work is licensed under the MIT license.
