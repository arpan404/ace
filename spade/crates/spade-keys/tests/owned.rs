//! Where the platform has an [`Owner`] (macOS), Spade writes every entry through it and files an
//! entry it didn't write again, once, after reading it (ADR 0119 amendment 1). The owner here is a
//! fake over `keyring-core`'s mock; the real one is checked by hand (`keys.rs`, ignored test).

mod support;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use spade_keys::{KeyStore, Owner, SERVICE};
use support::Counting;

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Writes into the mock and remembers which entries it wrote, as the macOS owner marks them.
struct FakeOwner {
    store: Arc<Counting>,
    owned: Mutex<HashSet<(String, String)>>,
    writes: Mutex<Vec<String>>,
    fail_writes: bool,
    /// While set, checking whether an entry is owned waits for a message on it.
    hold_checks: Mutex<Option<std::sync::mpsc::Receiver<()>>>,
}

impl FakeOwner {
    fn new(store: &Arc<Counting>, fail_writes: bool) -> Arc<Self> {
        Arc::new(Self {
            store: store.clone(),
            owned: Mutex::default(),
            writes: Mutex::default(),
            fail_writes,
            hold_checks: Mutex::default(),
        })
    }

    fn owned(&self, service: &str, account: &str) -> bool {
        self.owned
            .lock()
            .is_ok_and(|o| o.contains(&(service.to_owned(), account.to_owned())))
    }

    fn writes(&self) -> Vec<String> {
        self.writes.lock().map(|w| w.clone()).unwrap_or_default()
    }
}

impl Owner for FakeOwner {
    fn write(&self, service: &str, account: &str, secret: &str) -> std::result::Result<(), String> {
        if let Ok(mut writes) = self.writes.lock() {
            writes.push(account.to_owned());
        }
        if self.fail_writes {
            return Err("the keychain refused the access list".to_owned());
        }
        self.store
            .store_directly(service, account, secret)
            .map_err(|e| e.to_string())?;
        if let Ok(mut owned) = self.owned.lock() {
            owned.insert((service.to_owned(), account.to_owned()));
        }
        Ok(())
    }

    fn owns(&self, service: &str, account: &str) -> std::result::Result<bool, String> {
        if let Ok(held) = self.hold_checks.lock()
            && let Some(release) = held.as_ref()
        {
            let _ = release.recv_timeout(Duration::from_secs(5));
        }
        Ok(self.owned(service, account))
    }
}

fn eventually(what: &str, check: impl Fn() -> bool) -> Result {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !check() {
        if Instant::now() > deadline {
            return Err(format!("never: {what}").into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

#[test]
fn spades_writes_are_filed_with_its_own_access_list() -> Result {
    let store = Counting::new()?;
    let owner = FakeOwner::new(&store, false);
    let keys = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
    keys.set("openai", "sk-1")?;
    keys.set_sign_in_key("chatgpt-1", "11aa")?;
    assert!(owner.owned(SERVICE, "endpoint:openai"));
    assert!(owner.owned(SERVICE, "oauth:chatgpt-1"));
    assert_eq!(keys.get("openai")?.as_deref(), Some("sk-1"));
    Ok(())
}

#[test]
fn an_entry_from_before_is_filed_again_once_after_its_first_read() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-old-build")?;
    let owner = FakeOwner::new(&store, false);
    let keys = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
    assert_eq!(keys.get("openai")?.as_deref(), Some("sk-old-build"));
    eventually("the entry is owned", || {
        owner.owned(SERVICE, "endpoint:openai")
    })?;
    for _ in 0..5 {
        keys.get("openai")?;
    }
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(owner.writes(), vec!["endpoint:openai".to_owned()]);
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-old-build")
    );
    Ok(())
}

#[test]
fn an_entry_spade_already_owns_is_left_alone() -> Result {
    let store = Counting::new()?;
    let owner = FakeOwner::new(&store, false);
    let writer = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
    writer.set("openai", "sk-1")?;
    // A later process reads it.
    let later = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
    assert_eq!(later.get("openai")?.as_deref(), Some("sk-1"));
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(owner.writes().len(), 1, "{:?}", owner.writes());
    Ok(())
}

#[test]
fn a_key_spade_replaced_while_an_old_one_was_being_filed_again_stays_replaced() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-old")?;
    let owner = FakeOwner::new(&store, false);
    let (release, held) = std::sync::mpsc::channel();
    *owner.hold_checks.lock().map_err(|_| "poisoned")? = Some(held);
    let keys = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
    keys.get("openai")?;
    // Filing the old key again is under way when Spade stores a new one.
    keys.set("openai", "sk-new")?;
    release.send(())?;
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        owner.writes(),
        vec!["endpoint:openai".to_owned()],
        "only Spade's own write"
    );
    assert_eq!(keys.get("openai")?.as_deref(), Some("sk-new"));
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-new")
    );
    Ok(())
}

#[test]
fn a_key_spade_deleted_while_it_was_being_filed_again_stays_deleted() -> Result {
    let store = Counting::new()?;
    store.store_directly(SERVICE, "endpoint:openai", "sk-old")?;
    let owner = FakeOwner::new(&store, false);
    let (release, held) = std::sync::mpsc::channel();
    *owner.hold_checks.lock().map_err(|_| "poisoned")? = Some(held);
    let keys = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
    keys.get("openai")?;
    assert!(keys.delete("openai")?);
    release.send(())?;
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(store.stored(SERVICE, "endpoint:openai"), None);
    assert_eq!(keys.get("openai")?, None);
    assert!(owner.writes().is_empty(), "{:?}", owner.writes());
    Ok(())
}

#[test]
fn an_owner_that_cannot_write_still_leaves_the_key_stored() -> Result {
    let store = Counting::new()?;
    let owner = FakeOwner::new(&store, true);
    let keys = KeyStore::with_store(store.clone(), SERVICE).owned_by(owner.clone());
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
    let dev = KeyStore::with_store(store.clone(), spade_keys::DEV_SERVICE).owned_by(owner.clone());
    assert_eq!(dev.get("openai")?, None, "dev never reads live's key");
    dev.set("openai", "sk-dev")?;
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(
        store.stored(SERVICE, "endpoint:openai").as_deref(),
        Some("sk-live")
    );
    assert!(!owner.owned(SERVICE, "endpoint:openai"));
    Ok(())
}
