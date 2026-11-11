use serde::Serialize;
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Purpose {
    Catalog,
    RuntimeManifest,
    ModelDownload,
    RuntimeDownload,
}

impl Purpose {
    pub fn label(self) -> &'static str {
        match self {
            Self::Catalog => "Model list",
            Self::RuntimeManifest => "Runtime list",
            Self::ModelDownload => "Model download",
            Self::RuntimeDownload => "Runtime download",
        }
    }

    fn exact_hosts(self) -> &'static [&'static str] {
        match self {
            Self::Catalog | Self::RuntimeManifest => &["raw.githubusercontent.com"],
            Self::ModelDownload => &["huggingface.co"],
            Self::RuntimeDownload => &[
                "github.com",
                "release-assets.githubusercontent.com",
                "objects.githubusercontent.com",
            ],
        }
    }

    fn host_suffixes(self) -> &'static [&'static str] {
        match self {
            Self::ModelDownload => &[".hf.co"],
            _ => &[],
        }
    }
}

/// Accepts HTTPS URLs on port 443, without URL credentials, for the requested purpose.
pub fn is_allowed(purpose: Purpose, url: &Url) -> bool {
    if url.scheme() != "https" || url.port().is_some() {
        return false;
    }
    let has_user_info = url
        .as_str()
        .split_once("://")
        .and_then(|(_, remainder)| remainder.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'));
    if has_user_info || !url.username().is_empty() || url.password().is_some() {
        return false;
    }

    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();

    purpose.exact_hosts().contains(&host.as_str())
        || purpose
            .host_suffixes()
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(purpose: Purpose, url: &str) -> bool {
        is_allowed(purpose, &Url::parse(url).expect("test URL should parse"))
    }

    #[test]
    fn allows_hosts_for_their_purpose() {
        assert!(allowed(
            Purpose::Catalog,
            "https://raw.githubusercontent.com/o/r/main/catalog/models.v1.json"
        ));
        assert!(allowed(
            Purpose::RuntimeManifest,
            "https://raw.githubusercontent.com/o/r/main/runtimes.json"
        ));
        assert!(allowed(
            Purpose::ModelDownload,
            "https://huggingface.co/o/r/resolve/main/m.gguf"
        ));
        assert!(allowed(
            Purpose::ModelDownload,
            "https://cas-bridge.xethub.hf.co/x"
        ));
        assert!(allowed(
            Purpose::ModelDownload,
            "https://cdn-lfs-us-1.hf.co/x"
        ));
        assert!(allowed(
            Purpose::RuntimeDownload,
            "https://github.com/ggml-org/llama.cpp/releases/download/b1/a.zip"
        ));
        assert!(allowed(
            Purpose::RuntimeDownload,
            "https://release-assets.githubusercontent.com/x"
        ));
        assert!(allowed(
            Purpose::RuntimeDownload,
            "https://objects.githubusercontent.com/x"
        ));
    }

    #[test]
    fn rejects_wrong_schemes_hosts_ports_and_credentials() {
        assert!(!allowed(
            Purpose::Catalog,
            "http://raw.githubusercontent.com/x"
        ));
        assert!(!allowed(Purpose::Catalog, "https://example.com/x"));
        assert!(!allowed(Purpose::Catalog, "https://huggingface.co/x"));
        assert!(!allowed(
            Purpose::ModelDownload,
            "https://evil.hf.co.attacker.com/x"
        ));
        assert!(!allowed(Purpose::ModelDownload, "https://hf.co/x"));
        assert!(!allowed(
            Purpose::ModelDownload,
            "https://huggingface.co:8443/x"
        ));
        assert!(!allowed(
            Purpose::RuntimeDownload,
            "https://user:pass@github.com/x"
        ));
        assert!(!allowed(Purpose::RuntimeDownload, "https://127.0.0.1/x"));
    }
}
