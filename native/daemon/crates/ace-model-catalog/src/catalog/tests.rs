// SPDX-License-Identifier: Apache-2.0
//! Ports `packages/models/src/catalog.process.test.ts`, the catalog cases of
//! `catalog-ux.process.test.ts`, and `session-write-order.test.ts`: "cached pickers
//! return immediately through TTL and revalidate stale rows once", "persisted models
//! are available before discovery after restart", "concurrent explicit refreshes share
//! one discovery result", "failed refresh retains stale rows and cooldown prevents
//! repeated probes", "login change clears the old account immediately and ignores its
//! late refresh", "malformed or mismatched discovery rows never replace the valid
//! cache", "provider and instance filters page only their own models", "picker results
//! cannot mutate the shared cached model", "remove an instance cancels its refresh and
//! deletes persisted choices", "instance admission is bounded and a removed account
//! frees capacity", and "shutdown aborts discovery and closes only after pending
//! flights settle".

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_models::instance::ModelInstance;
use ace_protocol::generated::{CatalogModel, ProviderKind};
use futures::future::BoxFuture;
use serde_json::{Value, json};

mod actor;
mod probes;
mod queries;
mod shutdown;
mod writes;

use super::{
    Catalog, CatalogError, CatalogOptions, Clock, Deadlines, DiagnosticSink, DiscoverResult,
    DiscoveryOutcome, DiscoveryRequest, InstanceStatus, ModelFilter, ModelListResult, Spawn,
    StatusError,
};
use crate::cache::{CacheEntry, MemoryStorage, SharedStorage};
use crate::failures::{DiscoveryFailure, FailureCode};
use crate::gate::RefreshCause;
use crate::signals::Signal;
use crate::sources::{SourceState, SourceStatus};

struct TestClock(Mutex<f64>);

impl TestClock {
    fn new(now: f64) -> Arc<Self> {
        Arc::new(Self(Mutex::new(now)))
    }
    fn advance(&self, millis: f64) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) += millis;
    }
}

impl Clock for TestClock {
    fn now(&self) -> f64 {
        *self.0.lock().unwrap_or_else(|error| error.into_inner())
    }
}

type Timer = (f64, u64, Box<dyn Fn() + Send + Sync>);

#[derive(Default)]
struct TestDeadlines {
    timers: Arc<Mutex<Vec<Timer>>>,
    next: AtomicUsize,
}

impl TestDeadlines {
    fn new() -> Arc<Self> {
        #[allow(clippy::arc_with_non_send_sync)]
        Arc::new(Self::default())
    }

    /// Fires every timer due at `now`, as a timer thread would.
    fn fire(&self, now: f64) {
        let due: Vec<Timer> = {
            let mut timers = self
                .timers
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let (due, waiting) = std::mem::take(&mut *timers)
                .into_iter()
                .partition(|(at, _, _)| *at <= now);
            *timers = waiting;
            due
        };
        for (_, _, expire) in due {
            expire();
        }
    }
}

impl Deadlines for TestDeadlines {
    fn arm(&self, after_ms: f64, expire: Box<dyn Fn() + Send + Sync>) -> super::Cancel {
        let id = self.next.fetch_add(1, Ordering::SeqCst) as u64;
        let at = after_ms;
        self.timers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push((at, id, expire));
        let timers = self.timers.clone();
        Box::new(move || {
            timers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .retain(|(_, timer, _)| *timer != id);
        })
    }
}

#[allow(clippy::arc_with_non_send_sync)]
#[derive(Default)]
struct TestSpawn {
    tasks: Mutex<Vec<BoxFuture<'static, ()>>>,
    driving: AtomicBool,
}

impl TestSpawn {
    fn new() -> Arc<Self> {
        #[allow(clippy::arc_with_non_send_sync)]
        Arc::new(Self::default())
    }

    /// Drops every queued task before it first runs; returns how many were dropped.
    fn discard(&self) -> usize {
        let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
        let dropped = tasks.len();
        tasks.clear();
        dropped
    }

