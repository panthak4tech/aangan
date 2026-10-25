use fitcalc::{License, ModelSpec};
use reqwest::Url;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::{fs, io::Write};

pub mod signature;
use signature::{CATALOG_PUBLIC_KEYS, SignatureError, verify_catalog};

pub const CATALOG_URL: &str =
    "https://raw.githubusercontent.com/panthak4tech/aangan/main/catalog/models.v1.json";
const MAX_CATALOG_BYTES: usize = 5 * 1024 * 1024;
const MAX_SIGNATURE_BYTES: usize = 4 * 1024;
const MAX_MODELS: usize = 1000;
const CATALOG_FILE: &str = "catalog-cache.v1.json";
const SETTINGS_FILE: &str = "settings.json";
const LEGACY_MIGRATION_FILE: &str = ".legacy-data-migrated";

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Catalog {
    schema: u32,
    generated_at: String,
    models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CatalogModel {
    id: String,
    family: String,
    name: String,
    #[serde(deserialize_with = "deserialize_required_option")]
    params_b: Option<f64>,
    arch: Architecture,
    license: CatalogLicense,
    gated: bool,
    tags: Vec<String>,
    quants: Vec<CatalogQuant>,
    verified: bool,
    added_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct Architecture {
    layers: u32,
    kv_heads: u32,
    head_dim: u32,
    context_max: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CatalogLicense {
    spdx: String,
    kind: String,
    url: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct CatalogQuant {
    name: String,
    file: String,
    size_bytes: u64,
    sha256: String,
    url: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct AppSettings {
    #[serde(default)]
    refresh_catalog_always_allowed: bool,
    #[serde(default)]
    subscribed_families: Option<Vec<String>>,
}

#[derive(Debug)]
pub struct CatalogLoad {
    pub catalog: Catalog,
    pub warning: Option<String>,
    pub signature_verified: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct SignedCatalogCache {
    catalog_json: Vec<u8>,
    signature: String,
}

#[derive(Debug, Serialize)]
pub struct CatalogInfo {
    pub generated_at: String,
    pub families: Vec<String>,
    pub subscribed_families: Vec<String>,
    pub refresh_catalog_always_allowed: bool,
    pub warning: Option<String>,
    pub signature_verified: bool,
}

#[derive(Debug, Serialize)]
pub struct RefreshResult {
    pub generated_at: String,
    pub model_count: usize,
    pub added: usize,
    pub updated: usize,
}

pub fn cache_path(data_dir: &Path) -> PathBuf {
    data_dir.join(CATALOG_FILE)
}

pub fn migrate_legacy_data(legacy_dir: &Path, data_dir: &Path) -> Result<(), String> {
    let migration_marker = data_dir.join(LEGACY_MIGRATION_FILE);
    if legacy_dir == data_dir || migration_marker.exists() {
        return Ok(());
    }
    for file in [CATALOG_FILE, SETTINGS_FILE] {
        let source = legacy_dir.join(file);
        let destination = data_dir.join(file);
        if source.is_file() && !destination.exists() {
            fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "could not preserve existing catalog data from {}: {error}",
                    source.display()
                )
            })?;
        }
    }
    fs::write(&migration_marker, b"1")
        .map_err(|error| format!("could not record catalog data migration: {error}"))?;
    Ok(())
}

fn settings_path(data_dir: &Path) -> PathBuf {
    data_dir.join(SETTINGS_FILE)
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

pub fn validate_catalog_json(bytes: &[u8]) -> Result<Catalog, String> {
    if bytes.len() > MAX_CATALOG_BYTES {
        return Err("catalog exceeds the 5 MiB limit".to_string());
    }
    let catalog: Catalog = serde_json::from_slice(bytes)
        .map_err(|error| format!("catalog JSON is invalid: {error}"))?;
    validate_catalog(&catalog)?;
    Ok(catalog)
}

fn validate_catalog(catalog: &Catalog) -> Result<(), String> {
    if catalog.schema != 1 {
        return Err(format!("unsupported catalog schema: {}", catalog.schema));
    }
    if !valid_utc_timestamp(&catalog.generated_at) {
        return Err("catalog generated_at must be a valid UTC timestamp ending in Z".to_string());
    }
    if catalog.models.is_empty() || catalog.models.len() > MAX_MODELS {
        return Err(format!(
            "catalog must contain between 1 and {MAX_MODELS} models"
        ));
    }

    let mut ids = BTreeSet::new();
    for model in &catalog.models {
        if !valid_identifier(&model.id) || !ids.insert(&model.id) {
            return Err(format!(
                "catalog model id is invalid or duplicated: {}",
                model.id
            ));
        }
        if model.family.is_empty()
            || model.family.len() > 64
            || !model.family.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
            })
        {
            return Err(format!("catalog model family is invalid: {}", model.family));
        }
        if model.name.trim().is_empty() || model.name.len() > 256 {
            return Err(format!("catalog model name is invalid: {}", model.id));
        }
        if let Some(params_b) = model.params_b
            && (!params_b.is_finite() || params_b <= 0.0 || params_b > 1000.0)
        {
            return Err(format!(
                "catalog parameter count is out of range: {}",
                model.id
            ));
        }
        if model.arch.layers == 0
            || model.arch.layers > 512
            || model.arch.kv_heads == 0
            || model.arch.kv_heads > 256
            || !(16..=512).contains(&model.arch.head_dim)
            || model.arch.context_max == 0
            || model.arch.context_max > 1_048_576
        {
            return Err(format!(
                "catalog architecture is out of range: {}",
                model.id
            ));
        }
        if model.license.spdx.trim().is_empty()
            || model.license.spdx.len() > 128
            || !matches!(model.license.kind.as_str(), "open_source" | "open_weight")
        {
            return Err(format!("catalog license is invalid: {}", model.id));
        }
        let license_url = Url::parse(&model.license.url)
            .map_err(|error| format!("catalog license URL is invalid for {}: {error}", model.id))?;
        if license_url.scheme() != "https"
            || license_url.host_str().is_none()
            || !license_url.username().is_empty()
            || license_url.password().is_some()
        {
            return Err(format!("catalog license URL is invalid: {}", model.id));
        }
        if model.tags.len() > 64
            || model
                .tags
                .iter()
                .any(|tag| tag.trim().is_empty() || tag.len() > 64)
        {
            return Err(format!("catalog tags are invalid: {}", model.id));
        }
        if model.quants.is_empty() || model.quants.len() > 64 {
            return Err(format!("catalog quantizations are invalid: {}", model.id));
        }
        if !valid_date(&model.added_at) {
            return Err(format!("catalog added_at date is invalid: {}", model.id));
        }
        let mut quant_names = BTreeSet::new();
        for quant in &model.quants {
            if quant.name.trim().is_empty()
                || quant.name.len() > 64
                || !quant
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
                || !quant_names.insert(quant.name.to_ascii_lowercase())
            {
                return Err(format!(
                    "catalog quantization name is invalid: {}",
                    model.id
                ));
            }
            if quant.size_bytes == 0 {
                return Err(format!(
                    "catalog quantization size must be positive: {}",
                    model.id
                ));
            }
            if quant.file.trim().is_empty()
                || quant.file.len() > 255
                || quant.file.contains('/')
                || quant.file.contains('\\')
                || quant.file == "."
                || quant.file == ".."
                || !quant.file.to_ascii_lowercase().ends_with(".gguf")
            {
                return Err(format!(
                    "catalog quantization filename is invalid: {}",
                    model.id
                ));
            }
            if quant.sha256.len() != 64
                || !quant.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(format!("catalog SHA-256 is invalid: {}", model.id));
            }
            validate_model_url(&quant.url).map_err(|error| {
                format!("catalog model URL is invalid for {}: {error}", model.id)
            })?;
        }
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    value
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

fn validate_model_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|error| error.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("huggingface.co")
        || !url.path().contains("/resolve/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("expected an HTTPS Hugging Face resolve URL".to_string());
    }
    Ok(())
}

fn valid_utc_timestamp(value: &str) -> bool {
    value.len() == 20
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(19) == Some(&b'Z')
        && value.get(..10).is_some_and(valid_date)
        && value.get(11..19).is_some_and(valid_time)
}

fn valid_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 8
        || bytes[2] != b':'
        || bytes[5] != b':'
        || ![0, 1, 3, 4, 6, 7]
            .iter()
            .all(|index| bytes[*index].is_ascii_digit())
    {
        return false;
    }
    let hour = u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0');
    let minute = u32::from(bytes[3] - b'0') * 10 + u32::from(bytes[4] - b'0');
    let second = u32::from(bytes[6] - b'0') * 10 + u32::from(bytes[7] - b'0');
    hour < 24 && minute < 60 && second < 60
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || ![0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|index| bytes[*index].is_ascii_digit())
    {
        return false;
    }
    let year = u32::from(bytes[0] - b'0') * 1000
        + u32::from(bytes[1] - b'0') * 100
        + u32::from(bytes[2] - b'0') * 10
        + u32::from(bytes[3] - b'0');
    let month = u32::from(bytes[5] - b'0') * 10 + u32::from(bytes[6] - b'0');
    let day = u32::from(bytes[8] - b'0') * 10 + u32::from(bytes[9] - b'0');
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap_year => 29,
        2 => 28,
        _ => return false,
    };
    year >= 1970 && day > 0 && day <= days
}

