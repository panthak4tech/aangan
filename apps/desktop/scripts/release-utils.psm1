function Get-ReleaseTagVersion {
  param([Parameter(Mandatory = $true)][string]$Tag)

  if ($Tag -notmatch '^v(?<Version>\d+\.\d+\.\d+)$') {
    throw "Release tag '$Tag' must use the vMAJOR.MINOR.PATCH format."
  }

  return $Matches.Version
}

function Assert-ReleaseVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [Parameter(Mandatory = $true)][string]$DesktopVersion
  )

  $tagVersion = Get-ReleaseTagVersion -Tag $Tag
  if ($DesktopVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "Desktop version '$DesktopVersion' must use the MAJOR.MINOR.PATCH format."
  }
  if ($tagVersion -cne $DesktopVersion) {
    throw "Tag version $tagVersion does not match desktop version $DesktopVersion."
  }
}

function Write-ReleaseChecksum {
  param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$ChecksumPath
  )

  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Expected installer was not produced: $InstallerPath"
  }

  $hash = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $checksum = "$hash  $([IO.Path]::GetFileName($InstallerPath))`n"
  [IO.File]::WriteAllText($ChecksumPath, $checksum, [Text.UTF8Encoding]::new($false))
  return $checksum
}

Export-ModuleMember -Function Get-ReleaseTagVersion, Assert-ReleaseVersion, Write-ReleaseChecksum
