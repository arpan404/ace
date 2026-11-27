// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::cache::{CacheError, CatalogStorage};
use std::sync::mpsc;
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
    Delete,
    Replace,
}

struct Pause {
    operation: Operation,
    entered: mpsc::Sender<()>,
    resume: mpsc::Receiver<Result<(), CacheError>>,
}

#[derive(Default)]
struct ControlledStorage {
    inner: MemoryStorage,
    pause: Arc<Mutex<Option<Pause>>>,
    deletes: Arc<AtomicUsize>,
}

impl ControlledStorage {
    fn pause_next(
        &self,
        operation: Operation,
    ) -> (mpsc::Receiver<()>, mpsc::Sender<Result<(), CacheError>>) {
        let (entered, observed) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        *self.pause.lock().unwrap() = Some(Pause {
            operation,
            entered,
            resume,
        });
        (observed, release)
    }

    fn await_release(&self, operation: Operation) -> Result<(), CacheError> {
        let pause = {
            let mut next = self.pause.lock().unwrap();
            if next
                .as_ref()
                .is_some_and(|pause| pause.operation == operation)
            {
                next.take()
            } else {
                None
            }
        };
        if let Some(pause) = pause {
            pause.entered.send(()).unwrap();
            pause.resume.recv_timeout(Duration::from_secs(5)).unwrap()?;
        }
        Ok(())
    }

    fn shared(&self) -> SharedStorage {
        SharedStorage::new(Self {
            inner: MemoryStorage::new(),
            pause: self.pause.clone(),
            deletes: self.deletes.clone(),
        })
    }
}

impl CatalogStorage for ControlledStorage {
    fn load(&self) -> Result<Vec<CacheEntry>, CacheError> {
        self.inner.load()
    }

    fn replace_if_current(
        &self,
        entry: &CacheEntry,
        current: &dyn Fn() -> bool,
    ) -> Result<bool, CacheError> {
        self.await_release(Operation::Replace)?;
        self.inner.replace_if_current(entry, current)
    }

    fn remove(&self, id: &str) -> Result<(), CacheError> {
        self.deletes.fetch_add(1, Ordering::SeqCst);
        self.await_release(Operation::Delete)?;
        self.inner.remove(id)
    }
}

fn observe_entry(spawn: &TestSpawn, observed: mpsc::Receiver<()>) {
    for _ in 0..50 {
        spawn.drain();
        match observed.try_recv() {
            Ok(()) => return,
            Err(mpsc::TryRecvError::Empty) => {}
            Err(error) => panic!("storage did not start: {error}"),
        }
    }
    panic!("storage did not start");
}

fn login(mut account: ModelInstance, revision: &str) -> ModelInstance {
    account.login_revision = revision.to_owned();
    account
}

fn discovery() -> Arc<FakeDiscover> {
    FakeDiscover::new(|request, _| {
        Box::pin(async move { Ok(models(&request.instance, &["model"])) })
    })
}

fn fail_login_deletion(fixture: &Fixture, control: &ControlledStorage, replacement: ModelInstance) {
    let (started, release) = control.pause_next(Operation::Delete);
    fixture
        .catalog
        .register_instance(replacement, None)
        .unwrap();
    observe_entry(&fixture.spawn, started);
    release.send(Err(CacheError::Malformed)).unwrap();
    settle(
        fixture.catalog.quiesce(),
        &fixture.spawn,
        "failed account deletion",
    );
}

#[test]
fn a_discovery_waiting_on_a_delete_cannot_restore_a_replaced_login() {
    within(5, "replaced login during prerequisite deletion", || {
        let control = ControlledStorage::default();
        let storage = control.shared();
        let account = instance(ProviderKind::Codex, "account");
        let fixture = fixture(vec![account.clone()], storage.clone(), discovery());
        let catalog = &fixture.catalog;
        settle(catalog.load("account"), &fixture.spawn, "first login").unwrap();
        fail_login_deletion(&fixture, &control, login(account.clone(), "second"));

        let (started, release) = control.pause_next(Operation::Delete);
        let mut refresh = Box::pin(catalog.load("account"));
        assert!(poll_once(refresh.as_mut()).is_pending());
        observe_entry(&fixture.spawn, started);
        catalog
            .register_instance(login(account, "third"), None)
            .unwrap();
        release.send(Ok(())).unwrap();
        settle(refresh, &fixture.spawn, "superseded discovery").unwrap();
        settle(catalog.quiesce(), &fixture.spawn, "durable settlements");
        assert!(storage.load().unwrap().is_empty());
    });
}

