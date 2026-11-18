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

pub fn validate(m: &RuntimeManifest) -> Result<(), String> {
    if m.schema != 1 {
        return Err(format!("unsupported manifest schema {}", m.schema));
    }
    if m.generated_at.len() != 20
        || !m.generated_at.ends_with('Z')
        || !m
            .generated_at
            .bytes()
            .enumerate()
            .all(|(index, byte)| match index {
                4 | 7 => byte == b'-',
                10 => byte == b'T',
                13 | 16 => byte == b':',
                19 => byte == b'Z',
                _ => byte.is_ascii_digit(),
            })
    {
        return Err("manifest generated_at must be a UTC timestamp ending in Z".into());
    }
    let mut runtime_ids = BTreeSet::new();
    for r in &m.runtimes {
        if !is_safe_component(&r.id) || !is_safe_component(&r.version) || !runtime_ids.insert(&r.id)
        {
            return Err(format!("runtime id or version is invalid: {}", r.id));
        }
        let mut variant_ids = BTreeSet::new();
        for v in &r.variants {
            if !is_safe_component(&v.meta.variant)
                || !variant_ids.insert(&v.meta.variant)
                || v.files.is_empty()
                || v.server_exe.contains("..")
                || v.server_exe.starts_with('/')
                || v.server_exe.starts_with('\\')
                || v.server_exe.contains('\\')
                || v.server_exe.contains(':')
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
    }
}