pub fn model_specs(catalog: &Catalog) -> Vec<ModelSpec> {
    catalog
        .models
        .iter()
        .filter_map(|model| model.params_b.map(|params_b| (model, params_b)))
        .flat_map(|(model, params_b)| {
            model.quants.iter().map(move |quant| ModelSpec {
                id: format!("{}-{}", model.id, quant.name.to_ascii_lowercase()),
                name: model.name.clone(),
                family: model.family.clone(),
                params_b,
                active_params_b: params_b,
                quant: quant.name.clone(),
                file_size_bytes: quant.size_bytes,
                n_layers: model.arch.layers,
                n_kv_heads: model.arch.kv_heads,
                head_dim: model.arch.head_dim,
                context_max: model.arch.context_max,
                license: License {
                    id: model.license.spdx.clone(),
                    osi_open: model.license.kind == "open_source",
                    url: model.license.url.clone(),
                },
                tags: if model.gated && !model.tags.iter().any(|tag| tag == "gated") {
                    model
                        .tags
                        .iter()
                        .cloned()
                        .chain(std::iter::once("gated".to_string()))
                        .collect()
                } else {
                    model.tags.clone()
                },
                verified: model.verified,
            })
        })
        .collect()
}

pub fn load_catalog(data_dir: &Path, bundled_json: &str) -> Result<CatalogLoad, String> {
    load_catalog_with_keys(data_dir, bundled_json, CATALOG_PUBLIC_KEYS)
}

