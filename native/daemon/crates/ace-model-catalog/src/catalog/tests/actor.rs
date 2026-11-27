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
            let mut write = Box::pin(catalog.update_from_session(
                agent.clone(),
                token(&catalog, "account"),
                &metadata,
            ));
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
            catalog.update_from_session(agent, token(&catalog, "account"), &metadata),
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
        assert_eq!(
            stalled_status.error,
            Some(StatusError::Timeout),
            "the deadline armed at admission bounds the stalled guard"
        );
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

/// Storage that reports when the last owner drops it.
struct DropProbeStorage {
    inner: MemoryStorage,
    dropped: Arc<AtomicBool>,
}

impl CatalogStorage for DropProbeStorage {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        self.inner.remove(instance)
    }

    fn close(&mut self) -> Result<(), crate::cache::CacheError> {
        self.inner.close()
    }
}

impl Drop for DropProbeStorage {
    fn drop(&mut self) {
        self.dropped.store(true, Ordering::SeqCst);
    }
}

#[test]
fn dropping_every_handle_after_close_ends_the_actor_and_releases_storage() {
    within(15, "the actor after close", || {
        let dropped = Arc::new(AtomicBool::new(false));
        let storage = SharedStorage::new(DropProbeStorage {
            inner: MemoryStorage::new(),
            dropped: dropped.clone(),
        });
        let fixture = fixture(
            vec![instance(ProviderKind::Codex, "account")],
            storage,
            always(Vec::new()),
        );
        let catalog = fixture.catalog.clone();
        settle(catalog.close(), &fixture.spawn, "the close")
            .unwrap_or_else(|error| panic!("{error}"));
        // A later close answers the recorded success rather than reaching a dead actor.
        settle(catalog.close(), &fixture.spawn, "the repeated close")
            .unwrap_or_else(|error| panic!("{error}"));
        drop(catalog);
        drop(fixture);
        assert!(
            dropped.load(Ordering::SeqCst),
            "the actor's rows and storage are gone with it"
        );
    })
}

#[test]
fn a_failed_construction_leaves_no_thread_holding_storage() {
    within(15, "a failed construction", || {
        let dropped = Arc::new(AtomicBool::new(false));
        let mut broken = instance(ProviderKind::Codex, "account");
        broken.id = String::new();
        let options = CatalogOptions::new(
            SharedStorage::new(DropProbeStorage {
                inner: MemoryStorage::new(),
                dropped: dropped.clone(),
            }),
            always(Vec::new()),
            TestClock::new(1_000.0),
            TestDeadlines::new(),
            TestSpawn::new(),
        )
        .instances(vec![broken]);
        assert_eq!(
            Catalog::new(options).err(),
            Some(CatalogError::InvalidInstance)
        );
        assert!(
            dropped.load(Ordering::SeqCst),
            "the actor thread that was started ended with the failed construction"
        );
    })
}

#[test]
fn a_listener_that_reads_the_catalog_never_blocks_the_actor() {
    within(15, "a listener that lists", || {
        let codex = instance(ProviderKind::Codex, "account");
        let fixture = fixture(
            vec![codex],
            SharedStorage::new(MemoryStorage::new()),
            always(vec![row(
                &instance(ProviderKind::Codex, "account"),
                "gpt-6-sol",
            )]),
        );
        let catalog = fixture.catalog.clone();
        let (ran, ran_rx) = std::sync::mpsc::channel();
        let reader = catalog.clone();
        let _listener = catalog
            .listen(Arc::new(move |_| {
                let _ = reader.list(ModelFilter::default(), 0, 100);
                let _ = ran.send(());
            }))
            .unwrap_or_else(|error| panic!("{error}"));
        settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        ran_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap_or_else(|error| panic!("the listener never ran: {error}"));
    })
}

struct PanicSpawn;

impl Spawn for PanicSpawn {
    fn spawn(&self, _task: BoxFuture<'static, ()>) {
        panic!("the spawner refused the task");
    }
}

#[test]
fn a_spawner_that_panics_still_settles_its_task() {
    within(15, "a panicking spawner", || {
        let account = instance(ProviderKind::Codex, "account");
        let options = CatalogOptions::new(
            SharedStorage::new(MemoryStorage::new()),
            always(vec![row(&account, "gpt-6-sol")]),
            TestClock::new(1_000.0),
            TestDeadlines::new(),
            Arc::new(PanicSpawn),
        )
        .instances(vec![account]);
        let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
        let statuses = settle(
            catalog.refresh(ModelFilter::default()),
            &TestSpawn::new(),
            "a refresh whose spawner panics",
        );
        assert!(
            statuses.is_ok(),
            "the refused task settles as aborted, not as a hung refresh"
        );
        settle(catalog.close(), &TestSpawn::new(), "the close")
            .unwrap_or_else(|error| panic!("{error}"));
    })
}