    /// Polls every queued task until all settle; returns how many tasks ran.
    fn drain(&self) -> usize {
        if self.driving.swap(true, Ordering::SeqCst) {
            return 0;
        }
        let mut ran = 0;
        let mut idle = 0;
        let mut stalled_for = 0;
        for _pass in 0..100_000 {
            let batch: Vec<_> = {
                let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
                std::mem::take(&mut *tasks)
            };
            if batch.is_empty() {
                // The actor thread may be about to spawn the next step of a flight.
                idle += 1;
                if idle >= 50 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
                continue;
            }
            let mut pending = Vec::new();
            let mut completed = 0;
            for mut task in batch {
                ran += 1;
                let waker = futures::task::noop_waker();
                let mut context = std::task::Context::from_waker(&waker);
                if task.as_mut().poll(&mut context).is_pending() {
                    pending.push(task);
                } else {
                    completed += 1;
                }
            }
            let stalled = completed == 0;
            let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
            tasks.extend(pending);
            if stalled {
                idle += 1;
                stalled_for += 1;
                if stalled_for >= 50 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(1));
            } else {
                idle = 0;
            }
        }
        self.driving.store(false, Ordering::SeqCst);
        ran
    }
}

impl Spawn for TestSpawn {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(task);
    }

    fn drive(&self) {
        // The actor may spawn the next step of a flight after any message; draining here
        // lets a blocking caller see the same progress a runtime would.
        self.drain();
    }
}

type DiscoverFn =
    dyn Fn(DiscoveryRequest, Signal) -> BoxFuture<'static, DiscoverResult> + Send + Sync;

struct FakeDiscover {
    calls: AtomicUsize,
    run: Arc<DiscoverFn>,
}

impl FakeDiscover {
    fn new(
        run: impl Fn(DiscoveryRequest, Signal) -> BoxFuture<'static, DiscoverResult>
        + Send
        + Sync
        + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            run: Arc::new(run),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl super::CatalogDiscover for FakeDiscover {
    fn discover(
        &self,
        request: DiscoveryRequest,
        signal: Signal,
        _diagnostic: DiagnosticSink,
    ) -> BoxFuture<'static, DiscoverResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        (self.run)(request, signal)
    }
}

/// Counts a discovery future being dropped (an aborted flight drops it).
struct DropObserver(Arc<AtomicUsize>);

impl Drop for DropObserver {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

fn poll_once<F: std::future::Future>(future: std::pin::Pin<&mut F>) -> std::task::Poll<F::Output> {
    let waker = futures::task::noop_waker();
    let mut context = std::task::Context::from_waker(&waker);
    future.poll(&mut context)
}

/// Drives `future` and the spawned tasks until it settles; fails rather than hang.
fn settle<F: std::future::Future>(future: F, spawn: &TestSpawn, what: &str) -> F::Output {
    let mut future = Box::pin(future);
    for _ in 0..100 {
        if let std::task::Poll::Ready(output) = poll_once(future.as_mut()) {
            return output;
        }
        spawn.drain();
    }
    panic!("{what} still waits after every spawned task settled");
}

/// Runs `body` on its own thread, so a catalog that deadlocks fails the test instead of
/// hanging the suite: the thread never answers and the wait times out.
fn within<T: Send + 'static>(
    seconds: u64,
    what: &str,
    body: impl FnOnce() -> T + Send + 'static,
) -> T {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(body());
    });
    match receiver.recv_timeout(std::time::Duration::from_secs(seconds)) {
        Ok(value) => value,
        Err(error) => panic!("{what} never settled ({error:?}): the catalog deadlocked"),
    }
}

/// The rows the catalog serves now.
/// The token that owns a row's current registration.
fn token(catalog: &Catalog, id: &str) -> super::RegistrationToken {
    catalog
        .registration(id)
        .map(|(_, token)| token)
        .unwrap_or_else(|| panic!("{id} is registered"))
}

fn listed(catalog: &Catalog) -> ModelListResult {
    catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"))
}

fn row(instance: &ModelInstance, id: &str) -> CatalogModel {
    ace_models::row::base(instance, id, id, &json!({}))
}

