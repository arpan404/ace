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
    fn load(&self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.check()?;
        self.inner.load()
    }

    fn replace_if_current(
        &self,
        entry: &CacheEntry,
        is_current: &dyn Fn() -> bool,
    ) -> Result<bool, crate::cache::CacheError> {
        self.check()?;
        self.inner.replace_if_current(entry, is_current)
    }

    fn remove(&self, instance: &str) -> Result<(), crate::cache::CacheError> {
        self.check()?;
        self.inner.remove(instance)
    }

    fn close(&self) -> Result<(), crate::cache::CacheError> {
        self.check()?;
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl crate::cache::CatalogStorage for FailingRemove {
    fn load(&self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace_if_current(
        &self,
        entry: &CacheEntry,
        is_current: &dyn Fn() -> bool,
    ) -> Result<bool, crate::cache::CacheError> {
        self.inner.replace_if_current(entry, is_current)
    }

    fn remove(&self, instance: &str) -> Result<(), crate::cache::CacheError> {
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
    let (_, a, b) = settle(
        async move { futures::join!(flight, first, second) },
        &fixture.spawn,
        "two closes",
    );
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
    fixture.spawn.drain();
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
        settle(
            fixture.catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the refresh after close",
        )
        .err(),
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
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    // The first deletion fails, so the revocation cannot claim success.
    let revoked = settle(
        catalog.invalidate(ModelFilter::default()),
        &fixture.spawn,
        "the invalidation",
    );
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
    settle(catalog.close(), &fixture.spawn, "the close").unwrap_or_else(|error| panic!("{error}"));
    let storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored.iter().any(
            |entry| entry.instance == "account" && entry.login_revision.as_deref() == Some("2")
        ),
        "the old login's deletion never removes the row that replaced it"
    );
}

/// A discovery that answers the first call and waits on `gate` for every later one.
fn gated_after_the_first(gate: crate::signals::Gate) -> (Arc<FakeDiscover>, Arc<AtomicUsize>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let gate = gate.clone();
        let call = seen.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call > 0 {
                gate.wait().await;
            }
            Ok(models(&request.instance, &["gpt-6-sol"]))
        })
    });
    (discover, calls)
}

#[test]
fn a_dropped_close_still_settles_a_later_one() {
    within(15, "a dropped close and a later one", || {
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
        let mut first = Box::pin(catalog.close());
        assert!(
            poll_once(first.as_mut()).is_pending(),
            "close drains the flight"
        );
        drop(first);
        let mut second = Box::pin(catalog.close());
        assert!(
            poll_once(second.as_mut()).is_pending(),
            "a later close waits for the drain the dropped one started"
        );
        gate.open();
        let closed = settle(second, &fixture.spawn, "a close after a dropped one");
        closed.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            late.load(Ordering::SeqCst),
            0,
            "storage closed once, after the drain"
        );
    })
}

#[test]
fn a_dropped_invalidation_still_deletes_the_revoked_row() {
    within(15, "a dropped invalidation", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let gate = crate::signals::Gate::new();
        let (discover, _) = gated_after_the_first(gate.clone());
        let fixture = fixture(vec![codex], storage.clone(), discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the login's refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        // A flight is running when the revocation is accepted; its caller then goes away.
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(flight.as_mut()).is_pending(), "the flight runs");
        let mut invalidating = Box::pin(catalog.invalidate(ModelFilter::default()));
        assert!(
            poll_once(invalidating.as_mut()).is_pending(),
            "the revocation waits for the flight"
        );
        drop(invalidating);
        gate.open();
        let _ = settle(flight, &fixture.spawn, "the flight the revocation drained");
        fixture.spawn.drain();
        let storage = storage.clone();
        assert!(
            storage.load().unwrap_or_default().is_empty(),
            "the revoked row's choices are deleted"
        );
        // Nothing the dropped revocation held is still closed to the row's work.
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "a refresh after the revocation",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(listed(&catalog).models.len(), 1, "the row discovers again");
    })
}