#[test]
fn a_failed_session_prerequisite_releases_the_turn_for_retry_and_removal() {
    within(5, "session prerequisite failure", || {
        let control = ControlledStorage::default();
        let storage = control.shared();
        let account = instance(ProviderKind::Acp, "account");
        let replacement = login(account.clone(), "second");
        let fixture = fixture(vec![account.clone()], storage, discovery());
        let catalog = &fixture.catalog;
        let metadata = super::writes::acp_metadata("session-model");
        settle(
            catalog.update_from_session(account, token(catalog, "account"), &metadata),
            &fixture.spawn,
            "first session",
        )
        .unwrap();
        fail_login_deletion(&fixture, &control, replacement.clone());

        let (started, release) = control.pause_next(Operation::Delete);
        let registration = token(catalog, "account");
        let mut write =
            Box::pin(catalog.update_from_session(replacement.clone(), registration, &metadata));
        assert!(poll_once(write.as_mut()).is_pending());
        observe_entry(&fixture.spawn, started);
        release.send(Err(CacheError::Malformed)).unwrap();
        assert_eq!(
            settle(write, &fixture.spawn, "failed session metadata"),
            Err(CatalogError::SessionGenerationChanged)
        );
        settle(
            catalog.update_from_session(replacement, registration, &metadata),
            &fixture.spawn,
            "retry session metadata",
        )
        .unwrap();
        settle(
            catalog.remove_instance("account"),
            &fixture.spawn,
            "remove account",
        )
        .unwrap();
    });
}

#[test]
fn a_session_staging_a_replace_loses_its_write_on_a_binary_setting_change() {
    within(5, "session revision during storage I/O", || {
        let control = ControlledStorage::default();
        let storage = control.shared();
        let account = instance(ProviderKind::Acp, "account");
        let spawn = TestSpawn::new();
        let path = Arc::new(AtomicBool::new(false));
        let mut options = CatalogOptions::new(
            storage.clone(),
            discovery(),
            TestClock::new(1_000.0),
            TestDeadlines::new(),
            spawn.clone(),
        );
        options.instances = vec![account.clone()];
        options.preferences = Some(Arc::new({
            let path = path.clone();
            move || {
                vec![crate::preferences::ProviderConfig {
                    binary_path: path
                        .load(Ordering::SeqCst)
                        .then(|| "/replacement".to_owned()),
                    ..crate::preferences::ProviderConfig::new(ProviderKind::Acp)
                }]
            }
        }));
        let catalog = Catalog::new(options).unwrap();
        let (started, release) = control.pause_next(Operation::Replace);
        let metadata = super::writes::acp_metadata("session-model");
        let mut write =
            Box::pin(catalog.update_from_session(account, token(&catalog, "account"), &metadata));
        assert!(poll_once(write.as_mut()).is_pending());
        observe_entry(&spawn, started);
        path.store(true, Ordering::SeqCst);
        catalog.configuration_changed();
        release.send(Ok(())).unwrap();
        assert_eq!(
            settle(write, &spawn, "fenced session"),
            Err(CatalogError::SessionGenerationChanged)
        );
        assert!(storage.load().unwrap().is_empty());
    });
}

#[test]
fn a_permission_replace_cannot_publish_modes_to_a_compatible_reregistration() {
    within(5, "permission write during re-registration", || {
        let control = ControlledStorage::default();
        let storage = control.shared();
        let account = instance(ProviderKind::Codex, "account");
        let fixture = fixture(vec![account.clone()], storage.clone(), discovery());
        let catalog = &fixture.catalog;
        settle(catalog.load("account"), &fixture.spawn, "initial cache").unwrap();
        let (started, release) = control.pause_next(Operation::Replace);
        catalog.update_permission_modes(
            "account",
            token(catalog, "account"),
            vec![json!({ "id": "plan", "label": "Plan", "description": "", "risk": "low" })],
        );
        observe_entry(&fixture.spawn, started);
        catalog.register_instance(account, None).unwrap();
        release.send(Ok(())).unwrap();
        settle(
            catalog.quiesce(),
            &fixture.spawn,
            "obsolete permission write",
        );
        assert!(listed(catalog).instances[0].permission_modes.is_none());
        assert!(storage.load().unwrap()[0].permission_modes.is_none());
    });
}