fn models(instance: &ModelInstance, ids: &[&str]) -> DiscoveryOutcome {
    DiscoveryOutcome {
        models: ids.iter().map(|id| row(instance, id)).collect(),
        sources: None,
        permission_modes: None,
    }
}

fn instance(provider: ProviderKind, id: &str) -> ModelInstance {
    ModelInstance::cli(id, provider, "/usr/bin/provider", "/work")
}

struct Fixture {
    catalog: Catalog,
    clock: Arc<TestClock>,
    deadlines: Arc<TestDeadlines>,
    spawn: Arc<TestSpawn>,
    discover: Arc<FakeDiscover>,
}

fn fixture(
    instances: Vec<ModelInstance>,
    storage: SharedStorage,
    discover: Arc<FakeDiscover>,
) -> Fixture {
    fixture_with_concurrency(instances, storage, discover, super::DEFAULT_CONCURRENCY)
}

fn fixture_with_concurrency(
    instances: Vec<ModelInstance>,
    storage: SharedStorage,
    discover: Arc<FakeDiscover>,
    concurrency: usize,
) -> Fixture {
    let clock = TestClock::new(1_000.0);
    let deadlines = TestDeadlines::new();
    let spawn = TestSpawn::new();
    let mut options = CatalogOptions::new(
        storage,
        discover.clone(),
        clock.clone(),
        deadlines.clone(),
        spawn.clone(),
    );
    options.instances = instances;
    options.timeout_ms = 1_000.0;
    options.retry_ms = 30_000.0;
    options.concurrency = concurrency;
    let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
    Fixture {
        catalog,
        clock,
        deadlines,
        spawn,
        discover,
    }
}

fn always(models: Vec<CatalogModel>) -> Arc<FakeDiscover> {
    FakeDiscover::new(move |_request, _signal| {
        let models = models.clone();
        Box::pin(async move {
            Ok(DiscoveryOutcome {
                models,
                sources: None,
                permission_modes: None,
            })
        })
    })
}

#[test]
fn cached_pickers_return_through_ttl_and_revalidate_a_stale_row_once() {
    let codex = instance(ProviderKind::Codex, "account");
    let rows = vec![row(&codex, "gpt-6-sol"), row(&codex, "gpt-6")];
    let discover = always(rows);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = &fixture.catalog;
    // The first read returns at once and asks for discovery in the background.
    let first = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(first.models.is_empty());
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 1);
    let second = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(second.models.len(), 2);
    assert!(!second.instances[0].stale);
    // Within the TTL a read does not discover again.
    fixture.spawn.drain();
    let _ = catalog.list(ModelFilter::default(), 0, 100);
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 1);
    // Past it, one more discovery replaces the rows.
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let stale = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(stale.instances[0].stale);
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 2);
}

#[test]
fn a_rejected_admission_revokes_rows_without_launching_discovery() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex.clone()],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let _ = settle(
        fixture.catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    let calls = fixture.discover.calls();
    let admit: super::Admit =
        std::sync::Arc::new(|| Box::pin(async { Err("home identity changed".to_owned()) }));
    fixture
        .catalog
        .register_instance(codex, Some(admit))
        .unwrap_or_else(|error| panic!("{error}"));
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let after = settle(
        fixture
            .catalog
            .refresh_state("account", RefreshCause::Background),
        &fixture.spawn,
        "the refresh",
    );
    assert_eq!(after.error, Some(StatusError::DiscoveryFailed));
    assert_eq!(fixture.discover.calls(), calls, "discovery never launched");
    assert!(listed(&fixture.catalog).models.is_empty());
}

#[test]
fn a_cli_below_its_minimum_is_refused_before_discovery() {
    let mut codex = instance(ProviderKind::Codex, "account");
    codex.installation_version = Some("0.1.0".to_owned());
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let after = settle(
        fixture
            .catalog
            .refresh_state("account", RefreshCause::Background),
        &fixture.spawn,
        "the refresh",
    );
    assert_eq!(
        after.error_detail.as_ref().map(|detail| detail.code),
        Some(crate::failures::FailureCode::CliTooOld)
    );
    assert_eq!(fixture.discover.calls(), 0);
}

