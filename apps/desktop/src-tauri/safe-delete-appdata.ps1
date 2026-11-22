param(
  [Parameter(Mandatory = $true)]
  [string]$RoamingDataPath,
  [Parameter(Mandatory = $true)]
  [string]$LocalDataPath,
  [Parameter(Mandatory = $true)]
  [string]$AanganDataPath,
  [string]$ExcludedPath
)

$ErrorActionPreference = "Stop"
$excludedFullPath = if ([string]::IsNullOrWhiteSpace($ExcludedPath)) {
  $null
} else {
  [System.IO.Path]::GetFullPath($ExcludedPath)
}

function Remove-PathWithoutFollowingReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $isExcluded = $null -ne $excludedFullPath -and
    [string]::Equals($fullPath, $excludedFullPath, [System.StringComparison]::OrdinalIgnoreCase)
  if ($isExcluded) {
    return
  }
  $pathPrefix = $fullPath.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  $containsExcludedPath = $null -ne $excludedFullPath -and
    $excludedFullPath.StartsWith($pathPrefix, [System.StringComparison]::OrdinalIgnoreCase)

  try {
    $attributes = [System.IO.File]::GetAttributes($Path)
  } catch [System.IO.FileNotFoundException] {
    return
  } catch [System.IO.DirectoryNotFoundException] {
    return
  }

  $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
  $isReparsePoint = ($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  if ($isReparsePoint) {
    if ($containsExcludedPath) {
      return
    }
    if ($isDirectory) {
      [System.IO.Directory]::Delete($Path, $false)
    } else {
      [System.IO.File]::Delete($Path)
    }
    return
  }

  if ($isDirectory) {
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($Path)) {
      Remove-PathWithoutFollowingReparsePoints -Path $entry
    }
    if (-not $containsExcludedPath) {
      [System.IO.Directory]::Delete($Path, $false)
    }
  } else {
    [System.IO.File]::Delete($Path)
  }
}

try {
  Remove-PathWithoutFollowingReparsePoints -Path $RoamingDataPath
  Remove-PathWithoutFollowingReparsePoints -Path $LocalDataPath
  Remove-PathWithoutFollowingReparsePoints -Path $AanganDataPath
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
