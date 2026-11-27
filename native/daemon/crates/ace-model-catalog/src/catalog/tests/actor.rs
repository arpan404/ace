// SPDX-License-Identifier: Apache-2.0
//! The actor's own guarantees: a dropped caller never cancels catalog work, a panic in
//! any callback or spawned task is settled, and close still finishes with no reservation
//! left behind.

use super::*;

use crate::cache::CatalogStorage;

fn acp_metadata(model: &str) -> Value {
    json!({
        "availableModels": [{ "modelId": model, "name": model }],
        "currentModelId": model,
        "configOptions": [{
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": model,
            "options": [{ "value": model, "name": model }]
        }]
    })
}

/// Storage that records the order of deletion and close, and refuses work after close.
struct OrderedStorage {
    inner: MemoryStorage,
    order: Arc<Mutex<Vec<&'static str>>>,
    closed: AtomicBool,
}

impl CatalogStorage for OrderedStorage {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        if self.closed.load(Ordering::SeqCst) {
            self.order.lock().unwrap().push("late-remove");
        }
        self.order.lock().unwrap().push("remove");
        self.inner.remove(instance)
    }

    fn close(&mut self) -> Result<(), crate::cache::CacheError> {
        self.order.lock().unwrap().push("close");
        self.closed.store(true, Ordering::SeqCst);
        Ok(())
    }
}

#[test]
fn a_dropped_close_never_closes_storage_before_the_removal_deletes() {
    within(15, "a dropped close and a blocked removal", || {
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
        let order = Arc::new(Mutex::new(Vec::new()));
        let storage = SharedStorage::new(OrderedStorage {
            inner: MemoryStorage::new(),
            order: order.clone(),
            closed: AtomicBool::new(false),
        });
        let fixture = fixture(vec![codex], storage, discover);
        let catalog = fixture.catalog.clone();
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(flight.as_mut()).is_pending());
        fixture.spawn.drain();
        let mut removing = Box::pin(catalog.remove_instance("account"));
        assert!(
            poll_once(removing.as_mut()).is_pending(),
            "the removal waits for the discovery"
        );
        let mut dropped = Box::pin(catalog.close());
        assert!(
            poll_once(dropped.as_mut()).is_pending(),
            "close waits for the removal"
        );
        drop(dropped);
        gate.open();
        let (_, removed) = settle(
            async move { futures::join!(flight, removing) },
            &fixture.spawn,
            "the removal and its flight",
        );
        removed.unwrap_or_else(|error| panic!("{error}"));
        settle(
            catalog.close(),
            &fixture.spawn,
            "the close after a dropped one",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let order = order.lock().unwrap().clone();
        assert_eq!(
            order.last().copied(),
            Some("close"),
            "storage closes last: {order:?}"
        );
        assert!(
            !order.contains(&"late-remove"),
            "the removal deleted before storage closed: {order:?}"
        );
        assert_eq!(order.iter().filter(|step| **step == "remove").count(), 1);
    })
}

#[test]
fn a_dropped_invalidation_waiting_on_its_predecessor_never_deletes_early() {
    within(15, "a dropped second invalidation", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let gate = crate::signals::Gate::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let discover = {
            let gate = gate.clone();
            let calls = calls.clone();
            FakeDiscover::new(move |request, _signal| {
                let gate = gate.clone();
                let call = calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if call > 0 {
                        gate.wait().await;
                    }
                    Ok(models(&request.instance, &["gpt-6-sol"]))
                })
            })
        };
        let fixture = fixture(vec![codex], storage.clone(), discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the login's refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(flight.as_mut()).is_pending());
        fixture.spawn.drain();
        let mut first = Box::pin(catalog.invalidate(ModelFilter::default()));
        assert!(
            poll_once(first.as_mut()).is_pending(),
            "the first revocation waits for its flight"
        );
        let mut second = Box::pin(catalog.invalidate(ModelFilter::default()));
        assert!(
            poll_once(second.as_mut()).is_pending(),
            "the second revocation waits for the first"
        );
        drop(second);
        let mut storage = storage.clone();
        assert!(
            !storage.load().unwrap_or_default().is_empty(),
            "no deletion ran while the predecessor still waited"
        );
        gate.open();
        let (_, revoked) = settle(
            async move { futures::join!(flight, first) },
            &fixture.spawn,
            "the first revocation",
        );
        revoked.unwrap_or_else(|error| panic!("{error}"));
        fixture.spawn.drain();
        assert!(
            storage.load().unwrap_or_default().is_empty(),
            "the dropped second revocation still deleted once its predecessor finished"
        );
    })
}