#[test]
fn an_acp_rows_load_only_when_its_probe_is_configured() {
    for (probe, expected_calls) in [
        (None, 0),
        (Some(ace_models::instance::ModelProbe::OnRequest), 1),
    ] {
        let mut agent = instance(ProviderKind::Acp, "agent");
        agent.model_probe = probe;
        let discover = always(vec![row(&agent, "plan")]);
        let fixture = fixture(
            vec![agent],
            SharedStorage::new(MemoryStorage::new()),
            discover.clone(),
        );
        let statuses = settle(fixture.catalog.load("agent"), &fixture.spawn, "the load")
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(statuses.len(), 1);
        assert_eq!(fixture.discover.calls(), expected_calls, "{probe:?}");
    }
}

#[test]
fn an_invalidation_never_waits_on_the_write_it_drains() {
    within(15, "an invalidation and the write it drains", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let discover = always(vec![row(&codex, "gpt-6-sol")]);
        let fixture = fixture(vec![codex], storage.clone(), discover);
        let catalog = fixture.catalog.clone();
        let _ = settle(
            catalog.refresh(ModelFilter::default()),
            &fixture.spawn,
            "the login's refresh",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        // One writer holds the queue, and a flight's commit takes its place behind it.
        let held = futures::executor::block_on(catalog.hold_turn("account"));
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(
            poll_once(flight.as_mut()).is_pending(),
            "the commit waits behind the writer"
        );
        // The revocation is accepted while that commit waits, and drains it.
        let mut invalidating = Box::pin(catalog.invalidate(ModelFilter::default()));
        assert!(
            poll_once(invalidating.as_mut()).is_pending(),
            "the revocation waits for the flight it drains"
        );
        drop(held);
        let (_, revoked) = settle(
            async move { futures::join!(flight, invalidating) },
            &fixture.spawn,
            "an invalidation and the flight it drains",
        );
        revoked.unwrap_or_else(|error| panic!("{error}"));
        let storage = storage.clone();
        assert!(
            storage.load().unwrap_or_default().is_empty(),
            "the revoked row's choices are deleted"
        );
        assert!(catalog.has_instance("account"), "the row keeps its place");
        assert!(
            listed(&catalog).models.is_empty(),
            "the revoked choices are gone"
        );
    })
}

#[test]
fn an_invalidate_of_one_instance_leaves_another_alone() {
    let first = instance(ProviderKind::Codex, "a");
    let second = instance(ProviderKind::Codex, "b");
    let discover = FakeDiscover::new(|request, _signal| {
        Box::pin(async move { Ok(models(&request.instance, &["gpt-6-sol"])) })
    });
    let fixture = fixture(
        vec![first, second],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    settle(
        catalog.invalidate(ModelFilter::instance("a")),
        &fixture.spawn,
        "the invalidation",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let a = catalog
        .list(ModelFilter::instance("a"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    let b = catalog
        .list(ModelFilter::instance("b"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(a.models.is_empty());
    assert_eq!(b.models.len(), 1, "b keeps its choices");
}

#[test]
fn an_old_logins_admission_result_never_revokes_the_new_login() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let admit: super::Admit = std::sync::Arc::new(move || {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Err("home identity changed".to_owned())
        })
    });
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex.clone()],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    catalog
        .register_instance(codex.clone(), Some(admit))
        .unwrap_or_else(|error| panic!("{error}"));
    let mut old = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(old.as_mut()).is_pending(), "admission is pending");
    // A new login replaces the row with its own passing admission; its refresh succeeds.
    let passing: super::Admit = std::sync::Arc::new(|| Box::pin(async { Ok(()) }));
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..codex
            },
            Some(passing),
        )
        .unwrap_or_else(|error| panic!("{error}"));
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(listed(&catalog).models.len(), 1);
    gate.open();
    let _ = settle(old, &fixture.spawn, "the old flight");
    assert_eq!(
        listed(&catalog).models.len(),
        1,
        "the old admission result revoked nothing"
    );
}

