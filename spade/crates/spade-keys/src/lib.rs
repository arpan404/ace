//! Spade's endpoint API keys and connector tokens (ADR 0131), kept in the operating system's
//! credential store (ADR 0119): the Keychain on macOS, Credential Manager on Windows, the Secret
//! Service on Linux. Keys are never written anywhere else, and no error or debug output ever
//! contains one.
//!
//! The store is a value passed in, never a global, so tests use `keyring-core`'s in-memory mock
//! and never touch a real keychain.

mod lookup;
mod presence;

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    /// Whether each endpoint has a key, as last read, shared by every clone.
    presence: Arc<presence::Presence>,
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
            presence: Arc::default(),
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

    /// A connector's secret of `kind` (`access`, `refresh`, `client_secret`), if stored
    /// (ADR 0131). Account `connector:<id>:<kind>`.
    pub fn connector_secret(&self, id: &str, kind: &str) -> Result<Option<String>, KeyError> {
        self.read(&self.connector_entry(id, kind)?)
    }

    /// Stores a connector's secret of `kind`, replacing any earlier one.
    pub fn set_connector_secret(&self, id: &str, kind: &str, secret: &str) -> Result<(), KeyError> {
        let secret = checked(secret)?;
        self.connector_entry(id, kind)?
            .set_password(secret)
            .map_err(|error| classify(&error))
    }

    /// Forgets a connector's secret of `kind`. Returns whether there was one.
    pub fn delete_connector_secret(&self, id: &str, kind: &str) -> Result<bool, KeyError> {
        Self::remove(&self.connector_entry(id, kind)?)
    }

    /// A web search backend's key (Brave Search), if stored. Account `search:<id>`, apart from
    /// model endpoints' keys so neither can stand in for the other.
    pub fn search_key(&self, backend: &str) -> Result<Option<String>, KeyError> {
        self.read(&self.search_entry(backend)?)
    }

    /// Stores a web search backend's key, replacing any earlier one.
    pub fn set_search_key(&self, backend: &str, key: &str) -> Result<(), KeyError> {
        let key = checked(key)?;
        self.search_entry(backend)?
            .set_password(key)
            .map_err(|error| classify(&error))
    }

    /// Forgets a web search backend's key. Returns whether there was one.
    pub fn delete_search_key(&self, backend: &str) -> Result<bool, KeyError> {
        Self::remove(&self.search_entry(backend)?)
    }

    fn search_entry(&self, backend: &str) -> Result<Entry, KeyError> {
        if backend.trim().is_empty() {
            return Err(KeyError::Invalid("the search backend id is empty"));
        }
        self.account(&format!("search:{backend}"))
    }

    fn connector_entry(&self, id: &str, kind: &str) -> Result<Entry, KeyError> {
        if id.trim().is_empty() || kind.trim().is_empty() {
            return Err(KeyError::Invalid("the connector id is empty"));
        }
        self.account(&format!("connector:{id}:{kind}"))
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

    /// Whether each of `endpoints` has a key, without waiting on the keychain longer than
    /// `wait`: `None` for one whose first read hasn't answered yet (a prompt still open). Every
    /// call also reads each key again in the background, at most one read per endpoint at a
    /// time, so a key changed outside Spade shows on a later call. A read that fails reads as no
    /// key.
    pub fn has_within(&self, endpoints: &[&str], wait: Duration) -> Vec<Option<bool>> {
        let deadline = Instant::now() + wait;
        for endpoint in endpoints {
            if !self.presence.claim(endpoint) {
                continue;
            }
            let keys = self.clone();
            let owned = (*endpoint).to_owned();
            let spawned = std::thread::Builder::new()
                .name("spade-key-check".to_owned())
                .spawn(move || {
                    let present = keys.get(&owned).is_ok_and(|key| key.is_some());
                    keys.presence.done(&owned, present);
                });
            // No thread for it: no read is out, so a later call tries again.
            if spawned.is_err() {
                self.presence.release(endpoint);
            }
        }
        self.presence.known_by(endpoints, deadline)
    }

    /// Stores `key` for `endpoint`, replacing any earlier one. Surrounding whitespace is removed.
    pub fn set(&self, endpoint: &str, key: &str) -> Result<(), KeyError> {
        let key = checked(key)?;
        self.entry(endpoint)?
            .set_password(key)
            .map_err(|error| classify(&error))?;
        self.presence.note(endpoint, true);
        Ok(())
    }

    /// Deletes the key for `endpoint`. Returns whether there was one.
    pub fn delete(&self, endpoint: &str) -> Result<bool, KeyError> {
        let removed = Self::remove(&self.entry(endpoint)?)?;
        self.presence.note(endpoint, false);
        Ok(removed)
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
