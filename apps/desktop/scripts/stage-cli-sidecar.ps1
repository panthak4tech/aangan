$ErrorActionPreference = "Stop"

$targetTriple = "x86_64-pc-windows-msvc"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$sourceBinary = Join-Path $repoRoot "target\release\aangan.exe"
$sidecarDirectory = Join-Path $repoRoot "apps\desktop\src-tauri\binaries"
$sidecarBinary = Join-Path $sidecarDirectory "aangan-$targetTriple.exe"

$hostTriple = (rustc -vV | Select-String "^host: ").Line.Substring(6)
if ($LASTEXITCODE -ne 0) {
  throw "Could not determine the Rust host target."
}
if ($hostTriple -ne $targetTriple) {
  throw "Aangan desktop bundling requires the $targetTriple Rust target; found $hostTriple."
}

Push-Location $repoRoot
try {
  cargo build --release --locked -p aangan-cli
  if ($LASTEXITCODE -ne 0) {
    throw "Building the Aangan CLI sidecar failed with exit code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $sourceBinary -PathType Leaf)) {
  throw "The CLI build completed without producing $sourceBinary."
}

New-Item -ItemType Directory -Path $sidecarDirectory -Force | Out-Null
Copy-Item -LiteralPath $sourceBinary -Destination $sidecarBinary -Force