#[test]
fn an_invalidate_waits_out_a_refresh_whose_row_was_replaced() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let discover = FakeDiscover::new(move |_request, _signal| {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(DiscoveryOutcome::default())
        })
    });
    let fixture = fixture(
        vec![codex.clone()],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(flight.as_mut()).is_pending());
    // A new login replaces the row while its old refresh is still running.
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..codex
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    let mut invalidating = Box::pin(catalog.invalidate(ModelFilter::default()));
    // The replaced row's invalidation still waits for the refresh it replaced.
    assert!(
        poll_once(invalidating.as_mut()).is_pending(),
        "the invalidation waits for the running flight"
    );
    assert!(poll_once(invalidating.as_mut()).is_pending());
    gate.open();
    let (_, invalidated) = settle(
        async move { futures::join!(flight, invalidating) },
        &fixture.spawn,
        "an invalidation and its flight",
    );
    invalidated.unwrap_or_else(|error| panic!("{error}"));
    assert!(catalog.has_instance("account"));
}

#[test]
fn a_removal_waits_out_a_refresh_whose_row_was_replaced() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let discover = FakeDiscover::new(move |_request, _signal| {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(DiscoveryOutcome::default())
        })
    });
    let fixture = fixture(
        vec![codex.clone()],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(flight.as_mut()).is_pending());
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..codex
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    let mut removing = Box::pin(catalog.remove_instance("account"));
    // The replacement's removal still waits for the refresh it replaced.
    assert!(
        poll_once(removing.as_mut()).is_pending(),
        "the removal waits for the running flight"
    );
    assert!(poll_once(removing.as_mut()).is_pending());
    gate.open();
    let (_, removed) = settle(
        async move { futures::join!(flight, removing) },
        &fixture.spawn,
        "a removal and its flight",
    );
    removed.unwrap_or_else(|error| panic!("{error}"));
    assert!(!catalog.has_instance("account"));
}

#[test]
fn a_removal_never_waits_on_a_flight_queued_behind_another_rows_discovery() {
    let held_row = instance(ProviderKind::Codex, "held");
    let account = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let release = gate.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let release = release.clone();
        Box::pin(async move {
            if request.instance.id == "held" {
                release.wait().await;
            }
            Ok(models(&request.instance, &["row-one"]))
        })
    });
    let fixture = fixture_with_concurrency(
        vec![held_row, account],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
        1,
    );
    let catalog = fixture.catalog.clone();
    // One slot only: "held" takes it and waits on the gate.
    let mut holder = Box::pin(catalog.refresh_state("held", RefreshCause::Background));
    assert!(
        poll_once(holder.as_mut()).is_pending(),
        "the only discovery slot is taken"
    );
    // "account" queues its flight behind the held discovery.
    let _ = catalog.list(ModelFilter::instance("account"), 0, 100);
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 1);
    let removed = settle(
        catalog.remove_instance("account"),
        &fixture.spawn,
        "the remover",
    );
    removed.unwrap_or_else(|error| panic!("{error}"));
    assert!(!catalog.has_instance("account"));
    assert_eq!(
        fixture.discover.calls(),
        1,
        "the removed row's queued flight never launched discovery"
    );
    gate.open();
    let _ = settle(holder, &fixture.spawn, "the held row's flight");
}

#[test]
fn an_invalidation_never_waits_on_a_flight_queued_behind_another_rows_discovery() {
    let held_row = instance(ProviderKind::Codex, "held");
    let account = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let release = gate.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let release = release.clone();
        Box::pin(async move {
            if request.instance.id == "held" {
                release.wait().await;
            }
            Ok(models(&request.instance, &["row-one"]))
        })
    });
    let fixture = fixture_with_concurrency(
        vec![held_row, account],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
        1,
    );
    let catalog = fixture.catalog.clone();
    let mut holder = Box::pin(catalog.refresh_state("held", RefreshCause::Background));
    assert!(
        poll_once(holder.as_mut()).is_pending(),
        "the only discovery slot is taken"
    );
    let _ = catalog.list(ModelFilter::instance("account"), 0, 100);
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 1);
    let invalidated = settle(
        catalog.invalidate(ModelFilter::instance("account")),
        &fixture.spawn,
        "the invalidator",
    );
    invalidated.unwrap_or_else(|error| panic!("{error}"));
    assert!(catalog.has_instance("account"));
    assert!(
        listed(&catalog)
            .models
            .iter()
            .all(|model| model.instance.0 != "account"),
        "the invalidated row's queued flight never wrote choices"
    );
    assert_eq!(fixture.discover.calls(), 1);
    gate.open();
    let _ = settle(holder, &fixture.spawn, "the held row's flight");
}

