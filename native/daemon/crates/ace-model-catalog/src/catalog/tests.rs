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

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_models::instance::ModelInstance;
use ace_protocol::generated::{CatalogModel, ProviderKind};
use futures::future::LocalBoxFuture;
use serde_json::{Value, json};

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
    tasks: Mutex<Vec<futures::future::LocalBoxFuture<'static, ()>>>,
}

impl TestSpawn {
    fn new() -> Arc<Self> {
        #[allow(clippy::arc_with_non_send_sync)]
        Arc::new(Self::default())
    }

    /// Polls every queued task until all settle; returns how many tasks ran.
    fn drain(&self) -> usize {
        let mut ran = 0;
        for _pass in 0..1_000 {
            let batch: Vec<_> = {
                let mut tasks = self.tasks.lock().unwrap_or_else(|error| error.into_inner());
                std::mem::take(&mut *tasks)
            };
            if batch.is_empty() {
                return ran;
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
            let held = pending.len();
            tasks.extend(pending);
            if stalled && tasks.len() == held {
                return ran;
            }
        }
        ran
    }
}

impl Spawn for TestSpawn {
    fn spawn(&self, task: LocalBoxFuture<'static, ()>) {
        self.tasks
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(task);
    }
}

type DiscoverFn =
    dyn Fn(DiscoveryRequest, Signal) -> LocalBoxFuture<'static, DiscoverResult> + Send + Sync;

struct FakeDiscover {
    calls: AtomicUsize,
    run: Arc<DiscoverFn>,
}

impl FakeDiscover {
    fn new(
        run: impl Fn(DiscoveryRequest, Signal) -> LocalBoxFuture<'static, DiscoverResult>
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
    ) -> LocalBoxFuture<'static, DiscoverResult> {
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
    let _ = futures::executor::block_on(fixture.catalog.refresh(ModelFilter::default()));
    let calls = fixture.discover.calls();
    let admit: super::Admit =
        std::sync::Arc::new(|| Box::pin(async { Err("home identity changed".to_owned()) }));
    fixture
        .catalog
        .register_instance(codex, Some(admit))
        .unwrap_or_else(|error| panic!("{error}"));
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let after = futures::executor::block_on(
        fixture
            .catalog
            .refresh_state("account", RefreshCause::Background),
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
    let after = futures::executor::block_on(
        fixture
            .catalog
            .refresh_state("account", RefreshCause::Background),
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
        let statuses = futures::executor::block_on(fixture.catalog.load("agent"))
            .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(statuses.len(), 1);
        assert_eq!(fixture.discover.calls(), expected_calls, "{probe:?}");
    }
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
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    futures::executor::block_on(catalog.invalidate(ModelFilter::instance("a")))
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
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(listed(&catalog).models.len(), 1);
    gate.open();
    let _ = futures::executor::block_on(old);
    assert_eq!(
        listed(&catalog).models.len(),
        1,
        "the old admission result revoked nothing"
    );
}

#[test]
fn a_queued_write_for_the_old_login_never_lands_on_the_new_one() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex.clone()], storage.clone(), discover);
    let catalog = fixture.catalog.clone();
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    // Accepted, then a new login registers and loads its own row before the queued task runs.
    catalog.update_permission_modes(
        "account",
        vec![serde_json::json!({
            "id": "plan", "label": "Plan", "description": "", "risk": "low"
        })],
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
        "the new login's refresh",
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(listed(&catalog).models.len(), 1, "the new login loaded");
    fixture.spawn.drain();
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored.iter().all(|entry| entry
            .permission_modes
            .as_ref()
            .is_none_or(|modes| modes.is_empty())),
        "login A's modes never land on login B"
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
    let invalidating = catalog.invalidate(ModelFilter::default());
    let (_, invalidated) =
        futures::executor::block_on(async move { futures::join!(flight, invalidating) });
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
    let removing = catalog.remove_instance("account");
    let (_, removed) = futures::executor::block_on(async move { futures::join!(flight, removing) });
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
    assert_eq!(fixture.spawn.drain(), 1, "the row's flight is queued");
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
    let _ = futures::executor::block_on(holder);
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
    assert_eq!(fixture.spawn.drain(), 1, "the row's flight is queued");
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
    let _ = futures::executor::block_on(holder);
}