/// Storage whose first write blocks the lane until the test releases it.
struct BlockingFirstReplace {
    inner: MemoryStorage,
    release: std::sync::mpsc::Receiver<()>,
    blocked: Arc<AtomicBool>,
    writes: Arc<Mutex<Vec<String>>>,
    first: bool,
}

impl CatalogStorage for BlockingFirstReplace {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        if self.first {
            self.first = false;
            self.blocked.store(true, Ordering::SeqCst);
            let _ = self.release.recv();
        }
        self.writes
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(entry.instance.clone());
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        self.inner.remove(instance)
    }
}

#[test]
fn a_stalled_storage_lane_never_stalls_the_catalog_and_a_deadline_wins_at_the_write() {
    within(15, "a stalled storage lane", || {
        let slow = instance(ProviderKind::Codex, "slow");
        let fast = instance(ProviderKind::Codex, "fast");
        let (release, blocked_on) = std::sync::mpsc::channel();
        let blocked = Arc::new(AtomicBool::new(false));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let storage = SharedStorage::new(BlockingFirstReplace {
            inner: MemoryStorage::new(),
            release: blocked_on,
            blocked: blocked.clone(),
            writes: writes.clone(),
            first: true,
        });
        let discover = FakeDiscover::new(|request, _signal| {
            Box::pin(async move { Ok(models(&request.instance, &["gpt-6-sol"])) })
        });
        let fixture = fixture(vec![slow, fast], storage, discover);
        let catalog = fixture.catalog.clone();
        // The first commit enters the lane and blocks there.
        let mut slow_flight = Box::pin(catalog.refresh_state("slow", RefreshCause::Background));
        assert!(poll_once(slow_flight.as_mut()).is_pending());
        for _ in 0..100 {
            if blocked.load(Ordering::SeqCst) {
                break;
            }
            fixture.spawn.drain();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(
            blocked.load(Ordering::SeqCst),
            "the slow commit reached storage (discover calls: {})",
            fixture.discover.calls()
        );
        // The actor still answers every other row while the disk is stalled.
        let listed = catalog
            .list(ModelFilter::instance("fast"), 0, 100)
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(
            listed.models.is_empty(),
            "the fast row lists while slow writes"
        );
        // The fast commit queues behind the stalled write, then loses to its deadline.
        let mut fast_flight = Box::pin(catalog.refresh_state("fast", RefreshCause::Background));
        assert!(poll_once(fast_flight.as_mut()).is_pending());
        for _ in 0..100 {
            if fixture.discover.calls() >= 2 {
                break;
            }
            fixture.spawn.drain();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        fixture.spawn.drain();
        fixture.deadlines.fire(1_000.0 + 1_000.0);
        release
            .send(())
            .unwrap_or_else(|error| panic!("release the lane: {error}"));
        let (slow_status, fast_status) = settle(
            async move { futures::join!(slow_flight, fast_flight) },
            &fixture.spawn,
            "the stalled writes",
        );
        assert_eq!(
            slow_status.error,
            Some(StatusError::Timeout),
            "the deadline reached the actor behind the stall"
        );
        assert_eq!(fast_status.error, Some(StatusError::Timeout));
        let written = writes.lock().unwrap_or_else(|error| error.into_inner());
        assert!(
            !written.iter().any(|id| id == "fast"),
            "the queued write saw the deadline before it touched storage: {written:?}"
        );
    })
}

/// Storage whose first removal panics, before it deletes anything.
struct PanicOnceRemove {
    inner: MemoryStorage,
    panics: AtomicUsize,
}

impl CatalogStorage for PanicOnceRemove {
    fn load(&mut self) -> Result<Vec<CacheEntry>, crate::cache::CacheError> {
        self.inner.load()
    }

    fn replace(&mut self, entry: &CacheEntry) -> Result<(), crate::cache::CacheError> {
        self.inner.replace(entry)
    }

    fn remove(&mut self, instance: &str) -> Result<(), crate::cache::CacheError> {
        if self.panics.load(Ordering::SeqCst) > 0 {
            self.panics.fetch_sub(1, Ordering::SeqCst);
            panic!("storage remove panicked before deleting");
        }
        self.inner.remove(instance)
    }
}

#[test]
fn a_deletion_that_panics_before_it_runs_keeps_its_retry_marker() {
    within(15, "a panicking deletion", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(PanicOnceRemove {
            inner: MemoryStorage::new(),
            panics: AtomicUsize::new(1),
        });
        let discover = always(vec![row(&codex, "gpt-6-sol")]);
        let fixture = fixture(vec![codex.clone()], storage.clone(), discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        // The new login's row is incompatible, so the old cached row must be deleted.
        catalog
            .register_instance(
                ModelInstance {
                    login_revision: "2".to_owned(),
                    ..codex
                },
                None,
            )
            .unwrap_or_else(|error| panic!("{error}"));
        fixture.spawn.drain();
        settle(catalog.quiesce(), &fixture.spawn, "the failed deletion");
        let mut inspected = storage.clone();
        assert!(
            !inspected.load().unwrap_or_default().is_empty(),
            "the panic left the row in storage"
        );
        // Close retries the pending deletion; the marker was reserved before the panic.
        settle(catalog.close(), &fixture.spawn, "the close")
            .unwrap_or_else(|error| panic!("{error}"));
        let mut inspected = storage.clone();
        assert!(
            inspected.load().unwrap_or_default().is_empty(),
            "the failed deletion stayed pending and its retry ran before storage closed"
        );
    })
}

#[test]
fn a_hung_admission_loses_its_deadline_and_frees_the_discovery_slot() {
    within(15, "a hung admission and the discovery slot", || {
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
        let discover = FakeDiscover::new(|request, _signal| {
            Box::pin(async move { Ok(models(&request.instance, &["a-model"])) })
        });
        let fixture = fixture_with_concurrency(
            vec![stalled.clone(), other],
            SharedStorage::new(MemoryStorage::new()),
            discover.clone(),
            1,
        );
        let catalog = fixture.catalog.clone();
        catalog
            .register_instance(stalled, Some(admit))
            .unwrap_or_else(|error| panic!("{error}"));
        let mut stalled_flight =
            Box::pin(catalog.refresh_state("stalled", RefreshCause::Background));
        assert!(poll_once(stalled_flight.as_mut()).is_pending());
        fixture.spawn.drain();
        assert_eq!(
            fixture.discover.calls(),
            0,
            "the hung guard holds the only slot before discovery"
        );
        // The deadline is armed at admission, so it bounds the hung guard too.
        fixture.deadlines.fire(1_000.0 + 1_000.0);
        fixture.spawn.drain();
        let status = settle(stalled_flight, &fixture.spawn, "the stalled admission");
        assert_eq!(status.error, Some(StatusError::Timeout));
        // The slot the hung guard held is free: the next row discovers normally.
        let other_status = settle(
            catalog.refresh_state("other", RefreshCause::Background),
            &fixture.spawn,
            "the other row",
        );
        assert_eq!(other_status.error, None);
        assert_eq!(
            fixture.discover.calls(),
            1,
            "the released slot admitted the other row"
        );
    })
}

#[test]
fn a_refresh_over_its_batch_capacity_is_refused() {
    within(20, "refresh batches at capacity", || {
        let account = instance(ProviderKind::Codex, "account");
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
            vec![account],
            SharedStorage::new(MemoryStorage::new()),
            discover,
        );
        let catalog = fixture.catalog.clone();
        let mut batches = Vec::new();
        for _ in 0..crate::catalog::REFRESH_BATCH_LIMIT {
            let mut batch = Box::pin(catalog.refresh(ModelFilter::instance("account")));
            assert!(poll_once(batch.as_mut()).is_pending());
            batches.push(batch);
        }
        let mut refused = Box::pin(catalog.refresh(ModelFilter::instance("account")));
        let result = match poll_once(refused.as_mut()) {
            std::task::Poll::Ready(result) => result,
            std::task::Poll::Pending => panic!("the batch over the bound waits anyway"),
        };
        assert!(
            matches!(result, Err(CatalogError::Busy)),
            "the batch over the bound is refused at once"
        );
        drop(refused);
        drop(batches);
        gate.open();
        fixture.spawn.drain();
        // Close drains whatever the dropped callers left and still ends.
        let mut closing = Box::pin(catalog.close());
        let closed = loop {
            match poll_once(closing.as_mut()) {
                std::task::Poll::Ready(result) => break result,
                std::task::Poll::Pending => {
                    fixture.spawn.drain();
                }
            }
        };
        closed.unwrap_or_else(|error| panic!("{error}"));
    })
}

#[test]
fn dropped_refresh_callers_are_not_retained() {
    within(20, "dropped refresh callers", || {
        let account = instance(ProviderKind::Codex, "account");
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
            vec![account],
            SharedStorage::new(MemoryStorage::new()),
            discover,
        );
        let catalog = fixture.catalog.clone();
        for _ in 0..64 {
            let mut waiting = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
            assert!(poll_once(waiting.as_mut()).is_pending());
            drop(waiting);
        }
        // A live caller prunes the receivers that went away.
        let mut live = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(poll_once(live.as_mut()).is_pending());
        assert!(
            catalog.retained_replies() <= 2,
            "sixty-four dropped callers left {} replies behind",
            catalog.retained_replies()
        );
        drop(live);
        gate.open();
        fixture.spawn.drain();
        let _ = settle(catalog.close(), &fixture.spawn, "the close");
    })
}
