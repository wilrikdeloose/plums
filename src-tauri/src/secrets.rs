use crate::storage::NativeError;
use keyring_core::{Entry, Error};
use reqwest::Url;
use std::sync::OnceLock;

const SERVICE: &str = "nl.fontys.plums";
const MAX_SECRET_LENGTH: usize = 4096;

static STORE: OnceLock<Result<(), String>> = OnceLock::new();

/// Selects the native OS credential store once. There is deliberately no fallback:
/// on platforms without one, saving a key fails instead of using plaintext.
fn init_store() -> Result<(), NativeError> {
    STORE
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            {
                windows_native_keyring_store::Store::new()
                    .map(|store| keyring_core::set_default_store(store))
                    .map_err(|e| e.to_string())
            }
            #[cfg(target_os = "macos")]
            {
                apple_native_keyring_store::keychain::Store::new()
                    .map(|store| keyring_core::set_default_store(store))
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(any(target_os = "windows", target_os = "macos")))]
            {
                Err("geen ondersteunde beveiligde opslag op dit besturingssysteem".to_string())
            }
        })
        .clone()
        .map_err(|e| {
            NativeError::new(
                "secret",
                format!("Beveiligde opslag van het besturingssysteem is niet beschikbaar: {e}"),
            )
        })
}

fn parse_scoped_endpoint(endpoint: &str) -> (&str, &str) {
    if let Some(rest) = endpoint.strip_prefix("canvas:") {
        ("canvas", rest)
    } else if let Some(rest) = endpoint.strip_prefix("mcp:") {
        ("mcp", rest)
    } else if let Some(rest) = endpoint.strip_prefix("ai:") {
        ("ai", rest)
    } else {
        ("ai", endpoint)
    }
}

/// Accepts only https URLs (http for loopback hosts) without embedded credentials.
pub fn validate_endpoint(endpoint: &str) -> Result<Url, NativeError> {
    let (_, raw_url) = parse_scoped_endpoint(endpoint);
    let url =
        Url::parse(raw_url).map_err(|_| NativeError::new("invalid-request", "Ongeldige URL."))?;
    let loopback = matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("[::1]")
    );
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err(NativeError::new(
                "invalid-request",
                "Gebruik https; http is alleen toegestaan voor localhost.",
            ))
        }
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(NativeError::new(
            "invalid-request",
            "Inloggegevens in de URL zijn niet toegestaan.",
        ));
    }
    Ok(url)
}

fn entry(endpoint: &str) -> Result<Entry, NativeError> {
    let (scope, raw_url) = parse_scoped_endpoint(endpoint);
    validate_endpoint(endpoint)?;
    init_store()?;
    Entry::new(SERVICE, &format!("{scope}:{raw_url}")).map_err(store_error)
}

fn store_error(e: Error) -> NativeError {
    NativeError::new("secret", format!("Beveiligde opslag gaf een fout: {e}"))
}

pub fn has(endpoint: &str) -> Result<bool, NativeError> {
    match entry(endpoint)?.get_password() {
        Ok(_) => Ok(true),
        Err(Error::NoEntry) => Ok(false),
        Err(e) => Err(store_error(e)),
    }
}

pub fn save(endpoint: &str, secret: &str) -> Result<(), NativeError> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(NativeError::new("secret", "Vul een API-sleutel in."));
    }
    if secret.len() > MAX_SECRET_LENGTH || secret.contains(['\r', '\n']) {
        return Err(NativeError::new(
            "secret",
            "Deze API-sleutel heeft een ongeldig formaat.",
        ));
    }
    entry(endpoint)?.set_password(secret).map_err(store_error)
}

pub fn remove(endpoint: &str) -> Result<(), NativeError> {
    match entry(endpoint)?.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(e) => Err(store_error(e)),
    }
}

/// Only used by native HTTP code, for a request to exactly this endpoint.
pub(crate) fn resolve(endpoint: &str) -> Result<Option<String>, NativeError> {
    match entry(endpoint)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(Error::NoEntry) => Ok(None),
        Err(e) => Err(store_error(e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_rules() {
        assert!(validate_endpoint("https://api.example.com/v1/chat/completions").is_ok());
        assert!(validate_endpoint("canvas:https://fhict.instructure.com").is_ok());
        assert!(validate_endpoint("mcp:https://mcp.example.com/mcp").is_ok());
        assert!(validate_endpoint("http://127.0.0.1:8080/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://localhost/v1/chat/completions").is_ok());
        assert!(validate_endpoint("http://api.example.com/v1").is_err());
        assert!(validate_endpoint("https://user:pw@api.example.com/v1").is_err());
        assert!(validate_endpoint("file:///etc/passwd").is_err());
        assert!(validate_endpoint("niet een url").is_err());
        assert_eq!(
            parse_scoped_endpoint("canvas:https://fhict.instructure.com"),
            ("canvas", "https://fhict.instructure.com")
        );
        assert_eq!(
            parse_scoped_endpoint("mcp:https://fhict.instructure.com"),
            ("mcp", "https://fhict.instructure.com")
        );
        assert_eq!(
            parse_scoped_endpoint("https://fhict.instructure.com"),
            ("ai", "https://fhict.instructure.com")
        );
    }

    /// Round trip through the real OS credential store (run explicitly with --ignored).
    #[test]
    #[ignore]
    fn os_store_round_trip() {
        let endpoint = "https://plums-selftest.invalid/v1/chat/completions";
        remove(endpoint).unwrap();
        assert!(!has(endpoint).unwrap());
        save(endpoint, "selftest-value-123").unwrap();
        assert!(has(endpoint).unwrap());
        assert_eq!(
            resolve(endpoint).unwrap().as_deref(),
            Some("selftest-value-123")
        );
        assert!(!has("https://plums-selftest.invalid/other/chat/completions").unwrap());
        remove(endpoint).unwrap();
        assert!(!has(endpoint).unwrap());
    }
}