/// Storage whose next `remove` and `close` panic once each.
struct HostileStorage {
    inner: MemoryStorage,
    panic_remove: AtomicUsize,
    panic_close: AtomicUsize,
}

impl CatalogStorage for HostileStorage {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        if self.panic_remove.load(Ordering::SeqCst) > 0 {
            self.panic_remove.fetch_sub(1, Ordering::SeqCst);
            panic!("storage remove panicked");
        }
        self.inner.remove(instance)
    }

    fn close(&mut self) -> Result<(), crate::cache::CacheError> {
        if self.panic_close.load(Ordering::SeqCst) > 0 {
            self.panic_close.fetch_sub(1, Ordering::SeqCst);
            panic!("storage close panicked");
        }
        Ok(())
    }
}

#[test]
fn panicking_storage_listeners_and_a_spawned_removal_still_settle_close() {
    within(15, "panics in storage, listeners and a removal", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(HostileStorage {
            inner: MemoryStorage::new(),
            panic_remove: AtomicUsize::new(1),
            panic_close: AtomicUsize::new(1),
        });
        let rows = always(vec![row(&codex, "gpt-6-sol")]);
        let fixture = fixture(vec![codex], storage, rows);
        let catalog = fixture.catalog.clone();
        let _listener = catalog
            .listen(Arc::new(|_| panic!("listener panicked")))
            .unwrap_or_else(|error| panic!("{error}"));
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "a refresh with a panicking listener",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        let removed = settle(
            catalog.remove_instance("account"),
            &fixture.spawn,
            "the panicking removal",
        );
        assert!(
            removed.is_err(),
            "a panicking removal is reported, never claimed as done"
        );
        // Its reservation is gone, so the id registers at once.
        catalog
            .register_instance(instance(ProviderKind::Codex, "account"), None)
            .unwrap_or_else(|error| panic!("no reservation remains: {error}"));
        let first = settle(catalog.close(), &fixture.spawn, "the panicking close");
        assert!(first.is_err(), "the panic is a persistence failure");
        // The retry closes the storage that panicked once.
        settle(catalog.close(), &fixture.spawn, "the retried close")
            .unwrap_or_else(|error| panic!("{error}"));
    })
}

#[test]
fn dropping_a_queued_session_write_never_grows_pending_work_past_capacity() {
    within(15, "repeatedly dropped writes", || {
        let agent = instance(ProviderKind::Acp, "account");
        let fixture = fixture(
            vec![agent.clone()],
            SharedStorage::new(MemoryStorage::new()),
            always(Vec::new()),
        );
        let catalog = fixture.catalog.clone();
        let held = futures::executor::block_on(catalog.hold_turn("account"));
        let metadata = acp_metadata("session-model");
        let mut accepted = 0;
        let mut refused = 0;
        for _ in 0..200 {
            let mut write = Box::pin(catalog.update_from_session(agent.clone(), &metadata));
            match poll_once(write.as_mut()) {
                std::task::Poll::Pending => accepted += 1,
                std::task::Poll::Ready(result) => {
                    if result == Err(CatalogError::SessionActivityCapacity) {
                        refused += 1;
                    }
                }
            }
            drop(write);
        }
        assert_eq!(accepted, 64, "capacity counts every accepted write");
        assert_eq!(refused, 136, "later writes are refused, not queued");
        assert!(
            catalog.pending_session_writes() <= 64,
            "dropped callers never grow pending work past the bound"
        );
        drop(held);
        fixture.spawn.drain();
        settle(
            catalog.update_from_session(agent, &metadata),
            &fixture.spawn,
            "a write after the queue drained",
        )
        .unwrap_or_else(|error| panic!("{error}"));
    })
}

