param(
  [ValidateSet("Add", "Remove")]
  [string]$Action,
  [string]$InstallDir,
  [string]$MarkerKey
)

$ErrorActionPreference = "Stop"

function Get-AanganPathEntryKey {
  param([AllowEmptyString()][string]$Entry)

  $value = [Environment]::ExpandEnvironmentVariables($Entry.Trim().Trim('"'))
  return $value.TrimEnd([char[]]@("\", "/"))
}

function Test-AanganPathContainsEntry {
  param(
    [AllowEmptyString()][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$Entry
  )

  $entryKey = Get-AanganPathEntryKey $Entry
  foreach ($pathEntry in $PathValue.Split(";")) {
    if ([string]::Equals(
      (Get-AanganPathEntryKey $pathEntry),
      $entryKey,
      [StringComparison]::OrdinalIgnoreCase
    )) {
      return $true
    }
  }
  return $false
}

function Add-AanganPathEntry {
  param(
    [AllowEmptyString()][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$Entry
  )

  if ([string]::IsNullOrWhiteSpace($Entry) -or $Entry.Contains(";")) {
    throw "The CLI install path is empty or contains a PATH delimiter."
  }
  if (Test-AanganPathContainsEntry $PathValue $Entry) {
    return [pscustomobject]@{ Value = $PathValue; Changed = $false }
  }

  $updatedValue = if ([string]::IsNullOrEmpty($PathValue)) {
    $Entry
  } else {
    "$PathValue;$Entry"
  }
  return [pscustomobject]@{ Value = $updatedValue; Changed = $true }
}

function Remove-AanganPathEntry {
  param(
    [AllowEmptyString()][string]$PathValue,
    [Parameter(Mandatory = $true)][string]$Entry
  )

  $keptEntries = [System.Collections.Generic.List[string]]::new()
  foreach ($pathEntry in $PathValue.Split(";")) {
    if (-not [string]::Equals(
      (Get-AanganPathEntryKey $pathEntry),
      (Get-AanganPathEntryKey $Entry),
      [StringComparison]::OrdinalIgnoreCase
    )) {
      $keptEntries.Add($pathEntry)
    }
  }

  $updatedValue = [string]::Join(";", $keptEntries.ToArray())
  return [pscustomobject]@{
    Value = $updatedValue
    Changed = -not [string]::Equals($updatedValue, $PathValue, [StringComparison]::Ordinal)
  }
}

function Invoke-AanganPathUpdate {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("Add", "Remove")][string]$Operation,
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$UninstallKey
  )

  if ($Directory.Contains(";")) {
    throw "The CLI install path contains a PATH delimiter and cannot be added safely."
  }

  $registry = [Microsoft.Win32.Registry]::CurrentUser
  $environmentKey = $registry.CreateSubKey("Environment")
  $marker = $null
  try {
    $pathValueNames = @($environmentKey.GetValueNames())
    $hasPathValue = $pathValueNames -contains "Path"
    $pathValue = if ($hasPathValue) {
      [string]$environmentKey.GetValue(
        "Path",
        "",
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
    } else {
      ""
    }
    $pathValueKind = if ($hasPathValue) {
      $environmentKey.GetValueKind("Path")
    } else {
      [Microsoft.Win32.RegistryValueKind]::ExpandString
    }

    if ($Operation -eq "Add") {
      $marker = $registry.CreateSubKey($UninstallKey)
      $previouslyAdded = [string]$marker.GetValue("CliPathValue", "")
      $entryToAdd = if ([string]::IsNullOrEmpty($previouslyAdded)) {
        $Directory
      } else {
        $previouslyAdded
      }
      $sameEntry = [string]::Equals(
        (Get-AanganPathEntryKey $entryToAdd),
        (Get-AanganPathEntryKey $Directory),
        [StringComparison]::OrdinalIgnoreCase
      )
      $updatedPath = $pathValue
      $changed = $false
      if (-not $sameEntry -and -not [string]::IsNullOrEmpty($previouslyAdded)) {
        $removed = Remove-AanganPathEntry $updatedPath $entryToAdd
        $updatedPath = $removed.Value
        $changed = $removed.Changed
      }
      $added = Add-AanganPathEntry $updatedPath $Directory
      $updatedPath = $added.Value
      $changed = $changed -or $added.Changed
      if (-not $changed) {
        return
      }
      $marker.SetValue("CliPathValue", $Directory, [Microsoft.Win32.RegistryValueKind]::String)
      $marker.SetValue("CliPathAdded", 1, [Microsoft.Win32.RegistryValueKind]::DWord)
      try {
        $environmentKey.SetValue("Path", $updatedPath, $pathValueKind)
      } catch {
        $marker.DeleteValue("CliPathAdded", $false)
        $marker.DeleteValue("CliPathValue", $false)
        throw
      }
      return
    }

    $marker = $registry.OpenSubKey($UninstallKey, $true)
    if ($null -eq $marker -or $marker.GetValue("CliPathAdded", 0) -ne 1) {
      return
    }

    $entryToRemove = [string]$marker.GetValue("CliPathValue", $Directory)
    if ($hasPathValue) {
      $updated = Remove-AanganPathEntry $pathValue $entryToRemove
      if ($updated.Changed) {
        if ([string]::IsNullOrEmpty($updated.Value)) {
          $environmentKey.DeleteValue("Path", $false)
        } else {
          $environmentKey.SetValue("Path", $updated.Value, $pathValueKind)
        }
      }
    }
    $marker.DeleteValue("CliPathAdded", $false)
    $marker.DeleteValue("CliPathValue", $false)
  } finally {
    if ($null -ne $marker) {
      $marker.Dispose()
    }
    $environmentKey.Dispose()
  }
}

if (-not [string]::IsNullOrEmpty($Action)) {
  if ([string]::IsNullOrWhiteSpace($InstallDir) -or [string]::IsNullOrWhiteSpace($MarkerKey)) {
    throw "InstallDir and MarkerKey are required when updating PATH."
  }
  Invoke-AanganPathUpdate $Action $InstallDir $MarkerKey
}