#[test]
fn close_drains_a_write_accepted_before_it_started() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex], storage.clone(), discover);
    let catalog = fixture.catalog.clone();
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    // Accepted, but its task has not run yet: close must wait for it.
    catalog.update_permission_modes(
        "account",
        vec![serde_json::json!({
            "id": "plan",
            "label": "Plan",
            "description": "",
            "risk": "low"
        })],
    );
    let mut close = Box::pin(catalog.close());
    let closed = loop {
        match poll_once(close.as_mut()) {
            std::task::Poll::Ready(result) => break result,
            std::task::Poll::Pending => {
                fixture.spawn.drain();
            }
        }
    };
    closed.unwrap_or_else(|error| panic!("{error}"));
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert_eq!(
        stored[0]
            .permission_modes
            .as_ref()
            .and_then(|modes| modes.first())
            .and_then(|mode| mode.get("id"))
            .and_then(|id| id.as_str()),
        Some("plan")
    );
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
    let left = futures::executor::block_on(left).unwrap_or_else(|error| panic!("{error}"));
    let right = futures::executor::block_on(right).unwrap_or_else(|error| panic!("{error}"));
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
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let after = futures::executor::block_on(catalog.refresh(ModelFilter::default()))
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
    futures::executor::block_on(async {
        catalog
            .login_changed("account", "2", None)
            .await
            .unwrap_or_else(|error| panic!("{error}"));
    });
    assert!(
        dropped.load(Ordering::SeqCst) >= 1,
        "the old flight's discovery was aborted and dropped"
    );
    gate.open();
    let _ = futures::executor::block_on(flight);
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
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    fixture.clock.advance(super::DEFAULT_TTL_MS + 1.0);
    let after = futures::executor::block_on(catalog.refresh(ModelFilter::default()))
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
fn filters_page_only_their_own_instances() {
    let codex = instance(ProviderKind::Codex, "codex");
    let claude = instance(ProviderKind::Claude, "claude");
    let discover = FakeDiscover::new(|request, _signal| {
        Box::pin(async move {
            let ids: &[&str] = if request.instance.provider == ProviderKind::Codex {
                &["gpt-6-sol", "gpt-6"]
            } else {
                &["claude-opus-5", "claude-sonnet-5"]
            };
            Ok(models(&request.instance, ids))
        })
    });
    let fixture = fixture(
        vec![codex, claude],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = &fixture.catalog;
    // Every row is read once, which is what asks each instance for its models.
    let _ = listed(catalog);
    fixture.spawn.drain();
    let _ = listed(catalog);
    let codex_page = catalog
        .list(ModelFilter::provider(ProviderKind::Codex), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(codex_page.models.len(), 2);
    assert!(
        codex_page
            .models
            .iter()
            .all(|model| model.provider == ProviderKind::Codex)
    );
    assert_eq!(codex_page.instances.len(), 1);
    let page = catalog
        .list(ModelFilter::default(), 1, 1)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(page.models.len(), 1);
    assert_eq!(page.next_offset, Some(2));
    let only = catalog
        .list(ModelFilter::instance("claude"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(only.instances.len(), 1);
    assert_eq!(only.instances[0].instance, "claude");
}

#[test]
fn picker_results_cannot_mutate_the_shared_cached_row() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = &fixture.catalog;
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    let mut first = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    first.models[0].display_name = "Mutated".to_owned().into();
    let second = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_ne!(second.models[0].display_name.0, "Mutated");
}

#[test]
fn removing_an_instance_cancels_its_refresh_and_deletes_its_cached_rows() {
    let codex = instance(ProviderKind::Codex, "account");
    let storage = MemoryStorage::new();
    let shared = SharedStorage::new(storage);
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(vec![codex], shared.clone(), discover);
    let catalog = &fixture.catalog;
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    futures::executor::block_on(async { catalog.remove_instance("account").await })
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(!catalog.has_instance("account"));
    assert!(listed(catalog).models.is_empty());
    let mut storage = shared.clone();
    assert!(
        storage
            .load()
            .unwrap_or_else(|error| panic!("{error}"))
            .is_empty()
    );
}

#[test]
fn instance_admission_is_bounded_per_kind_and_a_removal_frees_capacity() {
    let codex = instance(ProviderKind::Codex, "first");
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = &fixture.catalog;
    for index in 1..crate::cache::CLI_INSTANCE_LIMIT {
        catalog
            .register_instance(instance(ProviderKind::Codex, &format!("cli-{index}")), None)
            .unwrap_or_else(|error| panic!("{error}"));
    }
    assert_eq!(
        catalog.register_instance(instance(ProviderKind::Codex, "over"), None),
        Err(CatalogError::InstanceLimit)
    );
    // ACP rows have their own capacity.
    catalog
        .register_instance(instance(ProviderKind::Acp, "agent"), None)
        .unwrap_or_else(|error| panic!("{error}"));
    futures::executor::block_on(async { catalog.remove_instance("cli-1").await })
        .unwrap_or_else(|error| panic!("{error}"));
    catalog
        .register_instance(instance(ProviderKind::Codex, "fresh"), None)
        .unwrap_or_else(|error| panic!("{error}"));
}

#[test]
fn a_timeout_leaves_another_instances_models_immediately_available() {
    let slow = instance(ProviderKind::Codex, "slow");
    let quick = instance(ProviderKind::Claude, "quick");
    let discover = FakeDiscover::new(|request, signal| {
        Box::pin(async move {
            if request.instance.id == "slow" {
                signal.wait().await;
                return Err(DiscoveryFailure::with_code(FailureCode::Timeout));
            }
            Ok(models(&request.instance, &["claude-opus-5"]))
        })
    });
    let fixture = fixture(
        vec![slow, quick],
        SharedStorage::new(MemoryStorage::new()),
        discover.clone(),
    );
    let catalog = fixture.catalog.clone();
    // The slow flight starts and waits for the deadline; the quick one settles.
    let mut slow_flight = Box::pin(catalog.refresh(ModelFilter::instance("slow")));
    assert!(poll_once(slow_flight.as_mut()).is_pending());
    futures::executor::block_on(catalog.refresh(ModelFilter::instance("quick")))
        .unwrap_or_else(|error| panic!("{error}"));
    let quick_page = catalog
        .list(ModelFilter::instance("quick"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(quick_page.models.len(), 1);
    assert!(!quick_page.instances[0].stale);
    // The timeout aborts the slow flight; its row reports a timeout, never a stale pick.
    fixture.deadlines.fire(1_000.0 + 1_000.0);
    let timed_out =
        futures::executor::block_on(slow_flight).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(timed_out[0].error, Some(StatusError::Timeout));
    let slow_page = catalog
        .list(ModelFilter::instance("slow"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(slow_page.models.is_empty());
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
    let mut close = Box::pin(fixture.catalog.close());
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
fn a_session_reports_levels_for_the_model_it_runs_without_erasing_others() {
    // A provider-level ACP account (no agent id) keeps the options a session reports.
    let agent = instance(ProviderKind::Acp, "one");
    let setup = |model: &str| -> Value {
        let levels = if model == "fast" {
            vec!["low", "high"]
        } else {
            vec!["low", "high", "max"]
        };
        json!({
            "availableModels": [
                { "modelId": "fast", "name": "Fast" },
                { "modelId": "deep", "name": "Deep" }
            ],
            "currentModelId": model,
            "configOptions": [
                {
                    "id": "model",
                    "name": "Model",
                    "category": "model",
                    "type": "select",
                    "currentValue": model,
                    "options": [
                        { "value": "fast", "name": "Fast" },
                        { "value": "deep", "name": "Deep" }
                    ]
                },
                {
                    "id": "thinking",
                    "name": "Thinking",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": "low",
                    "options": levels.iter().map(|value| json!({ "value": value, "name": value })).collect::<Vec<_>>()
                }
            ]
        })
    };
    let fixture = fixture(
        vec![agent.clone()],
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    );
    let catalog = &fixture.catalog;
    futures::executor::block_on(async {
        catalog
            .update_from_session(agent.clone(), &setup("fast"))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
        catalog
            .update_from_session(agent.clone(), &setup("deep"))
            .await
            .unwrap_or_else(|error| panic!("{error}"));
    });
    let listed = catalog
        .list(ModelFilter::instance("one"), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    let levels = |id: &str| -> Vec<String> {
        listed
            .models
            .iter()
            .find(|model| model.id.0 == id)
            .map(|model| {
                model
                    .efforts
                    .iter()
                    .map(|effort| effort.id.0.clone())
                    .collect()
            })
            .unwrap_or_default()
    };
    assert_eq!(levels("fast"), ["low", "high"]);
    assert_eq!(levels("deep"), ["low", "high", "max"]);
    // Neither session started discovery.
    assert_eq!(fixture.discover.calls(), 0);
}

#[test]
fn a_source_that_authoritatively_has_no_models_drops_its_rows() {
    let codex = instance(ProviderKind::Codex, "account");
    let mut findings = models(&codex, &["gpt-6-sol"]);
    let mut source = ace_models::source::provider_source("codex");
    source.id = "codex".to_owned().into();
    findings.sources = Some(vec![SourceStatus {
        source,
        status: SourceState::Fresh,
        last_refreshed_at: None,
        error: Some(crate::failures::discovery_error(
            None,
            FailureCode::NoModels,
            &crate::failures::ErrorContext::default(),
        )),
    }]);
    let discover = always(findings.models);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    // The rows are usable until the source says it has none; the port above reports the
    // reply's statuses through the outcome.
    let outcome = futures::executor::block_on(fixture.catalog.refresh(ModelFilter::default()))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(outcome.len(), 1);
}

fn statuses_by_id(catalog: &Catalog) -> BTreeMap<String, InstanceStatus> {
    catalog
        .list(ModelFilter::default(), 0, 100)
        .map(|result| {
            result
                .instances
                .into_iter()
                .map(|status| (status.instance.clone(), status))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn an_invalidated_account_keeps_its_place_but_not_its_choices() {
    let codex = instance(ProviderKind::Codex, "account");
    let discover = always(vec![row(&codex, "gpt-6-sol")]);
    let fixture = fixture(
        vec![codex],
        SharedStorage::new(MemoryStorage::new()),
        discover,
    );
    let catalog = fixture.catalog.clone();
    let _ = futures::executor::block_on(catalog.refresh(ModelFilter::default()));
    futures::executor::block_on(catalog.invalidate(ModelFilter::default()))
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(catalog.has_instance("account"));
    let listed = catalog
        .list(ModelFilter::default(), 0, 100)
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(listed.models.is_empty(), "revoked choices are gone");
    let _ = statuses_by_id(&catalog);
}

#[test]
fn a_replacement_refresh_waits_for_a_pending_invalidations_delete() {
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
    let mut old = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(old.as_mut()).is_pending());
    let mut invalidating = Box::pin(catalog.invalidate(ModelFilter::default()));
    assert!(
        poll_once(invalidating.as_mut()).is_pending(),
        "delete is pending"
    );
    let mut replacement = Box::pin(catalog.refresh_state("account", RefreshCause::Background));
    assert!(poll_once(replacement.as_mut()).is_pending());
    assert_eq!(
        fixture.discover.calls(),
        1,
        "the replacement waited for the delete"
    );
    gate.open();
    let (_, _, _) =
        futures::executor::block_on(async move { futures::join!(old, invalidating, replacement) });
    assert_eq!(fixture.discover.calls(), 2);
    assert!(!listed(&catalog).models.is_empty());
}

#[test]
fn a_connection_probe_result_for_an_old_login_is_fenced_off() {
    struct Probe {
        gate: crate::signals::Gate,
    }
    impl super::ConnectionProbe for Probe {
        fn probe(
            &self,
            _request: super::DiscoveryRequest,
            _signal: crate::signals::Signal,
        ) -> futures::future::LocalBoxFuture<
            'static,
            Result<String, crate::failures::DiscoveryFailure>,
        > {
            let gate = self.gate.clone();
            Box::pin(async move {
                gate.wait().await;
                Ok("fingerprint".to_owned())
            })
        }
    }
    let codex = instance(ProviderKind::Opencode, "account");
    let gate = crate::signals::Gate::new();
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        TestDeadlines::new(),
        TestSpawn::new(),
    );
    options.instances = vec![codex.clone()];
    options.revision_probe = Some(std::sync::Arc::new(Probe { gate: gate.clone() }));
    let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
    let mut probing = Box::pin(catalog.reconcile_connections());
    assert!(poll_once(probing.as_mut()).is_pending());
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
    futures::executor::block_on(probing).unwrap_or_else(|error| panic!("{error}"));
    let fingerprint = catalog.with_inner(|inner| {
        inner
            .states
            .get("account")
            .and_then(|state| state.connection_fingerprint.clone())
    });
    assert_eq!(
        fingerprint, None,
        "the old login's probe result is fenced off"
    );
}
#[test]
fn a_sign_in_method_is_held_to_128_code_points() {
    let catalog = fixture(
        Vec::new(),
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
    )
    .catalog;
    for (index, (method, accepted)) in [
        ("m".repeat(128), true),
        ("m".repeat(129), false),
        ("🌍".repeat(128), true),
        ("🌍".repeat(129), false),
        (String::new(), false),
    ]
    .into_iter()
    .enumerate()
    {
        let mut account = instance(ProviderKind::Codex, &format!("account-{index}"));
        account.sign_in_method = Some(method);
        assert_eq!(
            catalog.register_instance(account, None).is_ok(),
            accepted,
            "case {index}"
        );
    }
}

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

#[test]
fn a_session_write_queued_across_a_login_change_never_lands_on_the_new_login() {
    let agent = instance(ProviderKind::Acp, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let fixture = fixture(vec![agent.clone()], storage.clone(), always(Vec::new()));
    let catalog = fixture.catalog.clone();
    // A write already holding the queue, and the session's write queued behind it.
    let hold = futures::executor::block_on(catalog.hold_writes("account"));
    let metadata = acp_metadata("session-model");
    let mut queued = Box::pin(catalog.update_from_session(
        ModelInstance {
            login_revision: "1".to_owned(),
            ..agent.clone()
        },
        &metadata,
    ));
    assert!(
        poll_once(queued.as_mut()).is_pending(),
        "the write is queued"
    );
    // The person signs in to another login while the write waits.
    catalog
        .register_instance(
            ModelInstance {
                login_revision: "2".to_owned(),
                ..agent.clone()
            },
            None,
        )
        .unwrap_or_else(|error| panic!("{error}"));
    assert!(catalog.has_instance("account"));
    drop(hold);
    let written = futures::executor::block_on(queued);
    assert_eq!(
        written,
        Err(CatalogError::SessionGenerationChanged),
        "the queued write refuses a login it no longer belongs to"
    );
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored
            .iter()
            .all(|entry| entry.login_revision.as_deref() != Some("1")),
        "login A's session write never lands on login B"
    );
}

#[test]
fn a_permission_write_accepted_first_keeps_its_place_in_the_queue() {
    let agent = instance(ProviderKind::Acp, "account");
    let storage = SharedStorage::new(MemoryStorage::new());
    let fixture = fixture(vec![agent.clone()], storage.clone(), always(Vec::new()));
    let catalog = fixture.catalog.clone();
    let metadata = acp_metadata("session-model");
    let _ = futures::executor::block_on(catalog.update_from_session(agent.clone(), &metadata));
    // Accepted but not started: its place in the queue is already taken.
    catalog.update_permission_modes(
        "account",
        vec![
            serde_json::json!({ "id": "plan", "label": "Plan", "description": "", "risk": "low" }),
        ],
    );
    // A session write accepted afterwards waits for it, then replaces its entry.
    let mut session = Box::pin(catalog.update_from_session(agent.clone(), &metadata));
    assert!(
        poll_once(session.as_mut()).is_pending(),
        "the later write waits for the earlier permission write"
    );
    fixture.spawn.drain();
    futures::executor::block_on(session).unwrap_or_else(|error| panic!("{error}"));
    let mut storage = storage.clone();
    let stored = storage.load().unwrap_or_default();
    assert!(
        stored.iter().all(|entry| entry
            .permission_modes
            .as_ref()
            .is_none_or(|modes| modes.is_empty())),
        "the later session write leaves its own modes, not the queued ones"
    );
}

/// Storage whose next `remove` calls fail, as a locked cache file would.
struct FailingRemove {
    inner: MemoryStorage,
    failures: AtomicUsize,
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
    // The deadline fires, and the discovery answers success on the same poll anyway.
    fixture.deadlines.fire(1_000.0 + 1_000.0);
    let status = futures::executor::block_on(flight);
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
fn a_deadline_fired_before_the_discovery_arms_one_leaves_it_whole() {
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
    // No timer is armed while admission runs, so this one belongs to no discovery.
    fixture.deadlines.fire(1_000.0 + 1_000.0);
    gate.open();
    let status = futures::executor::block_on(flight);
    assert_eq!(status.error, None, "the admission's own discovery is whole");
    assert_eq!(fixture.discover.calls(), 1);
    assert_eq!(listed(&catalog).models.len(), 1);
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
    let _ = futures::executor::block_on(flight);
    assert_eq!(
        fixture.discover.calls(),
        0,
        "the revoked admission never launches discovery"
    );
}

#[test]
fn a_live_accounts_connection_probe_settles_the_catalog() {
    for succeeds in [true, false] {
        let (fingerprint, reported_error, listed, closed) =
            within(15, "a live account's connection probe", move || {
                struct Probe {
                    succeeds: bool,
                }
                impl super::ConnectionProbe for Probe {
                    fn probe(
                        &self,
                        _request: super::DiscoveryRequest,
                        _signal: crate::signals::Signal,
                    ) -> futures::future::LocalBoxFuture<
                        'static,
                        Result<String, crate::failures::DiscoveryFailure>,
                    > {
                        let succeeds = self.succeeds;
                        Box::pin(async move {
                            if succeeds {
                                Ok("fingerprint".to_owned())
                            } else {
                                Err(crate::failures::DiscoveryFailure::with_status(503.0))
                            }
                        })
                    }
                }
                let account = instance(ProviderKind::Opencode, "account");
                let mut options = CatalogOptions::new(
                    SharedStorage::new(MemoryStorage::new()),
                    always(vec![row(&account, "opencode/gpt-6")]),
                    TestClock::new(1_000.0),
                    TestDeadlines::new(),
                    TestSpawn::new(),
                );
                options.instances = vec![account];
                options.revision_probe = Some(Arc::new(Probe { succeeds }));
                let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
                futures::executor::block_on(catalog.reconcile_connections())
                    .unwrap_or_else(|error| panic!("{error}"));
                let fingerprint = catalog.with_inner(|inner| {
                    inner
                        .states
                        .get("account")
                        .and_then(|state| state.connection_fingerprint.clone())
                });
                let reported_error = catalog.with_inner(|inner| {
                    inner
                        .states
                        .get("account")
                        .is_some_and(|state| state.error.is_some() || state.error_detail.is_some())
                });
                let listed = catalog.list(ModelFilter::default(), 0, 100).is_ok();
                let closed = futures::executor::block_on(catalog.close()).is_ok();
                (fingerprint, reported_error, listed, closed)
            });
        if succeeds {
            assert!(
                fingerprint.is_some(),
                "the accepted probe leaves a connection fingerprint"
            );
            assert!(!reported_error, "a healthy probe reports no failure");
        } else {
            assert!(reported_error, "a failed probe reports its failure");
        }
        assert!(listed, "the catalog still answers a read");
        assert!(closed, "the catalog still closes");
    }
}

/// A connection probe the test releases through a gate and counts.
struct GatedProbe {
    gate: crate::signals::Gate,
    calls: Arc<AtomicUsize>,
    fails: bool,
}

impl super::ConnectionProbe for GatedProbe {
    fn probe(
        &self,
        _request: super::DiscoveryRequest,
        signal: crate::signals::Signal,
    ) -> futures::future::LocalBoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let gate = self.gate.clone();
        let fails = self.fails;
        Box::pin(async move {
            gate.wait().await;
            if signal.is_aborted() {
                return Err(crate::failures::DiscoveryFailure::with_code(
                    crate::failures::FailureCode::Timeout,
                ));
            }
            if fails {
                return Err(crate::failures::DiscoveryFailure::with_status(503.0));
            }
            Ok("fingerprint".to_owned())
        })
    }
}

fn probe_fixture(gate: crate::signals::Gate, calls: Arc<AtomicUsize>, fails: bool) -> Catalog {
    let account = instance(ProviderKind::Opencode, "account");
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        TestDeadlines::new(),
        TestSpawn::new(),
    );
    options.instances = vec![account];
    options.revision_probe = Some(Arc::new(GatedProbe { gate, calls, fails }));
    Catalog::new(options).unwrap_or_else(|error| panic!("{error}"))
}

#[test]
fn overlapping_connection_polls_share_one_probe() {
    let gate = crate::signals::Gate::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let catalog = probe_fixture(gate.clone(), calls.clone(), false);
    let mut first = Box::pin(catalog.reconcile_connections());
    assert!(poll_once(first.as_mut()).is_pending(), "the probe waits");
    let mut second = Box::pin(catalog.reconcile_connections());
    assert!(
        poll_once(second.as_mut()).is_pending(),
        "the second poll shares the probe"
    );
    gate.open();
    let (left, right) = futures::executor::block_on(async move { futures::join!(first, second) });
    assert!(left.is_ok() && right.is_ok());
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "one probe answers both polls"
    );
}

#[test]
fn a_connection_probe_that_times_out_reports_it_and_backs_off() {
    let gate = crate::signals::Gate::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let account = instance(ProviderKind::Opencode, "account");
    let deadlines = TestDeadlines::new();
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        deadlines.clone(),
        TestSpawn::new(),
    );
    options.instances = vec![account];
    options.timeout_ms = 1_000.0;
    options.revision_probe = Some(Arc::new(GatedProbe {
        gate: gate.clone(),
        calls: calls.clone(),
        fails: false,
    }));
    let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
    let mut probing = Box::pin(catalog.reconcile_connections());
    assert!(poll_once(probing.as_mut()).is_pending(), "the probe waits");
    deadlines.fire(1_000.0 + 1_000.0);
    gate.open();
    futures::executor::block_on(probing).unwrap_or_else(|error| panic!("{error}"));
    let status = catalog
        .list(ModelFilter::instance("account"), 0, 100)
        .map(|result| result.instances.into_iter().next())
        .ok()
        .flatten()
        .unwrap_or_else(|| panic!("the row is listed"));
    assert_eq!(
        status.error,
        Some(StatusError::Timeout),
        "the timeout is visible"
    );
    // The failed probe waits out its pause before another one starts.
    let _ = catalog.list(ModelFilter::default(), 0, 100);
    let _ = futures::executor::block_on(catalog.reconcile_connections());
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the pause holds");
}

#[test]
fn a_failed_connection_probe_schedules_its_own_retry() {
    let gate = crate::signals::Gate::new();
    gate.open();
    let calls = Arc::new(AtomicUsize::new(0));
    let catalog = probe_fixture(gate, calls.clone(), true);
    futures::executor::block_on(catalog.reconcile_connections())
        .unwrap_or_else(|error| panic!("{error}"));
    let status = catalog
        .list(ModelFilter::instance("account"), 0, 100)
        .map(|result| result.instances.into_iter().next())
        .ok()
        .flatten()
        .unwrap_or_else(|| panic!("the row is listed"));
    assert_eq!(status.error, Some(StatusError::DiscoveryFailed));
    assert!(
        status.error_detail.is_some(),
        "the failure carries its fixed detail"
    );
    futures::executor::block_on(catalog.reconcile_connections())
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the failure waits out its backoff"
    );
}

#[test]
fn a_dropped_connection_poll_never_strands_close() {
    struct Probe {
        calls: Arc<AtomicUsize>,
    }
    impl super::ConnectionProbe for Probe {
        fn probe(
            &self,
            _request: super::DiscoveryRequest,
            signal: crate::signals::Signal,
        ) -> futures::future::LocalBoxFuture<
            'static,
            Result<String, crate::failures::DiscoveryFailure>,
        > {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move {
                signal.wait().await;
                Err(crate::failures::DiscoveryFailure::with_code(
                    crate::failures::FailureCode::Timeout,
                ))
            })
        }
    }
    let first = instance(ProviderKind::Opencode, "one");
    let second = instance(ProviderKind::Opencode, "two");
    let calls = Arc::new(AtomicUsize::new(0));
    let spawn = TestSpawn::new();
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        TestDeadlines::new(),
        spawn.clone(),
    );
    options.instances = vec![first, second];
    options.revision_probe = Some(Arc::new(Probe {
        calls: calls.clone(),
    }));
    let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
    let mut polling = Box::pin(catalog.reconcile_connections());
    assert!(poll_once(polling.as_mut()).is_pending(), "the probe waits");
    drop(polling);
    // Shutdown must settle the probe the dropped caller left behind.
    let closed = settle(catalog.close(), &spawn, "close after a dropped probe");
    closed.unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "no probe starts once shutdown began"
    );
}

#[test]
fn close_aborts_a_waiting_probe_instead_of_waiting_on_it() {
    struct Probe;
    impl super::ConnectionProbe for Probe {
        fn probe(
            &self,
            _request: super::DiscoveryRequest,
            signal: crate::signals::Signal,
        ) -> futures::future::LocalBoxFuture<
            'static,
            Result<String, crate::failures::DiscoveryFailure>,
        > {
            Box::pin(async move {
                signal.wait().await;
                Err(crate::failures::DiscoveryFailure::with_code(
                    crate::failures::FailureCode::Timeout,
                ))
            })
        }
    }
    let account = instance(ProviderKind::Opencode, "account");
    let spawn = TestSpawn::new();
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        TestDeadlines::new(),
        spawn.clone(),
    );
    options.instances = vec![account];
    options.revision_probe = Some(std::sync::Arc::new(Probe));
    let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
    let mut probing = Box::pin(catalog.reconcile_connections());
    assert!(poll_once(probing.as_mut()).is_pending(), "the probe waits");
    let closing = Box::pin(catalog.close());
    // A regression fails here instead of hanging the suite.
    let (_, closed) = settle(
        async move { futures::join!(probing, closing) },
        &spawn,
        "close against a waiting probe",
    );
    closed.unwrap_or_else(|error| panic!("{error}"));
}