fn load_catalog_with_keys(
    data_dir: &Path,
    bundled_json: &str,
    keys: &[&str],
) -> Result<CatalogLoad, String> {
    let bundled = validate_catalog_json(bundled_json.as_bytes())
        .map_err(|error| format!("bundled catalog is invalid: {error}"))?;
    let path = cache_path(data_dir);
    match fs::read(&path) {
        Ok(bytes) => {
            let cache: SignedCatalogCache = match serde_json::from_slice(&bytes) {
                Ok(cache) => cache,
                Err(error) => {
                    return Ok(discard_invalid_cache(
                        &path,
                        bundled,
                        format!("cached catalog data is invalid: {error}"),
                    ));
                }
            };
            if let Err(error) = verify_catalog(&cache.catalog_json, &cache.signature, keys) {
                return Ok(discard_invalid_cache(
                    &path,
                    bundled,
                    format!("cached catalog signature is invalid: {error}"),
                ));
            }
            match validate_catalog_json(&cache.catalog_json) {
                Ok(cached) if cached.generated_at > bundled.generated_at => Ok(CatalogLoad {
                    catalog: cached,
                    warning: None,
                    signature_verified: true,
                }),
                Ok(_) => Ok(CatalogLoad {
                    catalog: bundled,
                    warning: None,
                    signature_verified: false,
                }),
                Err(error) => Ok(discard_invalid_cache(
                    &path,
                    bundled,
                    format!("cached catalog is invalid: {error}"),
                )),
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(CatalogLoad {
            catalog: bundled,
            warning: None,
            signature_verified: false,
        }),
        Err(error) => Ok(CatalogLoad {
            catalog: bundled,
            warning: Some(format!(
                "Cached catalog could not be read; using the bundled catalog. {error}"
            )),
            signature_verified: false,
        }),
    }
}

fn discard_invalid_cache(path: &Path, bundled: Catalog, reason: String) -> CatalogLoad {
    let warning = match fs::remove_file(path) {
        Ok(()) => {
            eprintln!("{reason}; discarded the cache and using the bundled catalog.");
            format!("Cached catalog was rejected; using the bundled catalog. {reason}")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            format!("Cached catalog was rejected; using the bundled catalog. {reason}")
        }
        Err(error) => {
            eprintln!("could not remove invalid catalog cache: {error}");
            format!(
                "Cached catalog was rejected; using the bundled catalog. {reason} Cache removal failed: {error}"
            )
        }
    };
    CatalogLoad {
        catalog: bundled,
        warning: Some(warning),
        signature_verified: false,
    }
}

pub fn catalog_info(data_dir: &Path, bundled_json: &str) -> Result<CatalogInfo, String> {
    let loaded = load_catalog(data_dir, bundled_json)?;
    let settings = load_settings(data_dir)?;
    let families = families(&loaded.catalog);
    let mut warnings = Vec::new();
    if let Some(warning) = loaded.warning {
        warnings.push(warning);
    }
    let subscribed_families = match settings.subscribed_families {
        Some(selected) => {
            let selected_count = selected.len();
            let available: BTreeSet<_> = families.iter().map(String::as_str).collect();
            let known: Vec<_> = selected
                .into_iter()
                .filter(|family| available.contains(family.as_str()))
                .collect();
            if known.len() != selected_count {
                warnings.push(
                    "Some saved model-family subscriptions are unavailable in this catalog."
                        .to_string(),
                );
            }
            known
        }
        None => families.clone(),
    };
    let models_without_params = loaded
        .catalog
        .models
        .iter()
        .filter(|model| model.params_b.is_none())
        .count();
    if models_without_params > 0 {
        warnings.push(format!(
            "{models_without_params} catalog model(s) without a parameter count are excluded from recommendations."
        ));
    }
    Ok(CatalogInfo {
        generated_at: loaded.catalog.generated_at,
        families,
        subscribed_families,
        refresh_catalog_always_allowed: settings.refresh_catalog_always_allowed,
        warning: (!warnings.is_empty()).then(|| warnings.join(" ")),
        signature_verified: loaded.signature_verified,
    })
}

pub fn set_subscribed_families(
    data_dir: &Path,
    bundled_json: &str,
    selected: Vec<String>,
) -> Result<CatalogInfo, String> {
    let available: BTreeSet<_> = families(&load_catalog(data_dir, bundled_json)?.catalog)
        .into_iter()
        .collect();
    let selected_set: BTreeSet<_> = selected.iter().cloned().collect();
    if selected_set.len() != selected.len()
        || selected.iter().any(|family| !available.contains(family))
    {
        return Err("subscribed model families contain an unknown or duplicate family".to_string());
    }
    let mut settings = load_settings(data_dir)?;
    settings.subscribed_families = Some(selected);
    save_settings(data_dir, &settings)?;
    catalog_info(data_dir, bundled_json)
}

pub fn set_refresh_consent(data_dir: &Path, always_allowed: bool) -> Result<(), String> {
    let mut settings = load_settings(data_dir)?;
    settings.refresh_catalog_always_allowed = always_allowed;
    save_settings(data_dir, &settings)
}

pub fn reset_catalog(data_dir: &Path, bundled_json: &str) -> Result<CatalogInfo, String> {
    match fs::remove_file(cache_path(data_dir)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("could not remove cached catalog: {error}")),
    }
    let available: BTreeSet<_> = families(
        &validate_catalog_json(bundled_json.as_bytes())
            .map_err(|error| format!("bundled catalog is invalid: {error}"))?,
    )
    .into_iter()
    .collect();
    let mut settings = load_settings(data_dir)?;
    if let Some(subscribed) = &mut settings.subscribed_families {
        subscribed.retain(|family| available.contains(family));
        save_settings(data_dir, &settings)?;
    }
    catalog_info(data_dir, bundled_json)
}

pub fn ensure_refresh_consent(always_allowed: bool, consent_once: bool) -> Result<(), String> {
    if always_allowed || consent_once {
        Ok(())
    } else {
        Err("catalog refresh requires explicit user consent".to_string())
    }
}

pub async fn refresh_catalog(
    data_dir: &Path,
    bundled_json: &str,
    consent_once: bool,
) -> Result<RefreshResult, String> {
    let settings = load_settings(data_dir)?;
    ensure_refresh_consent(settings.refresh_catalog_always_allowed, consent_once)?;
    let client = catalog_client()?;
    refresh_catalog_with(
        &client,
        CATALOG_URL,
        data_dir,
        bundled_json,
        CATALOG_PUBLIC_KEYS,
    )
    .await
}

fn catalog_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Aangan/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("could not configure catalog request: {error}"))
}

