//! Where the platform has an [`Owner`] (macOS), Spade creates every new entry through it, with its
//! own access list; an entry already there keeps its access list and only has its secret updated
//! in place, and nothing is ever deleted to be filed again (ADR 0119 amendment 1). The owner here
//! is a fake over `keyring-core`'s mock; the real one is checked by hand (`keys.rs`, ignored).

mod support;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use spade_keys::{Created, KeyStore, Owner, SERVICE};
use support::Counting;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Adds to the mock only when the entry is new, as the macOS owner does, and remembers which
/// entries it created.
struct FakeOwner {
    store: Arc<Counting>,
    owned: Mutex<HashSet<(String, String)>>,
    calls: Mutex<usize>,
    fail: bool,
}

impl FakeOwner {
    fn new(store: &Arc<Counting>, fail: bool) -> Arc<Self> {
        Arc::new(Self {
            store: store.clone(),
            owned: Mutex::default(),
            calls: Mutex::default(),
            fail,
        })
    }

    fn owned(&self, service: &str, account: &str) -> bool {
        self.owned
            .lock()
            .is_ok_and(|o| o.contains(&(service.to_owned(), account.to_owned())))
    }

    fn calls(&self) -> usize {
        self.calls.lock().map(|c| *c).unwrap_or_default()
    }
}

impl Owner for FakeOwner {
    fn create(
        &self,
        service: &str,
        account: &str,
        secret: &str,
    ) -> std::result::Result<Created, String> {
        if let Ok(mut calls) = self.calls.lock() {
            *calls += 1;
        }
        if self.fail {
            return Err("the keychain refused the access list".to_owned());
        }
        if self.store.stored(service, account).is_some() {
            return Ok(Created::Exists);
        }
        self.store
            .store_directly(service, account, secret)
            .map_err(|e| e.to_string())?;
        if let Ok(mut owned) = self.owned.lock() {
            owned.insert((service.to_owned(), account.to_owned()));
        }
        Ok(Created::Added)
    }
}

fn owned_keys(store: &Arc<Counting>, owner: &Arc<FakeOwner>) -> KeyStore {
    KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone())
}

#[test]
fn a_new_entry_is_created_with_spades_own_access_list() -> Result {
    let store = Counting::new()?;
    let owner = FakeOwner::new(&store, false);
    let keys = owned_keys(&store, &owner);
    keys.set("openai", "sk-1")?;
    keys.set_sign_in_key("chatgpt-1", "11aa")?;
    assert!(owner.owned(SERVICE, "endpoint:openai"));
    assert!(owner.owned(SERVICE, "oauth:chatgpt-1"));
    assert_eq!(keys.get("openai")?.as_deref(), Some("sk-1"));
    Ok(())
}

#[test]
fn an_entry_from_before_keeps_its_access_list_and_gets_the_new_secret_in_place() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-old-build")?;
    let owner = FakeOwner::new(&store, false);
    let keys = owned_keys(&store, &owner);
    keys.set("openai", "sk-new")?;
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-new")
    );
    assert!(!owner.owned(SERVICE, "endpoint:openai"));
    Ok(())
}

#[test]
fn reading_an_entry_from_before_never_rewrites_it() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-old-build")?;
    let owner = FakeOwner::new(&store, false);
    let keys = owned_keys(&store, &owner);
    assert_eq!(keys.get("openai")?.as_deref(), Some("sk-old-build"));
    // Deleted in Keychain Access after Spade read it: nothing brings it back.
    store.delete_directly(SERVICE, "endpoint:openai")?;
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(owner.calls(), 0);
    assert_eq!(store.stored(SERVICE, "endpoint:openai"), None);
    Ok(())
}

#[test]
fn an_owner_that_cannot_create_still_leaves_the_key_stored() -> Result {
    let store = Counting::new()?;
    let owner = FakeOwner::new(&store, true);
    let keys = owned_keys(&store, &owner);
    keys.set("openai", "sk-1")?;
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-1")
    );
    assert!(!owner.owned(SERVICE, "endpoint:openai"));
    Ok(())
}

#[test]
fn entries_under_another_service_are_never_touched() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-live")?;
    let owner = FakeOwner::new(&store, false);
    let dev = KeyStore::with_store(store.clone(), "dev.acehq.spade.dev.0123456789abcdef")
        .owned_by(owner.clone());
    assert_eq!(dev.get("openai")?, None, "dev never reads live's key");
    dev.set("openai", "sk-dev")?;
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-live")
    );
    assert!(!owner.owned(SERVICE, "endpoint:openai"));
    Ok(())
}
