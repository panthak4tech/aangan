param(
  [Parameter(Mandatory = $true)]
  [string]$RoamingDataPath,
  [Parameter(Mandatory = $true)]
  [string]$LocalDataPath,
  [Parameter(Mandatory = $true)]
  [string]$AanganDataPath
)

$ErrorActionPreference = "Stop"

function Remove-PathWithoutFollowingReparsePoints {
  param([Parameter(Mandatory = $true)][string]$Path)

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
    [System.IO.Directory]::Delete($Path, $false)
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