pub async fn refresh_catalog_with(
    client: &reqwest::Client,
    url: &str,
    data_dir: &Path,
    bundled_json: &str,
    keys: &[&str],
) -> Result<RefreshResult, String> {
    let parsed_url = Url::parse(url).map_err(|error| format!("catalog URL is invalid: {error}"))?;
    if !is_allowed_catalog_url(&parsed_url) && !is_local_test_catalog_url(&parsed_url) {
        return Err("catalog refresh URL is not allow-listed".to_string());
    }
    refresh_from_url(client, parsed_url, data_dir, bundled_json, keys).await
}

fn is_allowed_catalog_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("raw.githubusercontent.com")
        && url.path() == "/panthak4tech/aangan/main/catalog/models.v1.json"
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
fn is_local_test_catalog_url(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("127.0.0.1") | Some("localhost") | Some("::1")
        )
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(not(test))]
fn is_local_test_catalog_url(_url: &Url) -> bool {
    false
}

async fn refresh_from_url(
    client: &reqwest::Client,
    url: Url,
    data_dir: &Path,
    bundled_json: &str,
    keys: &[&str],
) -> Result<RefreshResult, String> {
    let existing = load_catalog_with_keys(data_dir, bundled_json, keys)?;
    let mut signature_url = url.clone();
    signature_url.set_path(&format!("{}.minisig", url.path()));
    let signature_url = Url::parse(signature_url.as_str())
        .map_err(|error| format!("catalog signature URL is invalid: {error}"))?;

    let bytes = fetch_limited(client, &url, MAX_CATALOG_BYTES, "catalog").await?;
    let signature_bytes = fetch_limited(
        client,
        &signature_url,
        MAX_SIGNATURE_BYTES,
        "catalog signature",
    )
    .await
    .map_err(|error| {
        if error.contains("unexpected status: 404") {
            signature_error_message(SignatureError::Malformed)
        } else {
            error
        }
    })?;
    let signature = std::str::from_utf8(&signature_bytes)
        .map_err(|_| signature_error_message(SignatureError::Malformed))?;
    verify_catalog(&bytes, signature, keys).map_err(signature_error_message)?;
    let downloaded = validate_catalog_json(&bytes)?;
    if downloaded.generated_at <= existing.catalog.generated_at {
        return Ok(RefreshResult {
            generated_at: existing.catalog.generated_at,
            model_count: existing.catalog.models.len(),
            added: 0,
            updated: 0,
        });
    }
    let (added, updated) = catalog_diff(&existing.catalog, &downloaded);
    let cache = SignedCatalogCache {
        catalog_json: bytes,
        signature: signature.to_string(),
    };
    let cache_bytes = serde_json::to_vec(&cache)
        .map_err(|error| format!("could not encode signed catalog cache: {error}"))?;
    write_atomic(&cache_path(data_dir), &cache_bytes, "cached catalog")?;
    Ok(RefreshResult {
        generated_at: downloaded.generated_at,
        model_count: downloaded.models.len(),
        added,
        updated,
    })
}

