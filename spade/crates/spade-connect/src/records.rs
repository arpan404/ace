//! What Spade keeps about connectors in its database (the `settings` table), none of it secret:
//! each connector's address and sign-in facts, and which bots may use which connectors. Tokens
//! and client secrets are in the keychain ([`crate::secrets`]).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use spade_store::Store;

const RECORDS: &str = "connectors";
const ACCESS: &str = "connectors.access";

/// How a connector signs its requests.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Auth {
    /// The server needs no credential.
    None,
    /// A token or API key the person gave, sent as a bearer.
    Token,
    /// OAuth: tokens from the authorization server, refreshed as they expire.
    Oauth(OauthFacts),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OauthFacts {
    pub issuer: String,
    pub token_endpoint: String,
    pub resource: String,
    pub client_id: String,
    /// `none`, `client_secret_basic` or `client_secret_post`.
    pub client_auth: String,
    /// Set when Spade registered the client itself, with the redirect it registered.
    #[serde(default)]
    pub registered_redirect: Option<String>,
    /// The client is one of Spade's own registered apps (ADR 0137), not one the person gave.
    #[serde(default)]
    pub shipped: bool,
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Signed in through Spade Cloud (ADR 0140): renewals go through the cloud.
    #[serde(default)]
    pub cloud: bool,
    /// When the access token expires, in ms since the epoch, if the server said.
    #[serde(default)]
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub name: String,
    pub url: String,
    /// The catalogue entry it came from, if any.
    #[serde(default)]
    pub catalogue: Option<String>,
    pub auth: Auth,
    #[serde(default)]
    pub account: Option<String>,
    /// The person marked it as a server on their own machine or network when adding it, so its
    /// sign-in may use local addresses. Never inferred.
    #[serde(default)]
    pub local: bool,
    /// The sign-in expired or was revoked and could not be renewed.
    #[serde(default)]
    pub needs_reconnect: bool,
    pub added_ms: i64,
}

/// Which connectors a bot may use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "connectors", rename_all = "snake_case")]
pub enum Access {
    /// Every connected connector, now and later.
    All,
    /// These connectors only.
    Only(BTreeSet<String>),
}

impl Access {
    /// What a bot may use when the person never chose: Spade, the main bot, everything; a new
    /// bot nothing (ADR 0131).
    pub fn default_for(is_main: bool) -> Self {
        if is_main {
            Self::All
        } else {
            Self::Only(BTreeSet::new())
        }
    }

    pub fn allows(&self, connector: &str) -> bool {
        match self {
            Self::All => true,
            Self::Only(ids) => ids.contains(connector),
        }
    }
}

pub(crate) fn load(store: &Store) -> Result<Vec<Record>, String> {
    read(store, RECORDS).map(Option::unwrap_or_default)
}

pub(crate) fn save(store: &Store, records: &[Record]) -> Result<(), String> {
    write(store, RECORDS, &records)
}

pub(crate) fn load_access(store: &Store) -> Result<BTreeMap<String, Access>, String> {
    read(store, ACCESS).map(Option::unwrap_or_default)
}

pub(crate) fn save_access(store: &Store, access: &BTreeMap<String, Access>) -> Result<(), String> {
    write(store, ACCESS, access)
}

fn read<T: serde::de::DeserializeOwned>(store: &Store, key: &str) -> Result<Option<T>, String> {
    match store.setting(key).map_err(|e| e.to_string())? {
        None => Ok(None),
        // Written by this build or an earlier one; a value that no longer reads is a bug, said
        // as one rather than silently dropping the person's connectors.
        Some(text) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|e| format!("the stored {key} could not be read: {e}")),
    }
}

fn write<T: Serialize + ?Sized>(store: &Store, key: &str, value: &T) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
    store
        .set_setting(key, Some(&text))
        .map_err(|e| e.to_string())
}
