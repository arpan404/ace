//! Keys go through `keyring-core`'s in-memory mock store; no test touches a real keychain.

use std::sync::Arc;

use keyring_core::{CredentialStore, Error, mock};
use spade_keys::{KeyError, KeyStore, SERVICE};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn mock_store() -> Result<(KeyStore, Arc<CredentialStore>)> {
    let store: Arc<CredentialStore> = mock::Store::new()?;
    Ok((KeyStore::with_store(store.clone(), SERVICE), store))
}

#[test]
fn a_stored_key_is_read_back_and_a_missing_one_is_none() -> Result {
    let (keys, _) = mock_store()?;
    assert_eq!(keys.get("anthropic")?, None);
    keys.set("anthropic", "  sk-ant-123  ")?;
    assert_eq!(keys.get("anthropic")?, Some("sk-ant-123".to_owned()));
    assert!(keys.has("anthropic")?);
    Ok(())
}

#[test]
fn each_endpoint_has_its_own_key() -> Result {
    let (keys, _) = mock_store()?;
    keys.set("openai", "sk-open")?;
    keys.set("opencode-go", "sk-go")?;
    assert_eq!(keys.get("openai")?, Some("sk-open".to_owned()));
    assert_eq!(keys.get("opencode-go")?, Some("sk-go".to_owned()));
    assert_eq!(keys.get("moonshot")?, None);
    Ok(())
}

#[test]
fn setting_again_replaces_and_deleting_removes() -> Result {
    let (keys, _) = mock_store()?;
    keys.set("openai", "old")?;
    keys.set("openai", "new")?;
    assert_eq!(keys.get("openai")?, Some("new".to_owned()));
    assert!(keys.delete("openai")?);
    assert_eq!(keys.get("openai")?, None);
    assert!(!keys.delete("openai")?);
    Ok(())
}

#[test]
fn keys_are_filed_under_spades_service_and_the_endpoint() -> Result {
    let (keys, store) = mock_store()?;
    keys.set("zai", "sk-zai")?;
    let entry = store.build(SERVICE, "endpoint:zai", None)?;
    assert_eq!(entry.get_password()?, "sk-zai");
    Ok(())
}

#[test]
fn the_ace_grant_is_filed_under_its_own_account_apart_from_endpoint_keys() -> Result {
    let (keys, store) = mock_store()?;
    assert_eq!(keys.ace_grant("home-a")?, None);
    keys.set_ace_grant("home-a", " grant-123 ")?;
    keys.set("ace:grant", "an endpoint that happens to share the name")?;
    assert_eq!(keys.ace_grant("home-a")?, Some("grant-123".to_owned()));
    let entry = store.build(SERVICE, "ace:grant:home-a", None)?;
    assert_eq!(entry.get_password()?, "grant-123");
    assert!(keys.delete_ace_grant("home-a")?);
    assert_eq!(keys.ace_grant("home-a")?, None);
    assert!(!keys.delete_ace_grant("home-a")?);
    assert_eq!(
        keys.get("ace:grant")?,
        Some("an endpoint that happens to share the name".to_owned())
    );
    Ok(())
}

#[test]
fn an_empty_key_or_one_with_line_breaks_is_refused() -> Result {
    let (keys, _) = mock_store()?;
    assert!(matches!(
        keys.set("openai", "   "),
        Err(KeyError::Invalid(_))
    ));
    assert!(matches!(
        keys.set("openai", "sk-1\nsk-2"),
        Err(KeyError::Invalid(_))
    ));
    assert_eq!(keys.get("openai")?, None);
    Ok(())
}

#[test]
fn a_keychain_failure_never_carries_the_key() -> Result {
    let (keys, store) = mock_store()?;
    keys.set("openai", "sk-secret-value")?;
    let entry = store.build(SERVICE, "endpoint:openai", None)?;
    let cred: &mock::Cred = entry
        .as_any()
        .downcast_ref()
        .ok_or("not a mock credential")?;
    cred.set_error(Error::Invalid("store".to_owned(), "locked".to_owned()));

    let failure = keys.get("openai");
    let shown = format!(
        "{failure:?} {}",
        failure
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_default()
    );
    assert!(matches!(failure, Err(KeyError::Failed(_))), "{shown}");
    assert!(!shown.contains("sk-secret-value"), "{shown}");
    assert!(!format!("{keys:?}").contains("sk-secret-value"));
    Ok(())
}

/// Writes to the real keychain of whoever runs it, so it only runs by hand:
/// `cargo test -p spade-keys --test keys -- --ignored`.
#[test]
#[ignore = "touches the real OS keychain"]
fn the_os_keychain_round_trips_a_key() -> Result {
    let keys = KeyStore::with_store(platform()?, "dev.acehq.spade.test");
    keys.set("round-trip", "test-only-key")?;
    let read = keys.get("round-trip")?;
    let deleted = keys.delete("round-trip")?;
    assert_eq!(read, Some("test-only-key".to_owned()));
    assert!(deleted);
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform() -> Result<Arc<CredentialStore>> {
    Ok(apple_native_keyring_store::keychain::Store::new()?)
}

#[cfg(not(target_os = "macos"))]
fn platform() -> Result<Arc<CredentialStore>> {
    Err("the manual keychain check is wired for macOS only".into())
}

#[test]
fn each_ace_home_keeps_its_own_grant() -> Result {
    let keys = KeyStore::with_store(mock::Store::new()?, SERVICE);
    keys.set_ace_grant("real", "grant-real")?;
    keys.set_ace_grant("dev", "grant-dev")?;
    assert_eq!(keys.ace_grant("real")?.as_deref(), Some("grant-real"));
    assert_eq!(keys.ace_grant("dev")?.as_deref(), Some("grant-dev"));
    assert!(keys.delete_ace_grant("dev")?);
    assert_eq!(keys.ace_grant("real")?.as_deref(), Some("grant-real"));
    Ok(())
}