#[test]
fn persisted_models_are_available_before_discovery_after_restart() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let entry = CacheEntry {
        provider: ProviderKind::Codex,
        instance: "account".into(),
        login_revision: Some("1".into()),
        revision: super::revision_of(&codex, None),
        refreshed_at: 10.0,
        models: vec![Arc::new(row(&codex, "gpt-6-sol"))],
        sources: None,
        permission_modes: None,
        identity_revision: Some(super::identity_revision(&codex)),
        connection_revision: None,
    };
    let mut writer = storage.clone();
    writer
        .replace(&entry)
        .unwrap_or_else(|error| panic!("{error}"));
    let discover = always(Vec::new());
    let fixture = fixture(vec![codex], storage, discover.clone());
    let listed = fixture
        .catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(listed.models.len(), 1);
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 1);
}

#[test]
fn concurrent_explicit_refreshes_share_one_discovery_result() {
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
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    let mut left = Box::pin(catalog.refresh(ModelFilter::default()));
    assert!(poll_once(left.as_mut()).is_pending());
    let mut right = Box::pin(catalog.refresh(ModelFilter::default()));
    assert!(poll_once(right.as_mut()).is_pending());
    gate.open();
    let left =
        settle(left, &fixture.spawn, "the left refresh").unwrap_or_else(|error| panic!("{error}"));
    let right = settle(right, &fixture.spawn, "the right refresh")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(left.len(), 1);
    assert_eq!(right.len(), 1);
    assert_eq!(fixture.discover.calls(), 1);
    assert_eq!(listed(&fixture.catalog).models.len(), 1);
}

#[test]
fn a_failed_refresh_retains_stale_rows_and_waits_out_its_pause() {
    let codex = instance(ProviderKind::Codex, "account");
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let seen = seen.clone();
        Box::pin(async move {
            if seen.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(models(&request.instance, &["gpt-6-sol"]))
            } else {
                Err(DiscoveryFailure::with_status(503.0))
            }
        })
    });
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = &fixture.catalog;
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let after = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(after[0].error, Some(StatusError::DiscoveryFailed));
    assert_eq!(
        after[0].error_detail.as_ref().map(|detail| detail.code),
        Some(FailureCode::Unreachable)
    );
    // The retained rows are still pickable while the row is stale.
    let listed = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(listed.models.len(), 1);
    assert!(listed.instances[0].stale);
    // The pause forbids another probe.
    let _ = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 2);
    fixture.clock.advance(60_000.0);
    let _ = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    fixture.spawn.drain();
    assert_eq!(fixture.discover.calls(), 3);
}

#[test]
fn a_login_change_clears_the_old_account_and_ignores_its_late_refresh() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let dropped = Arc::new(AtomicUsize::new(0));
    let watched = dropped.clone();
    let first_call = Arc::new(AtomicUsize::new(0));
    let call = first_call.clone();
    let discover = FakeDiscover::new(move |request, _signal| {
        let held = held.clone();
        let observer = DropObserver(watched.clone());
        let call = call.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            let _observer = observer;
            if call > 0 {
                // The new login discovers immediately.
                return Ok(models(&request.instance, &["new-account-model"]));
            }
            held.wait().await;
            Ok(models(&request.instance, &["old-account-model"]))
        })
    });
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    let mut flight = Box::pin(catalog.refresh(ModelFilter::default()));
    assert!(
        poll_once(flight.as_mut()).is_pending(),
        "discovery waits on the gate"
    );
    fixture.spawn.drain();
    settle(
        async {
            catalog
                .login_changed("account", "2", None)
                .await
                .unwrap_or_else(|error| panic!("{error}"));
        },
        &fixture.spawn,
        "the login change",
    );
    assert!(
        dropped.load(Ordering::SeqCst) >= 1,
        "the old flight's discovery was aborted and dropped"
    );
    gate.open();
    let _ = settle(flight, &fixture.spawn, "the flight");
    let listed = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(
        listed
            .models
            .iter()
            .all(|model| model.id.0 != "old-account-model"),
        "the previous login's rows never reappear"
    );
}

