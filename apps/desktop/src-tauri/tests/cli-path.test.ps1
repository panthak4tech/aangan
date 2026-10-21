$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\cli-path.ps1")

function Assert-PathResult {
  param(
    [string]$Name,
    [string]$Actual,
    [string]$Expected
  )

  if (-not [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
    throw "$Name failed. Expected '$Expected', got '$Actual'."
  }
}

$result = Add-AanganPathEntry "" "C:\Aangan"
Assert-PathResult "Add to empty PATH" $result.Value "C:\Aangan"
if (-not $result.Changed) {
  throw "Add to empty PATH should report a change."
}

$result = Add-AanganPathEntry "C:\Windows;C:\Tools" "C:\Aangan"
Assert-PathResult "Append PATH entry" $result.Value "C:\Windows;C:\Tools;C:\Aangan"

$result = Add-AanganPathEntry "C:\Aangan;C:\Windows" "c:\aangan\"
Assert-PathResult "Avoid duplicate PATH entry" $result.Value "C:\Aangan;C:\Windows"
if ($result.Changed) {
  throw "Adding a case-insensitive duplicate should not report a change."
}

$result = Add-AanganPathEntry "C:\Aangan-old" "C:\Aangan"
Assert-PathResult "Avoid substring match" $result.Value "C:\Aangan-old;C:\Aangan"

$result = Remove-AanganPathEntry "C:\Aangan;C:\Windows;C:\Aangan\" "c:\aangan"
Assert-PathResult "Remove exact PATH entries" $result.Value "C:\Windows"
if (-not $result.Changed) {
  throw "Removing an existing PATH entry should report a change."
}

$result = Remove-AanganPathEntry "C:\Aangan-old;C:\Windows" "C:\Aangan"
Assert-PathResult "Preserve unrelated PATH entries" $result.Value "C:\Aangan-old;C:\Windows"
if ($result.Changed) {
  throw "Removing an absent PATH entry should not report a change."
}

Write-Output "CLI PATH tests passed."
