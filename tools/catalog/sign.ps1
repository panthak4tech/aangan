param(
  [string]$Key = "$env:USERPROFILE\.minisign\aangan-catalog.key",
  [string]$PublicKey = "catalog\aangan-catalog.pub",
  [string]$File = "catalog/models.v1.json"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$keyPath = if ([IO.Path]::IsPathRooted($Key)) {
  $Key
} else {
  Join-Path $repoRoot $Key
}
$publicKeyPath = if ([IO.Path]::IsPathRooted($PublicKey)) {
  $PublicKey
} else {
  Join-Path $repoRoot $PublicKey
}
$publicKeyPath = (Resolve-Path -LiteralPath $publicKeyPath).Path
$filePath = if ([IO.Path]::IsPathRooted($File)) {
  $File
} else {
  Join-Path $repoRoot $File
}
$filePath = (Resolve-Path -LiteralPath $filePath).Path

if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
  throw "Signing key not found: $keyPath"
}

$content = [IO.File]::ReadAllBytes($filePath)
for ($index = 0; $index -lt $content.Length - 1; $index++) {
  if ($content[$index] -eq 13 -and $content[$index + 1] -eq 10) {
    throw "$File has CRLF line endings. Regenerate or convert it to LF before signing."
  }
}

$catalog = Get-Content -LiteralPath $filePath -Raw | ConvertFrom-Json
$generatedAt = $catalog.generated_at
if (-not $generatedAt) {
  throw "$File does not contain generated_at."
}

$signaturePath = "$filePath.minisig"
& minisign -S -s $keyPath -m $filePath -x $signaturePath -t "aangan catalog generated_at=$generatedAt"
if ($LASTEXITCODE -ne 0) {
  throw "Signing failed."
}

$publicKeyLines = Get-Content -LiteralPath $publicKeyPath
if ($publicKeyLines.Count -lt 2 -or $publicKeyLines[1] -notmatch "^RW") {
  throw "Primary public key is missing or malformed: $publicKeyPath"
}

& minisign -V -P $publicKeyLines[1].Trim() -m $filePath -x $signaturePath
if ($LASTEXITCODE -ne 0) {
  throw "Signature verification failed."
}

Write-Host "Signed and verified: $signaturePath"
