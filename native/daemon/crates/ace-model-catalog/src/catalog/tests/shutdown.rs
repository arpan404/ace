// SPDX-License-Identifier: Apache-2.0
//! Shutdown and deletion: what close drains, the deletion a replacement row inherits, and
//! the storage that refuses work once it is closed.

use super::*;

struct ClosingStorage {
    inner: MemoryStorage,
    closed: AtomicBool,
    late: Arc<AtomicUsize>,
}

impl ClosingStorage {
    fn check(&self) -> Result<(), crate::cache::CacheError> {
        if self.closed.load(Ordering::SeqCst) {
            self.late.fetch_add(1, Ordering::SeqCst);
            return Err(crate::cache::CacheError::Malformed);
        }
        Ok(())
    }
}

fn closing_storage() -> (SharedStorage, Arc<AtomicUsize>) {
    let late = Arc::new(AtomicUsize::new(0));
    (
        SharedStorage::new(ClosingStorage {
            inner: MemoryStorage::new(),
            closed: AtomicBool::new(false),
            late: late.clone(),
        }),
        late,
    )
}

struct FailingRemove {
    inner: MemoryStorage,
    failures: AtomicUsize,
}

impl crate::cache::CatalogStorage for ClosingStorage {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.check()?;
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        self.check()?;
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        self.check()?;
        self.inner.remove(instance)
    }

    fn close(&mut self) -> Result<(), crate::cache::CacheError> {
        self.check()?;
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl crate::cache::CatalogStorage for FailingRemove {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        if self.failures.load(Ordering::SeqCst) > 0 {
            self.failures.fetch_sub(1, Ordering::SeqCst);
            return Err(crate::cache::CacheError::Malformed);
        }
        self.inner.remove(instance)
    }
}

#[test]
fn close_waits_for_a_removal_that_started_before_it() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(models(&request.instance, &["gpt-6-sol"]))
        })
    });
    let (storage, late) = closing_storage();
    let fixture = fixture(vec![codex], storage, discover);
    let catalog = fixture.catalog.clone();
    fixture.spawn.spawn(Box::pin({
        let catalog = catalog.clone();
        async move {
            let _ = catalog
                .refresh_state("account", RefreshCause::Background)
                .await;
        }
    }));
    fixture.spawn.drain();
    let mut removing = Box::pin(catalog.remove_instance("account"));
    assert!(
        poll_once(removing.as_mut()).is_pending(),
        "the removal waits for the flight"
    );
    let mut close = Box::pin(catalog.close());
    assert!(
        poll_once(close.as_mut()).is_pending(),
        "close waits for the removal"
    );
    gate.open();
    let (_, closed) = settle(
        async move { futures::join!(removing, close) },
        &fixture.spawn,
        "a removal and close",
    );
    closed.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        late.load(Ordering::SeqCst),
        0,
        "every removal finished before storage closed"
    );
}

#[test]
fn a_second_close_waits_for_the_first_ones_drain() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(models(&request.instance, &["gpt-6-sol"]))
        })
    });
    let (storage, late) = closing_storage();
    let fixture = fixture(vec![codex], storage, discover);
    let catalog = fixture.catalog.clone();
    let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(flight.as_mut()).is_pending(), "the flight runs");
    let mut first = Box::pin(catalog.close());
    assert!(
        poll_once(first.as_mut()).is_pending(),
        "close drains the flight"
    );
    let mut second = Box::pin(catalog.close());
    assert!(
        poll_once(second.as_mut()).is_pending(),
        "a second close waits for the first drain"
    );
    gate.open();
    let (_, a, b) =
        futures::executor::block_on(async move { futures::join!(flight, first, second) });
    a.unwrap_or_else(|error| panic!("{error}"));
    b.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        late.load(Ordering::SeqCst),
        0,
        "storage closes once, after the drain"
    );
}

#[test]
fn shutdown_aborts_flights_and_closes_after_they_settle() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = FakeDiscover::new(|_request, signal| {
        Box::pin(async move {
            signal.wait().await;
            Err(DiscoveryFailure::with_code(FailureCode::DiscoveryFailed))
        })
    });
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    fixture.spawn.spawn(Box::pin(async move {
        let _ = catalog
            .refresh_state("account", RefreshCause::Background)
            .await;
    }));
    // Start the work before closing: its flight is registered and running.
    assert_eq!(fixture.spawn.drain(), 1, "the flight started");
    assert_eq!(fixture.discover.calls(), 1, "its discovery is running");
    let mut close = Box::pin(fixture.catalog.close());
    assert!(
        poll_once(close.as_mut()).is_pending(),
        "close waits for the flight it aborted"
    );
    let closed = loop {
        match poll_once(close.as_mut()) {
            std::task::Poll::Ready(result) => break result,
            std::task::Poll::Pending => {
                fixture.spawn.drain();
            }
        }
    };
    closed.unwrap_or_else(|error| panic!("{error}"));
    assert!(fixture.catalog.has_instance("account"));
    assert_eq!(
        futures::executor::block_on(fixture.catalog.refresh(ModelFilter::default())).err(),
        Some(CatalogError::Closed)
    );
}

#[test]
fn a_failed_revocation_is_reported_and_the_replacement_row_survives_shutdown() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = SharedStorage::new(FailingRemove {
        inner: MemoryStorage::new(),
        failures: AtomicUsize::new(1),
    });
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex.clone()], storage.clone(), discover);
    let catalog = fixture.catalog.clone();
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    // The first deletion fails, so the revocation cannot claim success.
    let revoked = futures::executor::block_on(catalog.invalidate(ModelFilter::default()));
    assert!(
        revoked.is_err(),
        "a failed deletion is reported, never claimed as revoked"
    );
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..codex
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the replacement login's refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    futures::executor::block_on(catalog.close()).unwrap_or_else(|error| panic!("{error}"));
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored.iter().any(
            |entry| entry.instance == "account" && entry.login_revision.as_deref() == Some("2")
        ),
        "the old login's deletion never removes the row that replaced it"
    );
}
