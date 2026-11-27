// SPDX-License-Identifier: Apache-2.0
//! The connection metadata probe: one probe per row, shared by overlapping polls, its
//! deadline, its failures and the shutdown that settles it.

use super::*;

struct GatedProbe {
    gate: crate::signals::Gate,
    calls: Arc<AtomicUsize>,
    fails: bool,
}

impl crate::catalog::ConnectionProbe for GatedProbe {
    fn probe(
        &self,
        _request: crate::catalog::DiscoveryRequest,
        signal: crate::signals::Signal,
    ) -> futures::future::BoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
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

pub(super) fn probe_fixture(
    gate: crate::signals::Gate,
    calls: Arc<AtomicUsize>,
    fails: bool,
) -> (Catalog, Arc<TestSpawn>) {
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
    options.revision_probe = Some(Arc::new(GatedProbe { gate, calls, fails }));
    (
        Catalog::new(options).unwrap_or_else(|error| panic!("{error}")),
        spawn,
    )
}

#[test]
fn a_live_accounts_connection_probe_settles_the_catalog() {
    for succeeds in [true, false] {
        let (fingerprint, reported_error, listed, closed) =
            within(15, "a live account's connection probe", move || {
                struct Probe {
                    succeeds: bool,
                }
                impl crate::catalog::ConnectionProbe for Probe {
                    fn probe(
                        &self,
                        _request: crate::catalog::DiscoveryRequest,
                        _signal: crate::signals::Signal,
                    ) -> futures::future::BoxFuture<
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
                let spawn = TestSpawn::new();
                let mut options = CatalogOptions::new(
                    SharedStorage::new(MemoryStorage::new()),
                    always(vec![row(&account, "opencode/gpt-6")]),
                    TestClock::new(1_000.0),
                    TestDeadlines::new(),
                    spawn.clone(),
                );
                options.instances = vec![account];
                options.revision_probe = Some(Arc::new(Probe { succeeds }));
                let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
                settle(
                    catalog.reconcile_connections(),
                    &spawn,
                    "the connection probe",
                )
                .unwrap_or_else(|error| panic!("{error}"));
                let (fingerprint, reported_error) = catalog.inspect_row("account");
                let listed = catalog.list(ModelFilter::default(), 0, 100).is_ok();
                let closed = settle(catalog.close(), &spawn, "the close").is_ok();
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

#[test]
fn a_dropped_connection_poll_never_strands_close() {
    struct Probe {
        calls: Arc<AtomicUsize>,
    }
    impl crate::catalog::ConnectionProbe for Probe {
        fn probe(
            &self,
            _request: crate::catalog::DiscoveryRequest,
            signal: crate::signals::Signal,
        ) -> futures::future::BoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
        {
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
    spawn.drain();
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
    impl crate::catalog::ConnectionProbe for Probe {
        fn probe(
            &self,
            _request: crate::catalog::DiscoveryRequest,
            signal: crate::signals::Signal,
        ) -> futures::future::BoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
        {
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

#[test]
fn a_connection_probe_result_for_an_old_login_is_fenced_off() {
    struct Probe {
        gate: crate::signals::Gate,
    }
    impl crate::catalog::ConnectionProbe for Probe {
        fn probe(
            &self,
            _request: crate::catalog::DiscoveryRequest,
            _signal: crate::signals::Signal,
        ) -> futures::future::BoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
        {
            let gate = self.gate.clone();
            Box::pin(async move {
                gate.wait().await;
                Ok("fingerprint".to_owned())
            })
        }
    }
    let codex = instance(ProviderKind::Opencode, "account");
    let gate = crate::signals::Gate::new();
    let spawn = TestSpawn::new();
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        TestDeadlines::new(),
        spawn.clone(),
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
    settle(probing, &spawn, "the probe").unwrap_or_else(|error| panic!("{error}"));
    let fingerprint = catalog.inspect_row("account").0;
    assert_eq!(
        fingerprint, None,
        "the old login's probe result is fenced off"
    );
}

#[test]
fn overlapping_connection_polls_share_one_probe() {
    let gate = crate::signals::Gate::new();
    let calls = Arc::new(AtomicUsize::new(0));
    let (catalog, spawn) = probe_fixture(gate.clone(), calls.clone(), false);
    let mut first = Box::pin(catalog.reconcile_connections());
    assert!(poll_once(first.as_mut()).is_pending(), "the probe waits");
    let mut second = Box::pin(catalog.reconcile_connections());
    assert!(
        poll_once(second.as_mut()).is_pending(),
        "the second poll shares the probe"
    );
    gate.open();
    let (left, right) = settle(
        async move { futures::join!(first, second) },
        &spawn,
        "two polls",
    );
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
    let spawn = TestSpawn::new();
    let mut options = CatalogOptions::new(
        SharedStorage::new(MemoryStorage::new()),
        always(Vec::new()),
        TestClock::new(1_000.0),
        deadlines.clone(),
        spawn.clone(),
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
    spawn.drain();
    deadlines.fire(1_000.0 + 1_000.0);
    gate.open();
    settle(probing, &spawn, "the probe").unwrap_or_else(|error| panic!("{error}"));
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
    let _ = settle(catalog.reconcile_connections(), &spawn, "the second poll");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "the pause holds");
}

#[test]
fn a_failed_connection_probe_schedules_its_own_retry() {
    let gate = crate::signals::Gate::new();
    gate.open();
    let calls = Arc::new(AtomicUsize::new(0));
    let (catalog, spawn) = probe_fixture(gate, calls.clone(), true);
    settle(catalog.reconcile_connections(), &spawn, "the probe")
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
    settle(catalog.reconcile_connections(), &spawn, "the probe")
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the failure waits out its backoff"
    );
}

/// A probe that records which account it was asked for and waits on a gate.
struct RecordingProbe {
    gate: crate::signals::Gate,
    calls: Arc<Mutex<Vec<String>>>,
}

impl crate::catalog::ConnectionProbe for RecordingProbe {
    fn probe(
        &self,
        request: crate::catalog::DiscoveryRequest,
        signal: crate::signals::Signal,
    ) -> futures::future::BoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
    {
        self.calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(request.instance.id.clone());
        let gate = self.gate.clone();
        Box::pin(async move {
            gate.wait().await;
            if signal.is_aborted() {
                return Err(crate::failures::DiscoveryFailure::with_code(
                    crate::failures::FailureCode::Timeout,
                ));
            }
            Ok("fingerprint".to_owned())
        })
    }
}

#[test]
fn a_reconciliation_loop_that_outlives_close_never_starts_another_account() {
    within(15, "a reconciliation loop across close", || {
        let gate = crate::signals::Gate::new();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let spawn = TestSpawn::new();
        let mut options = CatalogOptions::new(
            SharedStorage::new(MemoryStorage::new()),
            always(Vec::new()),
            TestClock::new(1_000.0),
            TestDeadlines::new(),
            spawn.clone(),
        );
        options.instances = vec![
            instance(ProviderKind::Opencode, "one"),
            instance(ProviderKind::Opencode, "two"),
        ];
        options.revision_probe = Some(Arc::new(RecordingProbe {
            gate: gate.clone(),
            calls: calls.clone(),
        }));
        let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
        let mut reconciling = Box::pin(catalog.reconcile_connections());
        assert!(
            poll_once(reconciling.as_mut()).is_pending(),
            "the first account's probe runs"
        );
        spawn.drain();
        assert_eq!(
            calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_slice(),
            ["one"]
        );
        // Close aborts the running probe; the loop carries on to the next account.
        let mut close = Box::pin(catalog.close());
        assert!(
            poll_once(close.as_mut()).is_pending(),
            "close waits for the probe it aborted"
        );
        gate.open();
        let (reconciled, closed) = settle(
            async move { futures::join!(reconciling, close) },
            &spawn,
            "a reconciliation loop and close",
        );
        reconciled.unwrap_or_else(|error| panic!("{error}"));
        closed.unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            calls
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_slice(),
            ["one"],
            "account two's probe never starts after shutdown"
        );
    })
}

/// A probe that hangs until its own token aborts it.
struct HungProbe {
    calls: Arc<AtomicUsize>,
}

impl crate::catalog::ConnectionProbe for HungProbe {
    fn probe(
        &self,
        _request: crate::catalog::DiscoveryRequest,
        signal: crate::signals::Signal,
    ) -> futures::future::BoxFuture<'static, Result<String, crate::failures::DiscoveryFailure>>
    {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            signal.wait().await;
            Ok("fingerprint".to_owned())
        })
    }
}

#[test]
fn a_hung_probe_is_aborted_by_each_replacement_so_polling_never_stops() {
    within(20, "sixty-five hung probes", || {
        let account = instance(ProviderKind::Opencode, "row");
        let calls = Arc::new(AtomicUsize::new(0));
        let spawn = TestSpawn::new();
        let deadlines = TestDeadlines::new();
        let mut options = CatalogOptions::new(
            SharedStorage::new(MemoryStorage::new()),
            always(Vec::new()),
            TestClock::new(1_000.0),
            deadlines.clone(),
            spawn.clone(),
        );
        options.instances = vec![account.clone()];
        options.revision_probe = Some(Arc::new(HungProbe {
            calls: calls.clone(),
        }));
        let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
        let mut started = 0;
        for generation in 0..65 {
            catalog
                .register_instance(
                    ModelInstance {
                        login_revision: format!("{generation}"),
                        ..account.clone()
                    },
                    None,
                )
                .unwrap_or_else(|error| panic!("{error}"));
            let mut polling = Box::pin(catalog.reconcile_connections());
            assert!(
                poll_once(polling.as_mut()).is_pending(),
                "probe {generation} hangs"
            );
            spawn.drain();
            started += 1;
            drop(polling);
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            started,
            "every registration's probe started"
        );
        // The last replacement aborts the live probe; capacity was not exhausted by the
        // sixty-five it replaced, so a later poll still starts one.
        catalog
            .register_instance(
                ModelInstance {
                    login_revision: "65".to_owned(),
                    ..account.clone()
                },
                None,
            )
            .unwrap_or_else(|error| panic!("{error}"));
        spawn.drain();
        let mut polling = Box::pin(catalog.reconcile_connections());
        assert!(
            poll_once(polling.as_mut()).is_pending(),
            "the last probe hangs"
        );
        spawn.drain();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            66,
            "a later poll still starts a probe after 65 replacements"
        );
        // Only the live probe keeps its timer; every replaced probe freed its own.
        assert_eq!(
            deadlines
                .timers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            1,
            "aborted probes released their deadlines"
        );
        drop(polling);
        settle(catalog.close(), &spawn, "the close").unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            deadlines
                .timers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len(),
            0,
            "close released the live probe's deadline"
        );
    })
}