#[test]
fn a_row_that_does_not_belong_to_its_instance_never_replaces_the_cache() {
    let codex = instance(ProviderKind::Codex, "account");
    let other = instance(ProviderKind::Codex, "elsewhere");
    let calls = Arc::new(AtomicUsize::new(0));
    let discover = FakeDiscover::new(move |request, _signal| {
        let other = other.clone();
        let call = calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if call == 0 {
                Ok(models(&request.instance, &["gpt-6-sol"]))
            } else {
                let mut found = models(&request.instance, &["gpt-7"]);
                found.models[0].instance = other.id.clone().into();
                Ok(found)
            }
        })
    });
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = &fixture.catalog;
    let _ = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    );
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let after = settle(
        catalog.refresh(ModelFilter::default()),
        &fixture.spawn,
        "the refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(after[0].error, Some(StatusError::PersistenceFailed));
    let listed = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    let ids: Vec<&str> = listed
        .models
        .iter()
        .map(|model| model.id.0.as_str())
        .collect();
    assert_eq!(ids, ["gpt-6-sol"]);
}

#[test]
fn a_discovery_that_reports_success_after_its_timeout_never_commits() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = FakeDiscover::new(|request, signal| {
        Box::pin(async move {
            signal.wait().await;
            Ok(models(&request.instance, &["late-success"]))
        })
    });
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(
        poll_once(flight.as_mut()).is_pending(),
        "the discovery waits"
    );
    fixture.spawn.drain();
    // The deadline fires, and the discovery answers success on the same poll anyway.
    fixture.deadlines.fire(1_000.0 + 1_000.0);
    let status = settle(flight, &fixture.spawn, "the flight");
    assert_eq!(status.error, Some(StatusError::Timeout));
    assert_eq!(fixture.discover.calls(), 1);
    let listed = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(
        listed
            .models
            .iter()
            .all(|model| model.id.0 != "late-success"),
        "an aborted discovery's rows never reach the picker"
    );
}

#[test]
fn a_commit_held_past_its_deadline_never_writes_and_reports_a_timeout() {
    within(15, "a commit held past its deadline", || {
        let codex = instance(ProviderKind::Codex, "account");
        let storage = SharedStorage::new(MemoryStorage::new());
        let discover = always(vec![row(&codex, "gpt-6-sol")]);
        let fixture = fixture(vec![codex], storage.clone(), discover.clone());
        let catalog = fixture.catalog.clone();
        // A writer holds the row's queue, so the discovery's commit cannot take its place.
        let held = futures::executor::block_on(catalog.hold_turn("account"));
        let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
        assert!(
            poll_once(flight.as_mut()).is_pending(),
            "the commit waits for the queue"
        );
        fixture.spawn.drain();
        assert_eq!(
            fixture.discover.calls(),
            1,
            "the discovery already answered"
        );
        // The deadline passes while the commit waits for the queue.
        fixture.deadlines.fire(1_000.0 + 1_000.0);
        drop(held);
        let status = settle(flight, &fixture.spawn, "the flight whose queue was held");
        assert_eq!(status.error, Some(StatusError::Timeout));
        let storage = storage.clone();
        assert!(
            storage.load().unwrap_or_default().is_empty(),
            "a discovery that outlived its deadline never reaches the cache"
        );
        assert!(
            listed(&catalog).models.is_empty(),
            "and never reaches the picker"
        );
    })
}