fn signature_error_message(error: SignatureError) -> String {
    match error {
        SignatureError::NoKeys => "catalog_signature:no_keys".to_string(),
        SignatureError::Malformed => "catalog_signature:malformed".to_string(),
        SignatureError::Untrusted => "catalog_signature:untrusted".to_string(),
    }
}

async fn fetch_limited(
    client: &reqwest::Client,
    url: &Url,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("could not download {label}: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "{label} server returned an unexpected status: {}",
            response.status()
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("{label} exceeds the size limit"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("could not read {label} response: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("{label} exceeds the size limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn catalog_diff(previous: &Catalog, next: &Catalog) -> (usize, usize) {
    let previous: BTreeMap<_, _> = previous
        .models
        .iter()
        .map(|model| (&model.id, model))
        .collect();
    let mut added = 0;
    let mut updated = 0;
    for model in &next.models {
        match previous.get(&model.id) {
            None => added += 1,
            Some(old) if *old != model => updated += 1,
            Some(_) => {}
        }
    }
    (added, updated)
}

fn families(catalog: &Catalog) -> Vec<String> {
    catalog
        .models
        .iter()
        .map(|model| model.family.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn load_settings(data_dir: &Path) -> Result<AppSettings, String> {
    match fs::read(settings_path(data_dir)) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("application settings are invalid: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(AppSettings::default()),
        Err(error) => Err(format!("could not read application settings: {error}")),
    }
}

fn save_settings(data_dir: &Path, settings: &AppSettings) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("could not encode application settings: {error}"))?;
    write_atomic(&settings_path(data_dir), &bytes, "application settings")
}

fn write_atomic(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("could not determine the {label} directory"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("could not create data directory: {error}"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("could not create a temporary {label} file: {error}"))?;
    temporary
        .write_all(bytes)
        .map_err(|error| format!("could not write {label}: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("could not flush {label}: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("could not save {label}: {}", error.error))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const BUNDLED: &str = include_str!("../../../../catalog/models.v1.json");
    const SIGNED_CATALOG: &[u8] = include_bytes!("../tests/fixtures/catalog-signed.json");
    const SIGNED_CATALOG_SIGNATURE: &str =
        include_str!("../tests/fixtures/catalog-signed.json.minisig");
    const OLDER_CATALOG: &[u8] = include_bytes!("../tests/fixtures/catalog-older.json");
    const OLDER_CATALOG_SIGNATURE: &str =
        include_str!("../tests/fixtures/catalog-older.json.minisig");
    const OTHER_CATALOG_SIGNATURE: &str =
        include_str!("../tests/fixtures/catalog-other.json.minisig");
    const TEST_PUBLIC_KEY: &str = include_str!("../tests/fixtures/catalog-test.pub");

    fn test_public_key() -> String {
        TEST_PUBLIC_KEY
            .lines()
            .nth(1)
            .expect("test public key file has a key line")
            .trim()
            .to_string()
    }

    fn catalog_json() -> Value {
        serde_json::from_str(BUNDLED).expect("fixture catalog JSON")
    }

    fn encoded(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("serialize fixture")
    }

    #[test]
    fn validates_bundled_catalog_and_maps_model_specs() {
        let catalog = validate_catalog_json(BUNDLED.as_bytes()).expect("valid bundled catalog");
        let specs = model_specs(&catalog);
        assert_eq!(specs.len(), 7);
        assert_eq!(specs[0].id, "qwen2.5-0.5b-instruct-q4_k_m");
        assert!(!specs[2].license.osi_open);
        assert_eq!(specs[3].tags, ["chat", "coding"]);
        assert_eq!(specs[6].file_size_bytes, 47_415_715_488);
    }

    #[test]
    fn migrates_legacy_catalog_files_without_overwriting_new_data() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let legacy = directory.path().join("legacy");
        let current = directory.path().join("Aangan");
        fs::create_dir_all(&legacy).expect("legacy directory");
        fs::create_dir_all(&current).expect("current directory");
        fs::write(legacy.join(CATALOG_FILE), "old cache").expect("legacy cache");
        fs::write(legacy.join(SETTINGS_FILE), "old settings").expect("legacy settings");
        fs::write(current.join(SETTINGS_FILE), "new settings").expect("current settings");

        migrate_legacy_data(&legacy, &current).expect("migration succeeds");

        assert_eq!(
            fs::read_to_string(current.join(CATALOG_FILE)).expect("migrated cache"),
            "old cache"
        );
        assert_eq!(
            fs::read_to_string(current.join(SETTINGS_FILE)).expect("current settings"),
            "new settings"
        );
        assert!(legacy.join(CATALOG_FILE).exists());
        fs::remove_file(current.join(CATALOG_FILE)).expect("remove migrated cache");
        migrate_legacy_data(&legacy, &current).expect("migration does not repeat");
        assert!(!current.join(CATALOG_FILE).exists());
    }

    #[test]
    fn marks_gated_models_in_recommendation_tags() {
        let mut value = catalog_json();
        value["models"][0]["gated"] = Value::from(true);
        let catalog = validate_catalog_json(&encoded(&value)).expect("valid gated catalog");
        let specs = model_specs(&catalog);
        assert!(specs[0].tags.iter().any(|tag| tag == "gated"));
    }

    #[test]
    fn rejects_oversize_catalog_and_invalid_schema_version() {
        let error = validate_catalog_json(&vec![b' '; MAX_CATALOG_BYTES + 1])
            .expect_err("oversize catalog should fail");
        assert!(error.contains("5 MiB"));
        let mut value = catalog_json();
        value["schema"] = Value::from(2);
        let error = validate_catalog_json(&encoded(&value)).expect_err("unsupported schema");
        assert!(error.contains("schema"));
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_timestamps() {
        let mut value = catalog_json();
        value["unexpected"] = Value::from(true);
        assert!(validate_catalog_json(&encoded(&value)).is_err());

        let mut value = catalog_json();
        value["generated_at"] = Value::from("2026-02-30T13:30:00Z");
        assert!(validate_catalog_json(&encoded(&value)).is_err());

        let mut value = catalog_json();
        value["models"][0]
            .as_object_mut()
            .expect("model object")
            .remove("params_b");
        assert!(validate_catalog_json(&encoded(&value)).is_err());
    }

    #[test]
    fn rejects_invalid_ranges_hashes_and_model_urls() {
        let mut value = catalog_json();
        value["models"][0]["arch"]["layers"] = Value::from(0);
        assert!(validate_catalog_json(&encoded(&value)).is_err());

        let mut value = catalog_json();
        value["models"][0]["quants"][0]["sha256"] = Value::from("abc");
        assert!(validate_catalog_json(&encoded(&value)).is_err());

        let mut value = catalog_json();
        value["models"][0]["quants"][0]["url"] = Value::from("https://evil.example/model.gguf");
        assert!(validate_catalog_json(&encoded(&value)).is_err());
    }

    #[test]
    fn invalid_cache_falls_back_with_a_visible_warning() {
        let directory = tempfile::tempdir().expect("temporary directory");
        fs::write(cache_path(directory.path()), b"{bad json").expect("write invalid cache");
        let loaded = load_catalog(directory.path(), BUNDLED).expect("bundled fallback");
        assert_eq!(loaded.catalog.generated_at, "2026-10-21T13:30:00Z");
        assert!(loaded.warning.is_some());
        assert!(!cache_path(directory.path()).exists());
    }

    #[test]
    fn bad_cache_signature_is_discarded_and_bundled_catalog_is_used() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let cache = SignedCatalogCache {
            catalog_json: SIGNED_CATALOG.to_vec(),
            signature: OTHER_CATALOG_SIGNATURE.to_string(),
        };
        fs::write(
            cache_path(directory.path()),
            serde_json::to_vec(&cache).expect("encode bad signed cache"),
        )
        .expect("write bad signed cache");
        let test_key = test_public_key();

        let loaded = load_catalog_with_keys(directory.path(), BUNDLED, &[&test_key])
            .expect("bundled fallback");

        assert_eq!(loaded.catalog.generated_at, "2026-10-21T13:30:00Z");
        assert!(!loaded.signature_verified);
        assert!(loaded.warning.unwrap().contains("signature is invalid"));
        assert!(!cache_path(directory.path()).exists());
    }

    #[test]
    fn verified_newer_cache_is_used_and_marked_verified() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let cache = SignedCatalogCache {
            catalog_json: SIGNED_CATALOG.to_vec(),
            signature: SIGNED_CATALOG_SIGNATURE.to_string(),
        };
        fs::write(
            cache_path(directory.path()),
            serde_json::to_vec(&cache).expect("encode signed cache"),
        )
        .expect("write signed cache");
        let test_key = test_public_key();

        let loaded = load_catalog_with_keys(directory.path(), BUNDLED, &[&test_key])
            .expect("verified cache");

        assert_eq!(loaded.catalog.generated_at, "2026-10-22T13:30:00Z");
        assert!(loaded.signature_verified);
    }

    #[test]
    fn subscription_settings_validate_and_round_trip() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let initial = catalog_info(directory.path(), BUNDLED).expect("initial catalog settings");
        assert_eq!(initial.subscribed_families, ["qwen2.5"]);
        let updated =
            set_subscribed_families(directory.path(), BUNDLED, vec!["qwen2.5".to_string()])
                .expect("save family selection");
        assert_eq!(updated.subscribed_families, ["qwen2.5"]);
        let error = set_subscribed_families(directory.path(), BUNDLED, vec!["unknown".to_string()])
            .expect_err("unknown family should fail");
        assert!(error.contains("unknown"));
    }

    #[test]
    fn unknown_parameter_counts_are_skipped_with_a_visible_warning() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut value = catalog_json();
        value["models"][0]["params_b"] = Value::Null;
        let json = serde_json::to_string(&value).expect("serialize fixture");
        let info = catalog_info(directory.path(), &json).expect("catalog info");
        assert!(
            info.warning
                .unwrap()
                .contains("excluded from recommendations")
        );
        let catalog = validate_catalog_json(json.as_bytes()).expect("valid null parameter count");
        assert_eq!(model_specs(&catalog).len(), 6);
    }

    #[test]
    fn resetting_catalog_prunes_unavailable_subscriptions_and_preserves_consent() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut cached: Value = catalog_json();
        cached["generated_at"] = Value::from("2026-10-22T13:30:00Z");
        cached["models"][0]["family"] = Value::from("new-family");
        fs::write(
            cache_path(directory.path()),
            serde_json::to_vec(&cached).expect("serialize newer catalog"),
        )
        .expect("write newer catalog");
        fs::write(
            settings_path(directory.path()),
            r#"{"refresh_catalog_always_allowed":true,"subscribed_families":["new-family"]}"#,
        )
        .expect("write preferences");

        let reset = reset_catalog(directory.path(), BUNDLED).expect("reset to bundled catalog");
        assert_eq!(reset.subscribed_families, Vec::<String>::new());
        assert!(reset.refresh_catalog_always_allowed);
        assert!(!cache_path(directory.path()).exists());
    }

    #[test]
    fn refresh_requires_consent() {
        assert!(ensure_refresh_consent(false, false).is_err());
        assert!(ensure_refresh_consent(false, true).is_ok());
        assert!(ensure_refresh_consent(true, false).is_ok());
    }

    #[test]
    fn refresh_url_is_fixed_to_allow_listed_repository_path() {
        assert!(is_allowed_catalog_url(
            &Url::parse(CATALOG_URL).expect("valid catalog URL")
        ));
        for url in [
            "https://example.com/panthak4tech/aangan/main/catalog/models.v1.json",
            "http://raw.githubusercontent.com/panthak4tech/aangan/main/catalog/models.v1.json",
            "https://raw.githubusercontent.com:8443/panthak4tech/aangan/main/catalog/models.v1.json",
            "https://raw.githubusercontent.com/panthak4tech/aangan/main/catalog/models.v1.json?x=1",
            "https://raw.githubusercontent.com/other/repository/main/catalog/models.v1.json",
        ] {
            assert!(
                !is_allowed_catalog_url(&Url::parse(url).expect("parse candidate URL")),
                "URL should not be allow-listed: {url}"
            );
        }
    }

    #[tokio::test]
    async fn refresh_rejects_unallowlisted_url_before_requesting() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let error = refresh_catalog_with(
            &reqwest::Client::new(),
            "https://example.com/catalog.json",
            directory.path(),
            BUNDLED,
            CATALOG_PUBLIC_KEYS,
        )
        .await
        .expect_err("unallowlisted host should be rejected");
        assert!(error.contains("not allow-listed"));
        assert!(!cache_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn refresh_does_not_follow_redirects() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/elsewhere.json"))
            .mount(&server)
            .await;
        let url = Url::parse(&format!("{}/catalog.json", server.uri())).expect("mock URL");
        let error = refresh_from_url(
            &catalog_client().expect("catalog client"),
            url,
            directory.path(),
            BUNDLED,
            CATALOG_PUBLIC_KEYS,
        )
        .await
        .expect_err("redirect response should not be followed");
        assert!(error.contains("unexpected status"));
        assert!(!cache_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn refresh_stores_newer_catalog_atomically_and_reports_diff() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(SIGNED_CATALOG))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/catalog.json.minisig"))
            .respond_with(ResponseTemplate::new(200).set_body_string(SIGNED_CATALOG_SIGNATURE))
            .mount(&server)
            .await;

        let client = catalog_client().expect("catalog client");
        let local_url =
            Url::parse(&format!("{}/catalog.json", server.uri())).expect("local mock server URL");
        let test_key = test_public_key();
        let result = refresh_catalog_with(
            &client,
            local_url.as_str(),
            directory.path(),
            BUNDLED,
            &[&test_key],
        )
        .await
        .expect("refresh from local mock server");
        assert_eq!(result.model_count, 7);
        assert_eq!(result.added, 0);
        assert_eq!(result.updated, 0);
        let loaded = load_catalog_with_keys(directory.path(), BUNDLED, &[&test_key])
            .expect("read newly cached catalog");
        assert_eq!(loaded.catalog.generated_at, "2026-10-22T13:30:00Z");
        assert!(loaded.signature_verified);
    }

    #[tokio::test]
    async fn refresh_rejects_tampered_catalog_before_parsing() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let mut tampered = SIGNED_CATALOG.to_vec();
        tampered[0] ^= 1;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(tampered))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/catalog.json.minisig"))
            .respond_with(ResponseTemplate::new(200).set_body_string(SIGNED_CATALOG_SIGNATURE))
            .mount(&server)
            .await;
        let test_key = test_public_key();
        let url = format!("{}/catalog.json", server.uri());

        let error = refresh_catalog_with(
            &catalog_client().expect("catalog client"),
            &url,
            directory.path(),
            BUNDLED,
            &[&test_key],
        )
        .await
        .expect_err("tampered JSON must fail signature verification");

        assert_eq!(error, "catalog_signature:untrusted");
        assert!(!cache_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn refresh_rejects_missing_signature() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(SIGNED_CATALOG))
            .mount(&server)
            .await;
        let test_key = test_public_key();
        let url = format!("{}/catalog.json", server.uri());

        let error = refresh_catalog_with(
            &catalog_client().expect("catalog client"),
            &url,
            directory.path(),
            BUNDLED,
            &[&test_key],
        )
        .await
        .expect_err("missing signature must fail");

        assert_eq!(error, "catalog_signature:malformed");
        assert!(!cache_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn refresh_rejects_signature_from_another_key() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(SIGNED_CATALOG))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/catalog.json.minisig"))
            .respond_with(ResponseTemplate::new(200).set_body_string(OTHER_CATALOG_SIGNATURE))
            .mount(&server)
            .await;
        let test_key = test_public_key();
        let url = format!("{}/catalog.json", server.uri());

        let error = refresh_catalog_with(
            &catalog_client().expect("catalog client"),
            &url,
            directory.path(),
            BUNDLED,
            &[&test_key],
        )
        .await
        .expect_err("untrusted key signature must fail");

        assert_eq!(error, "catalog_signature:untrusted");
        assert!(!cache_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn valid_but_older_catalog_is_ignored() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(OLDER_CATALOG))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/catalog.json.minisig"))
            .respond_with(ResponseTemplate::new(200).set_body_string(OLDER_CATALOG_SIGNATURE))
            .mount(&server)
            .await;
        let test_key = test_public_key();
        let url = format!("{}/catalog.json", server.uri());

        let result = refresh_catalog_with(
            &catalog_client().expect("catalog client"),
            &url,
            directory.path(),
            BUNDLED,
            &[&test_key],
        )
        .await
        .expect("older signed catalog is valid but stale");

        assert_eq!(result.generated_at, "2026-10-21T13:30:00Z");
        assert_eq!(result.added, 0);
        assert!(!cache_path(directory.path()).exists());
    }

    #[tokio::test]
    async fn oversized_response_keeps_existing_cache_unchanged() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let original = SignedCatalogCache {
            catalog_json: SIGNED_CATALOG.to_vec(),
            signature: SIGNED_CATALOG_SIGNATURE.to_string(),
        };
        let original_bytes = serde_json::to_vec(&original).expect("encode existing cache");
        fs::write(cache_path(directory.path()), &original_bytes).expect("write existing cache");
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/catalog.json"))
            .respond_with(
                ResponseTemplate::new(200).set_body_bytes(vec![b'x'; MAX_CATALOG_BYTES + 1]),
            )
            .mount(&server)
            .await;
        let url = Url::parse(&format!("{}/catalog.json", server.uri())).expect("mock URL");
        let error = refresh_from_url(
            &reqwest::Client::new(),
            url,
            directory.path(),
            BUNDLED,
            &[&test_public_key()],
        )
        .await
        .expect_err("oversize response should be rejected");
        assert!(error.contains("size limit"));
        assert_eq!(
            fs::read(cache_path(directory.path())).expect("cache remains"),
            original_bytes
        );
    }

    #[test]
    fn committed_catalog_has_a_valid_signature_from_a_trusted_key() {
        let catalog_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../catalog");
        let json = fs::read(catalog_dir.join("models.v1.json")).expect("bundled catalog");
        let signature = fs::read_to_string(catalog_dir.join("models.v1.json.minisig"))
            .expect("bundled catalog signature is missing");
        verify_catalog(&json, &signature, CATALOG_PUBLIC_KEYS)
            .expect("bundled catalog signature is invalid");
    }
}