#[test]
fn repeated_guard_rejections_share_the_running_delete() {
    within(5, "coalesced guard deletion", || {
        let control = ControlledStorage::default();
        let account = instance(ProviderKind::Codex, "account");
        let fixture = fixture(vec![account.clone()], control.shared(), discovery());
        let catalog = &fixture.catalog;
        settle(catalog.load("account"), &fixture.spawn, "initial cache").unwrap();
        catalog
            .register_instance(
                account,
                Some(Arc::new(|| {
                    Box::pin(async { Err("home marker changed".to_owned()) })
                })),
            )
            .unwrap();
        let (started, release) = control.pause_next(Operation::Delete);
        settle(catalog.load("account"), &fixture.spawn, "first rejection").unwrap();
        observe_entry(&fixture.spawn, started);
        for _ in 0..8 {
            settle(
                catalog.load("account"),
                &fixture.spawn,
                "repeated rejection",
            )
            .unwrap();
        }
        release.send(Ok(())).unwrap();
        settle(catalog.quiesce(), &fixture.spawn, "flush deletes");
        assert_eq!(control.deletes.load(Ordering::SeqCst), 1);
    });
}

#[test]
fn a_timed_out_refresh_returns_while_its_storage_call_is_still_blocked() {
    within(5, "deadline during replace", || {
        let control = ControlledStorage::default();
        let storage = control.shared();
        let account = instance(ProviderKind::Codex, "account");
        let fixture = fixture(vec![account], storage.clone(), discovery());
        let catalog = &fixture.catalog;
        let (started, release) = control.pause_next(Operation::Replace);
        let mut refresh = Box::pin(catalog.load("account"));
        assert!(poll_once(refresh.as_mut()).is_pending());
        observe_entry(&fixture.spawn, started);
        fixture.deadlines.fire(1_000.0);
        let statuses = settle(refresh, &fixture.spawn, "timed out refresh").unwrap();
        assert_eq!(statuses[0].error, Some(StatusError::Timeout));
        release.send(Ok(())).unwrap();
        settle(catalog.quiesce(), &fixture.spawn, "cancelled storage call");
        assert!(storage.load().unwrap().is_empty());
    });
}

#[test]
fn a_hung_home_guard_leaves_the_discovery_slot_available() {
    within(5, "independent admission and discovery", || {
        let stalled = instance(ProviderKind::Codex, "stalled");
        let ready = instance(ProviderKind::Codex, "ready");
        let fixture = fixture_with_concurrency(
            vec![ready],
            SharedStorage::new(MemoryStorage::new()),
            discovery(),
            1,
        );
        let catalog = &fixture.catalog;
        catalog
            .register_instance(stalled, Some(Arc::new(|| Box::pin(std::future::pending()))))
            .unwrap();
        let mut stalled = Box::pin(catalog.load("stalled"));
        assert!(poll_once(stalled.as_mut()).is_pending());
        fixture.spawn.drain();
        let ready = settle(
            catalog.load("ready"),
            &fixture.spawn,
            "discovery while guard waits",
        )
        .unwrap();
        assert_eq!(ready[0].error, None);
        assert!(poll_once(stalled.as_mut()).is_pending());
        fixture.deadlines.fire(1_000.0);
        settle(stalled, &fixture.spawn, "guard timed out").unwrap();
    });
}

#[test]
fn a_stalled_removal_and_close_refuse_excess_waiters() {
    within(8, "bounded removal and close waiters", || {
        let control = ControlledStorage::default();
        let account = instance(ProviderKind::Codex, "account");
        let fixture = fixture(vec![account], control.shared(), discovery());
        let catalog = &fixture.catalog;
        let (started, release) = control.pause_next(Operation::Delete);
        let mut first = Box::pin(catalog.remove_instance("account"));
        assert!(poll_once(first.as_mut()).is_pending());
        observe_entry(&fixture.spawn, started);
        let mut removals = Vec::new();
        for _ in 1..crate::catalog::WAITER_LIMIT {
            let mut remove = Box::pin(catalog.remove_instance("account"));
            assert!(poll_once(remove.as_mut()).is_pending());
            removals.push(remove);
        }
        let mut excess = Box::pin(catalog.remove_instance("account"));
        assert_eq!(
            poll_once(excess.as_mut()),
            std::task::Poll::Ready(Err(CatalogError::Busy))
        );

        let mut closes = Vec::new();
        for _ in 0..crate::catalog::WAITER_LIMIT {
            let mut close = Box::pin(catalog.close());
            assert!(poll_once(close.as_mut()).is_pending());
            closes.push(close);
        }
        let mut excess = Box::pin(catalog.close());
        assert_eq!(
            poll_once(excess.as_mut()),
            std::task::Poll::Ready(Err(CatalogError::Busy))
        );
        release.send(Ok(())).unwrap();
        settle(first, &fixture.spawn, "removal").unwrap();
        assert!(
            settle(
                futures::future::join_all(removals),
                &fixture.spawn,
                "removal waiters"
            )
            .into_iter()
            .all(|result| result.is_ok())
        );
        assert!(
            settle(
                futures::future::join_all(closes),
                &fixture.spawn,
                "close waiters"
            )
            .into_iter()
            .all(|result| result.is_ok())
        );
    });
}
