//! Spade's endpoint API keys, kept in the operating system's credential store (ADR 0119): the
//! Keychain on macOS, Credential Manager on Windows, the Secret Service on Linux. Keys are never
//! written anywhere else, and no error or debug output ever contains one.
//!
//! The store is a value passed in, never a global, so tests use `keyring-core`'s in-memory mock
//! and never touch a real keychain.

mod lookup;

use std::fmt;
use std::sync::Arc;

use keyring_core::{CredentialStore, Entry, Error};

pub use lookup::{KeyRequest, Keys};

/// The keychain service every Spade key is filed under.
pub const SERVICE: &str = "dev.acehq.spade";

/// The keychain account Spade's ace grant is filed under (docs/ace-integration.md).
pub const ACE_GRANT: &str = "ace:grant";

/// The longest key accepted.
const LONGEST: usize = 8192;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    /// No credential store on this machine (for example Linux without a Secret Service).
    #[error(
        "this machine has no keychain Spade can use ({0}); set the endpoint's environment variable instead"
    )]
    Unavailable(String),
    #[error("the keychain refused the request: {0}")]
    Failed(String),
    #[error("{0}")]
    Invalid(&'static str),
}

/// Endpoint keys in a credential store.
#[derive(Clone)]
pub struct KeyStore {
    store: Arc<CredentialStore>,
    service: String,
}

impl fmt::Debug for KeyStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl KeyStore {
    /// This operating system's credential store.
    pub fn os() -> Result<Self, KeyError> {
        Ok(Self::with_store(platform_store()?, SERVICE))
    }

    /// Keys in `store`, filed under `service`. Tests pass `keyring_core::mock::Store`.
    pub fn with_store(store: Arc<CredentialStore>, service: &str) -> Self {
        Self {
            store,
            service: service.to_owned(),
        }
    }

    /// The key for `endpoint`, if one is stored.
    pub fn get(&self, endpoint: &str) -> Result<Option<String>, KeyError> {
        self.read(&self.entry(endpoint)?)
    }

    /// The ace grant the daemon of ace home `slot` handed Spade, if one is stored. Each ace home
    /// (a person's real one, a development one) has its own slot, so they never overwrite each
    /// other's grant.
    pub fn ace_grant(&self, slot: &str) -> Result<Option<String>, KeyError> {
        self.read(&self.account(&format!("{ACE_GRANT}:{slot}"))?)
    }

    /// Stores the ace grant for `slot`, replacing any earlier one.
    pub fn set_ace_grant(&self, slot: &str, grant: &str) -> Result<(), KeyError> {
        let grant = checked(grant)?;
        self.account(&format!("{ACE_GRANT}:{slot}"))?
            .set_password(grant)
            .map_err(|error| classify(&error))
    }

    /// Forgets the ace grant for `slot`. Returns whether there was one.
    pub fn delete_ace_grant(&self, slot: &str) -> Result<bool, KeyError> {
        Self::remove(&self.account(&format!("{ACE_GRANT}:{slot}"))?)
    }

    fn read(&self, entry: &Entry) -> Result<Option<String>, KeyError> {
        match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(Error::NoEntry) => Ok(None),
            Err(error) => Err(classify(&error)),
        }
    }

    /// Whether a key is stored for `endpoint`, without returning it.
    pub fn has(&self, endpoint: &str) -> Result<bool, KeyError> {
        self.get(endpoint).map(|key| key.is_some())
    }

    /// Stores `key` for `endpoint`, replacing any earlier one. Surrounding whitespace is removed.
    pub fn set(&self, endpoint: &str, key: &str) -> Result<(), KeyError> {
        let key = checked(key)?;
        self.entry(endpoint)?
            .set_password(key)
            .map_err(|error| classify(&error))
    }

    /// Deletes the key for `endpoint`. Returns whether there was one.
    pub fn delete(&self, endpoint: &str) -> Result<bool, KeyError> {
        Self::remove(&self.entry(endpoint)?)
    }

    fn remove(entry: &Entry) -> Result<bool, KeyError> {
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(Error::NoEntry) => Ok(false),
            Err(error) => Err(classify(&error)),
        }
    }

    fn entry(&self, endpoint: &str) -> Result<Entry, KeyError> {
        if endpoint.trim().is_empty() {
            return Err(KeyError::Invalid("the endpoint id is empty"));
        }
        self.account(&format!("endpoint:{endpoint}"))
    }

    fn account(&self, account: &str) -> Result<Entry, KeyError> {
        self.store
            .build(&self.service, account, None)
            .map_err(|error| classify(&error))
    }
}

/// A secret as stored: trimmed, not empty, one line, not huge.
fn checked(secret: &str) -> Result<&str, KeyError> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Err(KeyError::Invalid("the key is empty"));
    }
    if secret.len() > LONGEST || secret.chars().any(char::is_control) {
        return Err(KeyError::Invalid(
            "the key is too long or contains line breaks or control characters",
        ));
    }
    Ok(secret)
}

/// Turns a store error into one that names the problem but never carries secret data.
fn classify(error: &Error) -> KeyError {
    match error {
        Error::NoStorageAccess(_) | Error::NoDefaultStore => {
            KeyError::Unavailable(describe(error.to_string()))
        }
        _ => KeyError::Failed(describe(error.to_string())),
    }
}

/// Store errors describe the platform failure, not the secret; keep them to one short line.
fn describe(text: String) -> String {
    text.lines()
        .next()
        .unwrap_or("")
        .chars()
        .take(200)
        .collect()
}

#[cfg(target_os = "macos")]
fn platform_store() -> Result<Arc<CredentialStore>, KeyError> {
    let store = apple_native_keyring_store::keychain::Store::new()
        .map_err(|error| KeyError::Unavailable(describe(error.to_string())))?;
    Ok(store)
}

#[cfg(target_os = "windows")]
fn platform_store() -> Result<Arc<CredentialStore>, KeyError> {
    let store = windows_native_keyring_store::Store::new()
        .map_err(|error| KeyError::Unavailable(describe(error.to_string())))?;
    Ok(store)
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_store() -> Result<Arc<CredentialStore>, KeyError> {
    let store = zbus_secret_service_keyring_store::Store::new()
        .map_err(|error| KeyError::Unavailable(describe(error.to_string())))?;
    Ok(store)
}

#[cfg(not(any(unix, windows)))]
fn platform_store() -> Result<Arc<CredentialStore>, KeyError> {
    Err(KeyError::Unavailable("unsupported platform".to_owned()))
}
