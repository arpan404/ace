//! Spade's endpoint API keys and connector tokens (ADR 0131), kept in the operating system's
//! credential store (ADR 0119): the Keychain on macOS, Credential Manager on Windows, the Secret
//! Service on Linux. Keys are never written anywhere else, and no error or debug output ever
//! contains one.
//!
//! Each secret is read from the store once per process and then kept in memory until Spade itself
//! replaces or deletes it (ADR 0119 amendment 1). On macOS every entry Spade creates carries an
//! access list trusting Spade by its code signature, so a signed update reads it without a prompt
//! (see [`owner`]).
//!
//! The store is a value passed in, never a global, so tests use `keyring-core`'s in-memory mock
//! and never touch a real keychain.

mod cache;
mod lookup;
pub mod owner;
mod presence;

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use keyring_core::{CredentialStore, Entry, Error};

pub use lookup::{KeyRequest, Keys};
pub use owner::{Created, DEV_SERVICE, NotForLiveHome, OWNED_MARK, Owner, Placement, SERVICE};

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
    /// Secrets already read in this process, shared by every clone.
    cache: Arc<cache::Cache>,
    /// Writes entries with Spade's own access list, where the platform has one.
    owner: Option<Arc<dyn Owner>>,
    /// One lock per entry, held across each write of it, so filing an old entry again never
    /// overwrites a newer secret. Per entry: a write stuck on a prompt holds up only its own.
    writing: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl fmt::Debug for KeyStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("KeyStore")
            .field("service", &self.service)
            .finish_non_exhaustive()
    }
}

impl KeyStore {
    /// This operating system's credential store, filed under `service` (see
    /// [`Placement::service`]). On macOS, Spade owns the entries it writes.
    pub fn os(service: &str) -> Result<Self, KeyError> {
        let store = Self::with_store(platform_store()?, service);
        #[cfg(target_os = "macos")]
        let store = store.owned_by(Arc::new(owner::MacOwner));
        Ok(store)
    }

    /// Keys in `store`, filed under `service`. Tests pass `keyring_core::mock::Store`.
    pub fn with_store(store: Arc<CredentialStore>, service: &str) -> Self {
        Self {
            store,
            service: service.to_owned(),
            presence: Arc::default(),
            cache: Arc::default(),
            owner: None,
            writing: Arc::default(),
        }
    }

    /// The same store, with `owner` creating every new entry.
    pub fn owned_by(mut self, owner: Arc<dyn Owner>) -> Self {
        self.owner = Some(owner);
        self
    }

    /// The service these keys are filed under.
    pub fn service(&self) -> &str {
        &self.service
    }

    /// The key for `endpoint`, if one is stored.
    pub fn get(&self, endpoint: &str) -> Result<Option<String>, KeyError> {
        self.read(&endpoint_account(endpoint)?)
    }

    /// The ace grant the daemon of ace home `slot` handed Spade, if one is stored. Each ace home
    /// (a person's real one, a development one) has its own slot, so they never overwrite each
    /// other's grant.
    pub fn ace_grant(&self, slot: &str) -> Result<Option<String>, KeyError> {
        self.read(&format!("{ACE_GRANT}:{slot}"))
    }

    /// Stores the ace grant for `slot`, replacing any earlier one.
    pub fn set_ace_grant(&self, slot: &str, grant: &str) -> Result<(), KeyError> {
        self.write(&format!("{ACE_GRANT}:{slot}"), checked(grant)?)
    }

    /// Forgets the ace grant for `slot`. Returns whether there was one.
    pub fn delete_ace_grant(&self, slot: &str) -> Result<bool, KeyError> {
        self.remove(&format!("{ACE_GRANT}:{slot}"))
    }

    /// A connector's secret of `kind` (`access`, `refresh`, `client_secret`), if stored
    /// (ADR 0131). Account `connector:<id>:<kind>`.
    pub fn connector_secret(&self, id: &str, kind: &str) -> Result<Option<String>, KeyError> {
        self.read(&connector_account(id, kind)?)
    }

