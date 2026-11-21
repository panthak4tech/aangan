use crate::variant::Variant;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeFile {
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeVariant {
    #[serde(flatten)]
    pub meta: Variant,
    pub files: Vec<RuntimeFile>,
    pub server_exe: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeEntry {
    pub id: String,
    pub display_name: String,
    pub version: String,
    pub license: String,
    pub homepage: String,
    pub variants: Vec<RuntimeVariant>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RuntimeManifest {
    pub schema: u32,
    pub generated_at: String,
    pub runtimes: Vec<RuntimeEntry>,
}

pub const MAX_MANIFEST_BYTES: usize = 1024 * 1024;

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_safe_component(value: &str) -> bool {
    !value.is_empty()
        && value != "."
        && value != ".."
        && !value.contains("..")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 20
        || !bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 | 16 => *byte == b':',
            19 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
    {
        return false;
    }
    let parse =
        |range: std::ops::Range<usize>| value.get(range).and_then(|part| part.parse::<u32>().ok());
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        parse(0..4),
        parse(5..7),
        parse(8..10),
        parse(11..13),
        parse(14..16),
        parse(17..19),
    ) else {
        return false;
    };
    if year < 1970 || !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    let leap_year = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        2 if leap_year => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    (1..=days_in_month).contains(&day)
}

pub fn validate(m: &RuntimeManifest) -> Result<(), String> {
    if m.schema != 1 {
        return Err(format!("unsupported manifest schema {}", m.schema));
    }
    if !valid_timestamp(&m.generated_at) {
        return Err("manifest generated_at must be a UTC timestamp ending in Z".into());
    }
    let mut runtime_ids = BTreeSet::new();
    for r in &m.runtimes {
        if !is_safe_component(&r.id)
            || !is_safe_component(&r.version)
            || r.id == "_downloads"
            || !runtime_ids.insert(&r.id)
        {
            return Err(format!("runtime id or version is invalid: {}", r.id));
        }
        let mut variant_ids = BTreeSet::new();
        for v in &r.variants {
            if !is_safe_component(&v.meta.variant)
                || v.meta.variant.ends_with(".tmp")
                || !variant_ids.insert(&v.meta.variant)
                || v.files.is_empty()
                || v.server_exe.contains("..")
                || v.server_exe.starts_with('/')
                || v.server_exe.starts_with('\\')
                || v.server_exe.contains('\\')
                || v.server_exe.contains(':')
                || v.server_exe
                    .split('/')
                    .any(|component| !is_safe_component(component))
            {
                return Err(format!("bad variant {}", v.meta.variant));
            }
            for f in &v.files {
                if !f.url.starts_with("https://") || !is_hex64(&f.sha256) || f.size_bytes == 0 {
                    return Err(format!("bad file entry in variant {}", v.meta.variant));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(sha: &str, url: &str) -> RuntimeManifest {
        serde_json::from_value(serde_json::json!({
            "schema": 1, "generated_at": "2026-11-01T00:00:00Z",
            "runtimes": [{
                "id": "llama.cpp", "display_name": "llama.cpp", "version": "b1", "license": "MIT",
                "homepage": "https://github.com/ggml-org/llama.cpp",
                "variants": [{
                    "variant": "cpu", "kind": "cpu", "server_exe": "llama-server.exe",
                    "files": [{ "url": url, "sha256": sha, "size_bytes": 10 }]
                }]
            }]
        }))
        .unwrap()
    }

    #[test]
    fn accepts_valid() {
        let sha = "a".repeat(64);
        assert!(validate(&sample(&sha, "https://github.com/x/y.zip")).is_ok());
    }

    #[test]
    fn rejects_bad_sha_and_http() {
        assert!(validate(&sample("zz", "https://github.com/x/y.zip")).is_err());
        let sha = "a".repeat(64);
        assert!(validate(&sample(&sha, "http://github.com/x/y.zip")).is_err());
    }

    #[test]
    fn rejects_path_components_and_invalid_timestamps() {
        let sha = "a".repeat(64);
        let mut manifest = sample(&sha, "https://github.com/x/y.zip");
        manifest.runtimes[0].id = "../outside".into();
        assert!(validate(&manifest).is_err());

        let mut manifest = sample(&sha, "https://github.com/x/y.zip");
        manifest.runtimes[0].variants[0].server_exe = "..\\outside.exe".into();
        assert!(validate(&manifest).is_err());

        let mut manifest = sample(&sha, "https://github.com/x/y.zip");
        manifest.generated_at = "not-a-time".into();
        assert!(validate(&manifest).is_err());

        let mut manifest = sample(&sha, "https://github.com/x/y.zip");
        manifest.generated_at = "2026-02-29T00:00:00Z".into();
        assert!(validate(&manifest).is_err());

        let mut manifest = sample(&sha, "https://github.com/x/y.zip");
        manifest.runtimes[0].variants[0].server_exe = "bin//llama-server.exe".into();
        assert!(validate(&manifest).is_err());
    }

    #[test]
    fn rejects_invalid_manifest_entries_independently() {
        let sha = "a".repeat(64);
        let valid = sample(&sha, "https://github.com/x/y.zip");

        let mut unsupported_schema = valid.clone();
        unsupported_schema.schema = 2;

        let mut duplicate_runtime = valid.clone();
        duplicate_runtime.runtimes.push(valid.runtimes[0].clone());

        let mut duplicate_variant = valid.clone();
        duplicate_variant.runtimes[0]
            .variants
            .push(valid.runtimes[0].variants[0].clone());

        let mut reserved_runtime_id = valid.clone();
        reserved_runtime_id.runtimes[0].id = "_downloads".into();

        let mut reserved_variant_suffix = valid.clone();
        reserved_variant_suffix.runtimes[0].variants[0].meta.variant = "cpu.tmp".into();

        let mut empty_files = valid.clone();
        empty_files.runtimes[0].variants[0].files.clear();

        let mut zero_size = valid;
        zero_size.runtimes[0].variants[0].files[0].size_bytes = 0;

        for (case, manifest) in [
            ("unsupported schema", unsupported_schema),
            ("duplicate runtime id", duplicate_runtime),
            ("duplicate variant id", duplicate_variant),
            ("reserved runtime id", reserved_runtime_id),
            ("reserved temporary suffix", reserved_variant_suffix),
            ("empty files", empty_files),
            ("zero file size", zero_size),
        ] {
            assert!(validate(&manifest).is_err(), "{case} should be rejected");
        }
    }
}