#[test]
fn a_dropped_removal_leaves_no_reservation() {
    within(15, "a dropped removal", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let gate = crate::signals::Gate::new();
        let (discover, _) = gated_after_the_first(gate.clone());
        let fixture = fixture(vec![codex], storage.clone(), discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the login's refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(flight.as_mut()).is_pending(), "the flight runs");
        let mut removing = Box::pin(catalog.remove_instance("account"));
        assert!(
            poll_once(removing.as_mut()).is_pending(),
            "the removal waits for the flight"
        );
        drop(removing);
        gate.open();
        let _ = settle(flight, &fixture.spawn, "the flight the removal waited for");
        fixture.spawn.drain();
        let storage = storage.clone();
        assert!(
            storage.load().unwrap_or_default().is_empty(),
            "the removed row's choices are deleted"
        );
        catalog
            .register_instance(instance(ProviderKind::Codex, "account"), None)
            .unwrap_or_else(|error| panic!("the id is free again: {error}"));
    })
}

#[test]
fn a_second_removal_shares_the_first_ones_deletion() {
    within(15, "a second removal of the same id", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let gate = crate::signals::Gate::new();
        let (discover, _) = gated_after_the_first(gate.clone());
        let fixture = fixture(vec![codex.clone()], storage.clone(), discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the login's refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(flight.as_mut()).is_pending(), "the flight runs");
        let mut first = Box::pin(catalog.remove_instance("account"));
        assert!(
            poll_once(first.as_mut()).is_pending(),
            "the first removal waits for the flight"
        );
        // A second removal of the same id shares the first one's deletion.
        let mut second = Box::pin(catalog.remove_instance("account"));
        assert!(
            poll_once(second.as_mut()).is_pending(),
            "the second removal waits for the first"
        );
        assert_eq!(
            catalog.register_instance(codex.clone(), None),
            Err(CatalogError::RemovalDraining),
            "the id stays reserved until the deletion finished"
        );
        gate.open();
        let (_, a, b) = settle(
            async move { futures::join!(flight, first, second) },
            &fixture.spawn,
            "two removals of the same id",
        );
        a.unwrap_or_else(|error| panic!("{error}"));
        b.unwrap_or_else(|error| panic!("{error}"));
        let storage = storage.clone();
        assert!(
            storage.load().unwrap_or_default().is_empty(),
            "the row's choices are deleted once"
        );
        catalog
            .register_instance(codex, None)
            .unwrap_or_else(|error| panic!("the id is free again: {error}"));
    })
}

#[test]
fn a_removal_at_its_capacity_is_refused_before_it_touches_the_row() {
    let fixture = fixture(
        Vec::new(),
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = fixture.catalog.clone();
    // Every removal waits on a write that still holds its row's queue.
    let ids: Vec<String> = (0..128).map(|index| format!("agent-{index}")).collect();
    let mut holds = Vec::new();
    let mut removals = Vec::new();
    for id in &ids {
        catalog
            .register_instance(instance(ProviderKind::Acp, id), None)
            .unwrap_or_else(|error| panic!("{error}"));
        holds.push(futures::executor::block_on(catalog.hold_turn(id)));
        let mut removal = Box::pin(catalog.remove_instance(id));
        assert!(
            poll_once(removal.as_mut()).is_pending(),
            "{id}'s removal waits for its write"
        );
        removals.push(removal);
    }
    catalog
        .register_instance(instance(ProviderKind::Acp, "over"), None)
        .unwrap_or_else(|error| panic!("{error}"));
    let mut refused = Box::pin(catalog.remove_instance("over"));
    let result = match poll_once(refused.as_mut()) {
        std::task::Poll::Ready(result) => result,
        std::task::Poll::Pending => panic!("the removal at capacity is refused at once"),
    };
    assert_eq!(result, Err(CatalogError::InstanceRemovalCapacity));
    assert!(
        catalog.has_instance("over"),
        "the refused removal left its row in place"
    );
}
