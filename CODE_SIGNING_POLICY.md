# Code signing policy

Aangan is open source under the MIT license. The project is seeking free
Authenticode code signing through the SignPath Foundation. No approval or
signing certificate is in place yet, so release installers are currently
unsigned. SHA-256 checksums are available for every release; build provenance
attestations will be available starting with v0.4.0. See the
[README](README.md#verifying-your-download) for verification steps.

## Roles

- **Committers and reviewers:** maintainers listed in
  [CODEOWNERS](.github/CODEOWNERS), currently `@panthak4tech`.
- **Release approver:** `@panthak4tech` approves each release through the
  protected GitHub `release` environment before the release workflow runs.

## Scope and process

If code signing is approved, only release installers built from this repository
by the GitHub Actions release workflow for a tag on `main` may be signed. No
developer may sign release binaries from a personal machine. The signing
certificate and any signing credentials must remain under the control of the
approved signing service; they must not be committed to the repository.

The release workflow is configured to publish a GitHub build provenance
attestation for the installer starting with v0.4.0. This attestation identifies
the GitHub Actions build and is not an Authenticode signature or publisher
certificate.

## Privacy

The only app network feature is **Refresh catalog**. It contacts
`raw.githubusercontent.com` only after the user consents (or has chosen to
always allow refreshes in Settings) and sends no information about the user's
PC. See [docs/PRIVACY.md](docs/PRIVACY.md).

## Verification

Each release provides `SHA256SUMS.txt`. Releases built starting with v0.4.0
also provide a GitHub build provenance attestation for the installer. Follow
the README's [download verification steps](README.md#verifying-your-download).
