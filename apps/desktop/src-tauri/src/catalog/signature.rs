use minisign_verify::{PublicKey, Signature};

pub const CATALOG_PUBLIC_KEYS: &[&str] = &[
    "RWRlfTieZDoCHfT8+RC/xGAgBj1GSKvosrHEa+7DQXiaO6m30uoQKZaw",
    "RWRX8RqQBLMDLvgDGOseesbcsFXqRGzibRcvUlcfU56QYE52LoR3lT/1",
];

#[derive(Debug, PartialEq, Eq)]
pub enum SignatureError {
    NoKeys,
    Malformed,
    Untrusted,
}

impl std::fmt::Display for SignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoKeys => write!(f, "no trusted catalog keys are configured"),
            Self::Malformed => write!(f, "the catalog signature is missing or malformed"),
            Self::Untrusted => write!(f, "the catalog is not signed by Aangan"),
        }
    }
}

impl std::error::Error for SignatureError {}

pub fn verify_catalog(
    bytes: &[u8],
    signature_text: &str,
    keys: &[&str],
) -> Result<(), SignatureError> {
    if keys.is_empty() {
        return Err(SignatureError::NoKeys);
    }
    let signature = Signature::decode(signature_text).map_err(|_| SignatureError::Malformed)?;
    for key in keys {
        match PublicKey::from_base64(key) {
            Ok(public_key) if public_key.verify(bytes, &signature, false).is_ok() => {
                return Ok(());
            }
            _ => {}
        }
    }
    Err(SignatureError::Untrusted)
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &[u8] = include_bytes!("../../tests/fixtures/catalog-signed.json");
    const SIGNATURE: &str = include_str!("../../tests/fixtures/catalog-signed.json.minisig");
    const TEST_KEY: &str = include_str!("../../tests/fixtures/catalog-test.pub");
    const OTHER_KEY: &str = include_str!("../../tests/fixtures/catalog-other.pub");

    fn key(public_key_file: &str) -> String {
        public_key_file
            .lines()
            .nth(1)
            .expect("public key file has a key line")
            .trim()
            .to_string()
    }

    #[test]
    fn accepts_a_signature_from_any_trusted_key() {
        assert_eq!(verify_catalog(JSON, SIGNATURE, &[&key(TEST_KEY)]), Ok(()));
        assert_eq!(
            verify_catalog(JSON, SIGNATURE, &[&key(OTHER_KEY), &key(TEST_KEY)]),
            Ok(())
        );
    }

    #[test]
    fn rejects_tampered_content_and_untrusted_keys() {
        let mut tampered = JSON.to_vec();
        tampered[0] ^= 1;
        assert_eq!(
            verify_catalog(&tampered, SIGNATURE, &[&key(TEST_KEY)]),
            Err(SignatureError::Untrusted)
        );
        assert_eq!(
            verify_catalog(JSON, SIGNATURE, &[&key(OTHER_KEY)]),
            Err(SignatureError::Untrusted)
        );
    }

    #[test]
    fn rejects_malformed_signatures_and_empty_key_lists() {
        assert_eq!(
            verify_catalog(JSON, "not a minisign signature", &[&key(TEST_KEY)]),
            Err(SignatureError::Malformed)
        );
        assert_eq!(
            verify_catalog(JSON, SIGNATURE, &[]),
            Err(SignatureError::NoKeys)
        );
    }
}
