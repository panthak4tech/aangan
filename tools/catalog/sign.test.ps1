$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "sign-utils.psm1") -Force

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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$trustedKeys = Get-AanganTrustedCatalogPublicKeys `
  -SignatureSourcePath (Join-Path $repoRoot "apps\desktop\src-tauri\src\catalog\signature.rs")
if ($trustedKeys.Count -ne 2) {
  throw "Expected both embedded catalog public keys; found $($trustedKeys.Count)."
}

foreach ($publicKeyFile in @("aangan-catalog.pub", "aangan-catalog-backup.pub")) {
  $publicKeyLines = Get-Content -LiteralPath (Join-Path $repoRoot "catalog\$publicKeyFile")
  Assert-AanganTrustedCatalogPublicKey `
    -PublicKey $publicKeyLines[1].Trim() `
    -TrustedKeys $trustedKeys
}

$untrustedPublicKeyLines = Get-Content -LiteralPath (
  Join-Path $repoRoot "apps\desktop\src-tauri\tests\fixtures\catalog-other.pub"
)
$untrustedPublicKey = $untrustedPublicKeyLines[1].Trim()
if ($untrustedPublicKey -notmatch "^RW" -or $trustedKeys -contains $untrustedPublicKey) {
  throw "The untrusted signing-key fixture must be a valid, untrusted public key."
}
Assert-Throws "untrusted public key" {
  Assert-AanganTrustedCatalogPublicKey `
    -PublicKey $untrustedPublicKey `
    -TrustedKeys $trustedKeys
} "not trusted"

$signingScript = Join-Path $PSScriptRoot "sign.ps1"
$missingPrivateKey = Join-Path ([IO.Path]::GetTempPath()) "aangan-missing-catalog-key"
$catalogFile = Join-Path $repoRoot "catalog\models.v1.json"
Assert-Throws "signer rejects untrusted key before signing" {
  & $signingScript `
    -Key $missingPrivateKey `
    -PublicKey (Join-Path $repoRoot "apps\desktop\src-tauri\tests\fixtures\catalog-other.pub") `
    -File $catalogFile
} "not trusted"
Assert-Throws "signer accepts trusted key before signing" {
  & $signingScript `
    -Key $missingPrivateKey `
    -PublicKey (Join-Path $repoRoot "catalog\aangan-catalog.pub") `
    -File $catalogFile
} "Signing key not found"

Write-Output "Catalog signing tests passed."
