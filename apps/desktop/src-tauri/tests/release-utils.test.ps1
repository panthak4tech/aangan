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
    [scriptblock]$Action
  )

  try {
    & $Action
  } catch {
    return
  }
  throw "$Name should have failed."
}

Assert-Equal "tag version extraction" (Get-ReleaseTagVersion -Tag "v0.3.0") "0.3.0"
Assert-ReleaseVersion -Tag "v0.3.0" -DesktopVersion "0.3.0"

Assert-Throws "mismatched release version" {
  Assert-ReleaseVersion -Tag "v0.3.0" -DesktopVersion "0.2.0"
}
Assert-Throws "invalid release tag" {
  Get-ReleaseTagVersion -Tag "v0.3"
}
Assert-Throws "invalid desktop version" {
  Assert-ReleaseVersion -Tag "v0.3.0" -DesktopVersion "0.3"
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
  }
} finally {
  Remove-Item -LiteralPath $testDirectory -Recurse -Force
}

Write-Output "Release utility tests passed."