    /// Stores a connector's secret of `kind`, replacing any earlier one.
    pub fn set_connector_secret(&self, id: &str, kind: &str, secret: &str) -> Result<(), KeyError> {
        self.write(&connector_account(id, kind)?, checked(secret)?)
    }

    /// Forgets a connector's secret of `kind`. Returns whether there was one.
    pub fn delete_connector_secret(&self, id: &str, kind: &str) -> Result<bool, KeyError> {
        self.remove(&connector_account(id, kind)?)
    }

    /// The key that seals a signed-in account's tokens (ADR 0214), if stored: hex, one per
    /// account, under `oauth:<account id>`. The tokens themselves are sealed with it in Spade's
    /// data folder, so this entry stays small and its name a fixed length on every platform.
    pub fn sign_in_key(&self, account: &str) -> Result<Option<String>, KeyError> {
        self.read(&sign_in_account(account)?)
    }

    /// Stores the key that seals `account`'s tokens, replacing any earlier one.
    pub fn set_sign_in_key(&self, account: &str, key: &str) -> Result<(), KeyError> {
        self.write(&sign_in_account(account)?, checked(key)?)
    }

    /// Forgets the key that seals `account`'s tokens. Returns whether there was one.
    pub fn delete_sign_in_key(&self, account: &str) -> Result<bool, KeyError> {
        self.remove(&sign_in_account(account)?)
    }

    /// An org host's audit key (ADR 0206 §4.2), the hex Ed25519 seed that signs its log's
    /// checkpoints, if one was made for organization `org`. Account `org-audit:<org>`.
    pub fn audit_key(&self, org: &str) -> Result<Option<String>, KeyError> {
        self.read(&audit_account(org)?)
    }

    /// Stores the audit key for `org`, replacing any earlier one.
    pub fn set_audit_key(&self, org: &str, seed: &str) -> Result<(), KeyError> {
        self.write(&audit_account(org)?, checked(seed)?)
    }

    /// `account`'s secret: from memory once this process has read or written it, otherwise from
    /// the store. If Spade changed the entry while the store was answering, that answer may be
    /// from before the change, so it is neither kept nor returned: the entry is looked up again.
    fn read(&self, account: &str) -> Result<Option<String>, KeyError> {
        let mut found = None;
        // Each pass loses only to a change Spade made meanwhile; a few always settle it.
        for _ in 0..4 {
            let ticket = match self.cache.lookup(account) {
                Ok(secret) => return Ok(Some(secret)),
                Err(ticket) => ticket,
            };
            found = match self.entry_for(account)?.get_password() {
                Ok(secret) => Some(secret),
                Err(Error::NoEntry) => None,
                Err(error) => return Err(classify(&error)),
            };
            let current = match &found {
                Some(secret) => self.cache.fill(account, ticket, secret),
                None => self.cache.unchanged(account, ticket),
            };
            if current {
                return Ok(found);
            }
        }
        Ok(found)
    }

    /// Stores `secret` under `account`. With an owner, a new entry is created with Spade's
    /// access list; an existing one keeps its own and has its secret updated in place. Nothing is
    /// deleted first, so a failed write never loses the secret already stored.
    fn write(&self, account: &str, secret: &str) -> Result<(), KeyError> {
        let lock = self.write_lock(account);
        let _writing = lock.lock().unwrap_or_else(|p| p.into_inner());
        let created = self
            .owner
            .as_ref()
            .map(|owner| owner.create(&self.service, account, secret));
        let written = match created {
            Some(Ok(owner::Created::Added)) => Ok(()),
            Some(Ok(owner::Created::Exists)) | None => self.plain_write(account, secret),
            Some(Err(error)) => {
                tracing::warn!(account, %error, "keychain entry written without Spade's access list");
                self.plain_write(account, secret)
            }
        };
        match &written {
            Ok(()) => self.cache.put(account, secret),
            // What the store now holds is unknown: read it again next time.
            Err(_) => self.cache.forget(account),
        }
        written
    }

