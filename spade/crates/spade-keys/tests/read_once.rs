//! Each secret is read from the keychain once per process, then kept in memory until Spade
//! changes it (ADR 0119 amendment 1). The keychain is `keyring-core`'s mock.

mod support;

use std::sync::{Arc, mpsc};
use std::time::Duration;

use spade_keys::{KeyStore, Keys, SERVICE};
use support::Counting;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

fn keys(store: &Arc<Counting>) -> KeyStore {
    KeyStore::with_store(store.clone(), SERVICE)
}

#[test]
fn many_calls_on_one_endpoint_read_the_keychain_once() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-1")?;
    let keychain = keys(&store);
    // As the server wires it: every model call looks its key up through `Keys`.
    let lookup = keychain.clone();
    let calls = Keys::keychain_then_env(move |e| lookup.get(e).ok().flatten(), |_| None);
    for _ in 0..25 {
        let key = calls.get(spade_keys::KeyRequest {
            endpoint: "openai",
            env: None,
        });
        assert_eq!(key.as_deref(), Some("sk-1"));
    }
    assert_eq!(store.reads(), 1);
    Ok(())
}

#[test]
fn replacing_a_key_is_what_the_next_call_gets() -> Result {
    let store = Counting::new()?;
    let keychain = keys(&store);
    keychain.set("openai", "sk-old")?;
    assert_eq!(keychain.get("openai")?.as_deref(), Some("sk-old"));
    keychain.set("openai", "sk-new")?;
    assert_eq!(keychain.get("openai")?.as_deref(), Some("sk-new"));
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-new")
    );
    assert!(keychain.delete("openai")?);
    assert_eq!(keychain.get("openai")?, None);
    Ok(())
}

#[test]
fn every_clone_shares_what_was_read_and_what_was_changed() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "oauth:chatgpt-1", "11aa")?;
    let first = keys(&store);
    let second = first.clone();
    assert_eq!(first.sign_in_key("chatgpt-1")?.as_deref(), Some("11aa"));
    assert_eq!(second.sign_in_key("chatgpt-1")?.as_deref(), Some("11aa"));
    assert_eq!(store.reads(), 1);
    second.set_sign_in_key("chatgpt-1", "22bb")?;
    assert_eq!(first.sign_in_key("chatgpt-1")?.as_deref(), Some("22bb"));
    Ok(())
}

#[test]
fn a_missing_key_is_not_remembered_so_one_added_elsewhere_is_found() -> Result {
    let store = Counting::new()?;
    let keychain = keys(&store);
    assert_eq!(keychain.get("zai")?, None);
    store.store_directly(SERVICE, "endpoint:zai", "sk-zai")?;
    assert_eq!(keychain.get("zai")?.as_deref(), Some("sk-zai"));
    Ok(())
}

#[test]
fn a_read_answered_after_spade_replaced_the_key_never_brings_the_old_one_back() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "ace:grant:home", "grant-old")?;
    let keychain = keys(&store);
    let (reading, read_started) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();
    let released = Arc::new(std::sync::Mutex::new(released));
    store.during_reads(Some(Arc::new(move || {
        let _ = reading.send(());
        let _ = released
            .lock()
            .map(|r| r.recv_timeout(Duration::from_secs(5)));
    })));
    let slow = keychain.clone();
    let reader = std::thread::spawn(move || slow.ace_grant("home"));
    read_started.recv_timeout(Duration::from_secs(5))?;
    // The read holds the old grant; Spade stores a new one meanwhile.
    store.during_reads(None);
    keychain.set_ace_grant("home", "grant-new")?;
    release.send(())?;
    let _ = reader.join().map_err(|_| "reader panicked")??;
    assert_eq!(keychain.ace_grant("home")?.as_deref(), Some("grant-new"));
    Ok(())
}
