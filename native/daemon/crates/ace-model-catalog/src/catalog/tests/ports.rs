// SPDX-License-Identifier: Apache-2.0
use super::*;

struct ReentrantPorts {
    catalog: Mutex<Option<Catalog>>,
    spawn: Arc<TestSpawn>,
    deadlines: Arc<TestDeadlines>,
    visits: AtomicUsize,
}

impl ReentrantPorts {
    fn visit(&self) {
        let catalog = self
            .catalog
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if let Some(catalog) = catalog {
            assert!(catalog.has_instance("account"));
            self.visits.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl Clock for ReentrantPorts {
    fn now(&self) -> f64 {
        self.visit();
        1_000.0
    }
}

impl Spawn for ReentrantPorts {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.visit();
        self.spawn.spawn(task);
    }
}

impl Deadlines for ReentrantPorts {
    fn arm(&self, after_ms: f64, expire: Box<dyn Fn() + Send + Sync>) -> super::super::Cancel {
        self.visit();
        self.deadlines.arm(after_ms, expire)
    }
}

#[test]
fn time_settings_timer_and_spawner_ports_can_query_the_catalog() {
    within(5, "reentrant catalog ports", || {
        let account = instance(ProviderKind::Codex, "account");
        let ports = Arc::new(ReentrantPorts {
            catalog: Mutex::new(None),
            spawn: TestSpawn::new(),
            deadlines: TestDeadlines::new(),
            visits: AtomicUsize::new(0),
        });
        let mut options = CatalogOptions::new(
            SharedStorage::new(MemoryStorage::new()),
            always(vec![row(&account, "model")]),
            ports.clone(),
            ports.clone(),
            ports.clone(),
        );
        options.instances = vec![account];
        options.preferences = Some(Arc::new({
            let ports = ports.clone();
            move || {
                ports.visit();
                Vec::new()
            }
        }));
        let catalog = Catalog::new(options).unwrap_or_else(|error| panic!("{error}"));
        *ports
            .catalog
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(catalog.clone());
        settle(
            catalog.load("account"),
            &ports.spawn,
            "load with reentrant ports",
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(listed(&catalog).models.len(), 1);
        assert!(ports.visits.load(Ordering::SeqCst) >= 4);
        ports
            .catalog
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .take();
        settle(catalog.close(), &ports.spawn, "close").unwrap_or_else(|error| panic!("{error}"));
    });
}

#[test]
fn replacing_probes_does_not_release_their_slots_before_tasks_exit() {
    within(5, "probe task capacity", || {
        let account = instance(ProviderKind::Opencode, "account");
        let probe = Arc::new(AtomicUsize::new(0));
        let (catalog, spawn) =
            super::probes::probe_fixture(crate::signals::Gate::new(), probe.clone(), false);
        let mut outstanding = Vec::new();
        for _ in 0..64 {
            let mut poll = Box::pin(catalog.reconcile_connections());
            assert!(poll_once(poll.as_mut()).is_pending());
            outstanding.push(poll);
            catalog
                .register_instance(account.clone(), None)
                .unwrap_or_else(|error| panic!("{error}"));
        }
        let mut excess = Box::pin(catalog.reconcile_connections());
        assert_eq!(
            poll_once(excess.as_mut()),
            std::task::Poll::Ready(Err(CatalogError::Busy))
        );
        spawn.drain();
        assert_eq!(
            probe.load(Ordering::SeqCst),
            0,
            "superseded probes never ran"
        );
        settle(catalog.close(), &spawn, "close").unwrap_or_else(|error| panic!("{error}"));
    });
}

struct ClosingSpawner {
    catalog: Mutex<Option<Catalog>>,
    close: std::sync::mpsc::Sender<Result<(), CatalogError>>,
}

impl Spawn for ClosingSpawner {
    fn spawn(&self, _: BoxFuture<'static, ()>) {
        let catalog = self.catalog.lock().unwrap().clone().unwrap();
        let _ = self
            .close
            .send(futures::executor::block_on(catalog.close()));
    }
}

#[test]
fn a_spawner_can_close_before_submitting_its_task() {
    within(5, "close from the spawner", || {
        let account = instance(ProviderKind::Codex, "account");
        let (close, closed) = std::sync::mpsc::channel();
        let spawn = Arc::new(ClosingSpawner {
            catalog: Mutex::new(None),
            close,
        });
        let discover = always(vec![row(&account, "model")]);
        let mut options = CatalogOptions::new(
            SharedStorage::new(MemoryStorage::new()),
            discover.clone(),
            TestClock::new(0.0),
            TestDeadlines::new(),
            spawn.clone(),
        );
        options.instances = vec![account];
        let catalog = Catalog::new(options).unwrap();
        *spawn.catalog.lock().unwrap() = Some(catalog.clone());
        let _ = futures::executor::block_on(catalog.load("account"));
        assert_eq!(closed.recv().unwrap(), Ok(()));
        assert_eq!(discover.calls(), 0);
        spawn.catalog.lock().unwrap().take();
    });
}

#[test]
fn close_does_not_wait_for_admission_code_before_provider_io() {
    within(5, "close during an admission callback", || {
        let fixture = fixture(
            vec![],
            SharedStorage::new(MemoryStorage::new()),
            always(vec![]),
        );
        let (entered, observed) = std::sync::mpsc::channel();
        let (release, resume) = std::sync::mpsc::channel();
        let resume = Mutex::new(resume);
        let admit: super::super::Admit = Arc::new(move || {
            entered.send(()).unwrap();
            resume.lock().unwrap().recv().unwrap();
            Box::pin(async { Ok(()) })
        });
        let catalog = fixture.catalog;
        catalog
            .register_instance(instance(ProviderKind::Codex, "account"), Some(admit))
            .unwrap();
        let mut refresh = Box::pin(catalog.load("account"));
        assert!(poll_once(refresh.as_mut()).is_pending());
        let spawn = fixture.spawn.clone();
        std::thread::spawn(move || spawn.drain());
        observed.recv().unwrap();

        assert_eq!(futures::executor::block_on(catalog.close()), Ok(()));
        release.send(()).unwrap();
        assert!(futures::executor::block_on(refresh).is_ok());
        assert_eq!(fixture.discover.calls(), 0);
    });
}
