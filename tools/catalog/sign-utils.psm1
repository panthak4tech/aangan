function Get-AanganTrustedCatalogPublicKeys {
  param(
    [Parameter(Mandatory)]
    [string]$SignatureSourcePath
  )

  $source = Get-Content -LiteralPath $SignatureSourcePath -Raw
  $declaration = [regex]::Match(
    $source,
    '(?s)pub const CATALOG_PUBLIC_KEYS:\s*&\[\s*&str\s*\]\s*=\s*&\[(?<keys>.*?)\];'
  )
  if (-not $declaration.Success) {
    throw "Could not find CATALOG_PUBLIC_KEYS in $SignatureSourcePath."
  }

  $keys = @(
    [regex]::Matches($declaration.Groups["keys"].Value, '"(?<key>[^"]+)"') |
      ForEach-Object { $_.Groups["key"].Value }
  )
  if ($keys.Count -eq 0) {
    throw "CATALOG_PUBLIC_KEYS does not contain any keys: $SignatureSourcePath."
  }

  return $keys
}

function Assert-AanganTrustedCatalogPublicKey {
  param(
    [Parameter(Mandatory)]
    [string]$PublicKey,
    [Parameter(Mandatory)]
    [string[]]$TrustedKeys
  )

  foreach ($trustedKey in $TrustedKeys) {
    if ([string]::Equals($PublicKey, $trustedKey, [StringComparison]::Ordinal)) {
      return
    }
  }

  throw "The supplied public key is not trusted by the desktop app."
}

Export-ModuleMember -Function Get-AanganTrustedCatalogPublicKeys, Assert-AanganTrustedCatalogPublicKey