#[test]
fn a_deadline_armed_at_admission_bounds_a_stalled_guard() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let admit: super::Admit = std::sync::Arc::new(move || {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(())
        })
    });
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex.clone()],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    catalog
        .register_instance(codex, Some(admit))
        .unwrap_or_else(|error| panic!("{error}"));
    let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(
        poll_once(flight.as_mut()).is_pending(),
        "admission is pending"
    );
    fixture.spawn.drain();
    // The deadline is armed at admission, before the guard can hang: it wins even though
    // the discovery never launched.
    fixture.deadlines.fire(1_000.0 + 1_000.0);
    // Let the actor take the deadline before the guard is allowed to answer.
    fixture.spawn.drain();
    gate.open();
    let status = settle(flight, &fixture.spawn, "the flight");
    assert_eq!(
        status.error,
        Some(StatusError::Timeout),
        "a guard that never answers cannot outlive the deadline"
    );
    assert_eq!(fixture.discover.calls(), 0, "discovery never launched");
    assert!(listed(&catalog).models.is_empty());
}

#[test]
fn a_revocation_during_admission_launches_no_discovery() {
    let codex = instance(ProviderKind::Codex, "account");
    let gate = crate::signals::Gate::new();
    let held = gate.clone();
    let admit: super::Admit = std::sync::Arc::new(move || {
        let held = held.clone();
        Box::pin(async move {
            held.wait().await;
            Ok(())
        })
    });
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex.clone()],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    catalog
        .register_instance(codex.clone(), Some(admit))
        .unwrap_or_else(|error| panic!("{error}"));
    let mut flight = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(
        poll_once(flight.as_mut()).is_pending(),
        "admission is pending"
    );
    fixture.spawn.drain();
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..codex
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    gate.open();
    let _ = settle(flight, &fixture.spawn, "the flight");
    assert_eq!(
        fixture.discover.calls(),
        0,
        "the revoked admission never launches discovery"
    );
}

#[test]
fn an_old_flights_settlement_never_completes_a_batch_waiting_on_its_replacement() {
    within(15, "an old flight's late settlement", || {
        let codex = instance(ProviderKind::Codex, "account");
        let old_gate = crate::signals::Gate::new();
        let new_gate = crate::signals::Gate::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let (old_ready, new_ready) = (old_gate.clone(), new_gate.clone());
        let seen = calls.clone();
        let discover = FakeDiscover::new(move |request, _signal| {
            let call = seen.fetch_add(1, Ordering::SeqCst);
            let gate = if call == 0 {
                old_ready.clone()
            } else {
                new_ready.clone()
            };
            Box::pin(async move {
                gate.wait().await;
                Ok(models(&request.instance, &["gpt-6-sol"]))
            })
        });
        let fixture = fixture(
            vec![codex.clone()],
            SharedStorage::new(MemoryStorage::new()),
            discover,
        );
        let catalog = fixture.catalog.clone();
        let mut first = Box::pin(catalog.refresh(ModelFilter::instance("account")));
        assert!(
            poll_once(first.as_mut()).is_pending(),
            "the old flight runs"
        );
        fixture.spawn.drain();
        // The row is replaced while its old flight still runs; the replacement starts its
        // own flight and a batch waits on it.
        catalog
            .register_instance(codex, None)
            .unwrap_or_else(|error| panic!("{error}"));
        let mut second = Box::pin(catalog.refresh(ModelFilter::instance("account")));
        assert!(
            poll_once(second.as_mut()).is_pending(),
            "the replacement flight runs"
        );
        // The old flight's task now ends and reports; that settlement must not answer the
        // batch waiting for the replacement.
        fixture.spawn.drain();
        assert!(
            poll_once(second.as_mut()).is_pending(),
            "the old flight's settlement left the replacement's batch waiting"
        );
        new_gate.open();
        let statuses = settle(second, &fixture.spawn, "the replacement refresh")
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(statuses.len(), 1);
        let _ = settle(first, &fixture.spawn, "the old refresh");
        assert_eq!(listed(&catalog).models.len(), 1);
    })
}