    fn plain_write(&self, account: &str, secret: &str) -> Result<(), KeyError> {
        self.entry_for(account)?
            .set_password(secret)
            .map_err(|error| classify(&error))
    }

    /// Deletes `account`. Returns whether there was one.
    fn remove(&self, account: &str) -> Result<bool, KeyError> {
        let lock = self.write_lock(account);
        let _writing = lock.lock().unwrap_or_else(|p| p.into_inner());
        let removed = match self.entry_for(account)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(Error::NoEntry) => Ok(false),
            Err(error) => Err(classify(&error)),
        };
        if removed.is_ok() {
            self.cache.forget(account);
        }
        removed
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
        self.write(&endpoint_account(endpoint)?, checked(key)?)?;
        self.presence.note(endpoint, true);
        Ok(())
    }

    /// Deletes the key for `endpoint`. Returns whether there was one.
    pub fn delete(&self, endpoint: &str) -> Result<bool, KeyError> {
        let removed = self.remove(&endpoint_account(endpoint)?)?;
        self.presence.note(endpoint, false);
        Ok(removed)
    }

    /// The token an authenticated gateway asks for with an endpoint's calls (Cloudflare AI
    /// Gateway's `cf-aig-authorization`), if stored: account `gateway:<endpoint>`. A second
    /// secret beside the key, never a header stored with the endpoint (ADR 0119).
    pub fn gateway_token(&self, endpoint: &str) -> Result<Option<String>, KeyError> {
        self.read(&gateway_account(endpoint)?)
    }

    /// Stores the gateway token for `endpoint`, replacing any earlier one.
    pub fn set_gateway_token(&self, endpoint: &str, token: &str) -> Result<(), KeyError> {
        self.write(&gateway_account(endpoint)?, checked(token)?)
    }

    /// Forgets the gateway token for `endpoint`. Returns whether there was one.
    pub fn delete_gateway_token(&self, endpoint: &str) -> Result<bool, KeyError> {
        self.remove(&gateway_account(endpoint)?)
    }

    fn write_lock(&self, account: &str) -> Arc<Mutex<()>> {
        let mut locks = self.writing.lock().unwrap_or_else(|p| p.into_inner());
        locks.entry(account.to_owned()).or_default().clone()
    }

    fn entry_for(&self, account: &str) -> Result<Entry, KeyError> {
        self.store
            .build(&self.service, account, None)
            .map_err(|error| classify(&error))
    }
}

fn endpoint_account(endpoint: &str) -> Result<String, KeyError> {
    if endpoint.trim().is_empty() {
        return Err(KeyError::Invalid("the endpoint id is empty"));
    }
    Ok(format!("endpoint:{endpoint}"))
}

fn gateway_account(endpoint: &str) -> Result<String, KeyError> {
    if endpoint.trim().is_empty() {
        return Err(KeyError::Invalid("the endpoint id is empty"));
    }
    Ok(format!("gateway:{endpoint}"))
}

fn connector_account(id: &str, kind: &str) -> Result<String, KeyError> {
    if id.trim().is_empty() || kind.trim().is_empty() {
        return Err(KeyError::Invalid("the connector id is empty"));
    }
    Ok(format!("connector:{id}:{kind}"))
}

fn sign_in_account(account: &str) -> Result<String, KeyError> {
    if account.trim().is_empty() {
        return Err(KeyError::Invalid("the account id is empty"));
    }
    Ok(format!("oauth:{account}"))
}

fn audit_account(org: &str) -> Result<String, KeyError> {
    if org.trim().is_empty() {
        return Err(KeyError::Invalid("the organization id is empty"));
    }
    Ok(format!("org-audit:{org}"))
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
