$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "..\..\scripts\release-utils.psm1") -Force

function Assert-Equal {
  param(
    [string]$Name,
    [string]$Actual,
    [string]$Expected
  )

  if (-not [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
    throw "$Name failed. Expected '$Expected', got '$Actual'."
  }
}

function Assert-Throws {
  param(
    [string]$Name,
    [scriptblock]$Action,
    [string]$ExpectedMessage
  )

  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notlike "*$ExpectedMessage*") {
      throw "$Name failed with an unexpected error: $($_.Exception.Message)"
    }
    return
  }
  throw "$Name should have failed."
}

Assert-Equal "tag version extraction" (Get-ReleaseTagVersion -Tag "v0.3.0") "0.3.0"
Assert-ReleaseVersion -Tag "v0.3.0" -DesktopVersion "0.3.0"
Assert-Throws "mismatched release version" {
  Assert-ReleaseVersion -Tag "v0.3.0" -DesktopVersion "0.2.0"
} "does not match desktop version"
Assert-Throws "invalid release tag" {
  Get-ReleaseTagVersion -Tag "v0.3"
} "vMAJOR.MINOR.PATCH"
Assert-Throws "invalid desktop version" {
  Assert-ReleaseVersion -Tag "v0.3.0" -DesktopVersion "0.3"
} "Desktop version"

$releaseWorkflowPath = Join-Path $PSScriptRoot "..\..\..\..\.github\workflows\release.yml"
$releaseWorkflow = Get-Content -LiteralPath $releaseWorkflowPath -Raw
$actionReferences = [regex]::Matches(
  $releaseWorkflow,
  '(?m)^\s*-\s*uses:\s*[^@\s]+@([^\s#]+)'
)
if ($actionReferences.Count -eq 0) {
  throw "Release workflow must declare its GitHub Actions."
}
foreach ($actionReference in $actionReferences) {
  if ($actionReference.Groups[1].Value -notmatch "^[0-9a-f]{40}$") {
    throw "Release workflow action is not pinned to a full commit SHA: $($actionReference.Value)"
  }
}
if ($releaseWorkflow -notmatch '(?m)^  id-token:\s*write\s*$') {
  throw "Release workflow must grant id-token: write for provenance attestations."
}
if ($releaseWorkflow -notmatch '(?m)^  attestations:\s*write\s*$') {
  throw "Release workflow must grant attestations: write for provenance attestations."
}
if ($releaseWorkflow -notmatch 'uses:\s*actions/attest-build-provenance@[0-9a-f]{40}') {
  throw "Release workflow must use a SHA-pinned build provenance action."
}
if ($releaseWorkflow -notmatch '(?m)^\s+subject-path:\s*target/release/bundle/nsis/Aangan_\*_x64-setup\.exe\s*$') {
  throw "Release workflow must attest the generated Windows installer."
}

$testDirectory = Join-Path ([IO.Path]::GetTempPath()) "aangan-release-test-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $testDirectory | Out-Null
try {
  $installerPath = Join-Path $testDirectory "fixture-installer.exe"
  $checksumPath = Join-Path $testDirectory "SHA256SUMS.txt"
  [IO.File]::WriteAllBytes($installerPath, [Text.Encoding]::UTF8.GetBytes("Aangan installer fixture"))

  $checksum = Write-ReleaseChecksum -InstallerPath $installerPath -ChecksumPath $checksumPath
  $expected = "30c3384457227d0402b8d301625b39cab5fd6789f33275af148a6ad9ef61e1e0  fixture-installer.exe`n"
  Assert-Equal "checksum output" $checksum $expected
  Assert-Equal "written checksum file" ([IO.File]::ReadAllText($checksumPath)) $expected

  Assert-Throws "missing installer" {
    Write-ReleaseChecksum `
      -InstallerPath (Join-Path $testDirectory "missing-installer.exe") `
      -ChecksumPath $checksumPath
  } "Expected installer was not produced"
} finally {
  Remove-Item -LiteralPath $testDirectory -Recurse -Force
}

Write-Output "Release utility tests passed."