#[test]
fn a_removal_admitted_after_close_began_is_refused() {
    within(15, "a removal after close began", || {
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
        let fixture = fixture(
            vec![codex],
            SharedStorage::new(MemoryStorage::new()),
            discover,
        );
        let catalog = fixture.catalog.clone();
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(flight.as_mut()).is_pending());
        fixture.spawn.drain();
        let mut close = Box::pin(catalog.close());
        assert!(
            poll_once(close.as_mut()).is_pending(),
            "close waits for the flight"
        );
        let removed = settle(
            catalog.remove_instance("account"),
            &fixture.spawn,
            "a removal after close began",
        );
        assert_eq!(removed, Err(CatalogError::Closed));
        gate.open();
        let (_, closed) = settle(
            async move { futures::join!(flight, close) },
            &fixture.spawn,
            "the close that refused the removal",
        );
        closed.unwrap_or_else(|error| panic!("{error}"));
    })
}

#[test]
fn a_stalled_admission_and_a_held_turn_do_not_block_abort_or_close() {
    within(15, "a stalled admission and a held turn", || {
        let stalled = instance(ProviderKind::Codex, "stalled");
        let other = instance(ProviderKind::Claude, "other");
        let admission = crate::signals::Gate::new();
        let held = admission.clone();
        let admit: crate::catalog::Admit = Arc::new(move || {
            let held = held.clone();
            Box::pin(async move {
                held.wait().await;
                Ok(())
            })
        });
        let gate = crate::signals::Gate::new();
        let release = gate.clone();
        let discover = FakeDiscover::new(move |request, _signal| {
            let release = release.clone();
            Box::pin(async move {
                if request.instance.id == "other" {
                    release.wait().await;
                }
                Ok(models(&request.instance, &["a-model"]))
            })
        });
        let fixture = fixture_with_concurrency(
            vec![stalled.clone(), other.clone()],
            SharedStorage::new(MemoryStorage::new()),
            discover,
            1,
        );
        let catalog = fixture.catalog.clone();
        catalog
            .register_instance(stalled, Some(admit))
            .unwrap_or_else(|error| panic!("{error}"));
        let turn = futures::executor::block_on(catalog.hold_turn("stalled"));
        // The stalled admission holds the only discovery slot.
        let mut admitted = Box::pin(catalog.refresh_state("stalled", RefreshCause::Background));
        assert!(
            poll_once(admitted.as_mut()).is_pending(),
            "admission is pending"
        );
        fixture.spawn.drain();
        // The other row's deadline fires while it waits behind the stalled admission.
        let mut waiting = Box::pin(catalog.refresh_state("other", RefreshCause::Background));
        assert!(poll_once(waiting.as_mut()).is_pending());
        fixture.spawn.drain();
        fixture.deadlines.fire(1_000.0 + 1_000.0);
        let mut close = Box::pin(catalog.close());
        assert!(
            poll_once(close.as_mut()).is_pending(),
            "close waits for the flights it aborted"
        );
        let (stalled_status, other_status, closed) = settle(
            async move { futures::join!(admitted, waiting, close) },
            &fixture.spawn,
            "a stalled admission, a held turn and close",
        );
        assert_eq!(stalled_status.error, None, "close aborts admission quietly");
        assert_eq!(
            other_status.error,
            Some(StatusError::Timeout),
            "the deadline still wins behind a stalled admission"
        );
        closed.unwrap_or_else(|error| panic!("{error}"));
        drop(turn);
        // The admission gate is still closed: neither close nor the deadline needed it.
    })
}
