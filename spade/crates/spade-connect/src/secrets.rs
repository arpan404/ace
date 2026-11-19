//! A connector's secrets in the OS keychain (ADR 0131), read and written off the async workers:
//! a keychain call can wait on a system prompt.

use spade_keys::KeyStore;

pub(crate) const ACCESS: &str = "access";
pub(crate) const REFRESH: &str = "refresh";
pub(crate) const CLIENT_SECRET: &str = "client_secret";
const ALL: [&str; 3] = [ACCESS, REFRESH, CLIENT_SECRET];

pub(crate) async fn get(
    keys: &KeyStore,
    id: &str,
    kind: &'static str,
) -> Result<Option<String>, String> {
    let (keys, id) = (keys.clone(), id.to_owned());
    tokio::task::spawn_blocking(move || keys.connector_secret(&id, kind))
        .await
        .map_err(|_| "the keychain read stopped".to_owned())?
        .map_err(|e| e.to_string())
}

/// Stores `value`, or forgets the secret when it is `None`.
pub(crate) async fn put(
    keys: &KeyStore,
    id: &str,
    kind: &'static str,
    value: Option<String>,
) -> Result<(), String> {
    let (keys, id) = (keys.clone(), id.to_owned());
    tokio::task::spawn_blocking(move || match value {
        Some(value) => keys.set_connector_secret(&id, kind, &value),
        None => keys.delete_connector_secret(&id, kind).map(|_| ()),
    })
    .await
    .map_err(|_| "the keychain write stopped".to_owned())?
    .map_err(|e| e.to_string())
}

pub(crate) async fn forget_all(keys: &KeyStore, id: &str) -> Result<(), String> {
    for kind in ALL {
        put(keys, id, kind, None).await?;
    }
    Ok(())
}
