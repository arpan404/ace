//! Ports `packages/settings/src/service.test.ts`'s read/write cases and
//! `set-many.test.ts`: a layer's value wins in its scope, a global-only key does not
//! take on a workspace, a batch commits once, and a value an older file held is
//! migrated when the service opens it.

// The service is single-threaded: its IO and timers are inert objects the test drives.
#![allow(clippy::arc_with_non_send_sync)]

use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct MemoryIo {
    files: Mutex<BTreeMap<PathBuf, String>>,
    writes: Mutex<usize>,
    reads: Mutex<usize>,
    watches: Mutex<usize>,
    changed: Mutex<Option<Rc<dyn Fn()>>>,
    failed: Mutex<Option<Rc<dyn Fn()>>>,
    stopped: Arc<Mutex<usize>>,
}

impl MemoryIo {
    fn fire_changed(&self) {
        if let Some(changed) = self
            .changed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            changed();
        }
    }

    fn fire_failed(&self) {
        if let Some(failed) = self
            .failed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            failed();
        }
    }

    fn count(counter: &Mutex<usize>) -> usize {
        *counter.lock().unwrap_or_else(|error| error.into_inner())
    }
}

impl SettingsIo for MemoryIo {
    fn read(&self, path: &std::path::Path) -> Result<Option<String>, SettingsError> {
        *self.reads.lock().unwrap_or_else(|error| error.into_inner()) += 1;
        Ok(self
            .files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(path)
            .cloned())
    }

    fn write(
        &self,
        path: &std::path::Path,
        text: &str,
        before_commit: Option<&crate::file::Validate>,
    ) -> Result<(), SettingsError> {
        if let Some(before_commit) = before_commit {
            before_commit()?;
        }
        *self
            .writes
            .lock()
            .unwrap_or_else(|error| error.into_inner()) += 1;
        self.files
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(path.to_owned(), text.to_owned());
        Ok(())
    }

    fn watch(
        &self,
        _path: &std::path::Path,
        changed: std::rc::Rc<dyn Fn()>,
        failed: std::rc::Rc<dyn Fn()>,
    ) -> Result<Stop, SettingsError> {
        *self
            .watches
            .lock()
            .unwrap_or_else(|error| error.into_inner()) += 1;
        *self
            .changed
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(changed);
        *self
            .failed
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(failed);
        let stopped = self.stopped.clone();
        Ok(Box::new(move || {
            *stopped.lock().unwrap_or_else(|error| error.into_inner()) += 1;
        }))
    }
}

/// A scheduler whose pending timers the test fires by hand.
#[derive(Default, Clone)]
struct FakeScheduler {
    state: Arc<FakeState>,
}

#[derive(Default)]
struct FakeState {
    pending: Mutex<BTreeMap<usize, Box<dyn Fn()>>>,
    next: Mutex<usize>,
}

impl FakeScheduler {
    fn pending(&self) -> usize {
        self.state
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    fn fire(&self) {
        let callbacks: Vec<Box<dyn Fn()>> = std::mem::take(
            &mut *self
                .state
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
        .into_values()
        .collect();
        for callback in callbacks {
            callback();
        }
    }
}

impl Scheduler for FakeScheduler {
    fn schedule(&self, _delay_ms: u64, callback: Box<dyn Fn()>) -> Stop {
        let id = {
            let mut next = self
                .state
                .next
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let id = *next;
            *next += 1;
            id
        };
        self.state
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id, callback);
        let pending = self.state.clone();
        Box::new(move || {
            pending
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
        })
    }
}

struct NoScheduler;

impl Scheduler for NoScheduler {
    fn schedule(&self, _delay_ms: u64, _callback: Box<dyn Fn()>) -> Stop {
        Box::new(|| {})
    }
}

fn service(io: Arc<MemoryIo>) -> Rc<RefCell<SettingsService>> {
    SettingsService::new(
        PathBuf::from("/data"),
        io,
        Arc::new(NoScheduler),
        BTreeMap::new(),
    )
    .unwrap_or_else(|error| panic!("{error}"))
}

/// A scratch workspace that exists on disk, since a workspace root is pinned to its
/// identity when the service first reads it.
fn workspace(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "ace-settings-service-{name}-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap_or_else(|error| panic!("{error}"));
    path
}

#[test]
fn a_workspaces_value_wins_in_its_scope_and_resets_to_global_outside_it() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let repo = workspace("scope");
    SettingsService::set(
        &service,
        "threads.settleOnClose",
        &json!(true),
        &Layer::Global,
    )
    .unwrap_or_else(|error| panic!("{error}"));
    SettingsService::set(
        &service,
        "threads.settleOnClose",
        &json!(false),
        &Layer::Workspace {
            workspace: repo.clone(),
        },
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let scoped = SettingsService::get(
        &service,
        "threads.settleOnClose",
        &Scope {
            workspace: Some(repo.clone()),
            thread: None,
        },
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(scoped.value, json!(false));
    assert_eq!(scoped.provenance, Provenance::Workspace);
    let global = SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(global.value, json!(true));
    assert_eq!(global.provenance, Provenance::Global);
    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn a_global_only_key_is_refused_on_a_workspace_layer() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io);
    assert_eq!(
        SettingsService::set(
            &service,
            "spade.enabled",
            &json!(true),
            &Layer::Workspace {
                workspace: PathBuf::from("/repo")
            },
        )
        .map_err(|error| error.message),
        Err("Running Spade is a global setting".into())
    );
}

#[test]
fn a_batch_never_mixes_a_setting_the_daemon_handles_itself() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let entries = vec![
        ("remote.enabled".to_owned(), json!(false)),
        ("threads.sortBy".to_owned(), json!("manual")),
    ];
    assert_eq!(
        SettingsService::set_many(&service, &entries, &Layer::Global)
            .map_err(|error| error.message),
        Err("Set remote.enabled on its own, not with others".into())
    );
    assert_eq!(MemoryIo::count(&io.writes), 0, "the batch wrote nothing");
}

#[test]
fn a_batch_is_one_commit_and_one_bad_value_writes_none_of_it() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let entries = vec![
        ("threads.sortBy".to_owned(), json!("manual")),
        ("threads.followUpBehavior".to_owned(), json!("steer")),
    ];
    SettingsService::set_many(&service, &entries, &Layer::Global)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
        1
    );
    let bad = vec![
        ("threads.sortBy".to_owned(), json!("manual")),
        ("threads.followUpBehavior".to_owned(), json!("soon")),
    ];
    assert!(SettingsService::set_many(&service, &bad, &Layer::Global).is_err());
    assert_eq!(
        *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
        1
    );
}

#[test]
fn a_malformed_file_reads_defaults_with_a_diagnostic_and_keeps_its_watch() {
    let io = Arc::new(MemoryIo::default());
    io.files
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(PathBuf::from("/data/settings.json"), "{".to_owned());
    let service = service(io.clone());
    let (entries, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope::default(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entries[0].value, json!(false), "the shipped default");
    assert_eq!(entries[0].provenance, Provenance::Defaults);
    assert_eq!(diagnostics.len(), 1);
    assert_eq!(diagnostics[0].code, SettingsCode::Parse);
    assert_eq!(diagnostics[0].layer, Provenance::Global);
    assert_eq!(
        *io.watches.lock().unwrap_or_else(|error| error.into_inner()),
        1,
        "the file is still watched for a repair"
    );

    io.files
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            PathBuf::from("/data/settings.json"),
            "{\"version\":2,\"settings\":{\"threads.settleOnClose\":true}}".to_owned(),
        );
    SettingsService::refresh(&service, &Layer::Global).unwrap_or_else(|error| panic!("{error}"));
    let (entries, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope::default(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entries[0].value, json!(true), "the repair is read");
    assert!(diagnostics.is_empty());
}

#[test]
fn a_malformed_edit_after_a_good_load_keeps_the_last_good_values() {
    let io = Arc::new(MemoryIo::default());
    io.files
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(
            PathBuf::from("/data/settings.json"),
            "{\"version\":2,\"settings\":{\"threads.settleOnClose\":true}}".to_owned(),
        );
    let service = service(io.clone());
    let entry = SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entry.value, json!(true));

    io.files
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(PathBuf::from("/data/settings.json"), "{".to_owned());
    SettingsService::refresh(&service, &Layer::Global)
        .unwrap_or_else(|error| panic!("a malformed edit only reports: {error}"));
    let (entries, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope::default(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(entries[0].value, json!(true), "the last good value stays");
    assert_eq!(diagnostics[0].code, SettingsCode::Parse);
    assert_eq!(
        *io.writes.lock().unwrap_or_else(|error| error.into_inner()),
        0,
        "nothing is written over the malformed text"
    );
}

#[test]
fn a_closed_service_refuses_reads_and_writes() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    let writes = MemoryIo::count(&io.writes);
    SettingsService::close(&service);
    for refusal in [
        SettingsService::get(&service, "threads.settleOnClose", &Scope::default()).map(|_| ()),
        SettingsService::set(
            &service,
            "threads.settleOnClose",
            &json!(true),
            &Layer::Global,
        ),
        SettingsService::refresh(&service, &Layer::Global),
    ] {
        assert_eq!(
            refusal.map_err(|error| error.message),
            Err("Settings service is closed".into())
        );
    }
    assert_eq!(MemoryIo::count(&io.writes), writes, "nothing was written");
}

#[test]
fn the_open_file_cache_evicts_the_least_recently_used_healthy_file() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    for index in 0..65 {
        let scope = Scope {
            workspace: None,
            thread: Some(format!("t{index}")),
        };
        SettingsService::get(&service, "threads.settleOnClose", &scope)
            .unwrap_or_else(|error| panic!("{error}"));
    }
    assert_eq!(service.borrow().files.len(), 64, "the cache is bounded");
    assert!(
        MemoryIo::count(&io.stopped) >= 1,
        "an evicted file's watch is stopped"
    );
}

#[test]
fn watch_events_before_the_boundary_collapse_into_one_reload() {
    let io = Arc::new(MemoryIo::default());
    let scheduler = FakeScheduler::default();
    let service = SettingsService::new(
        PathBuf::from("/data"),
        io.clone(),
        Arc::new(scheduler.clone()),
        BTreeMap::new(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    SettingsService::get(&service, "threads.sortBy", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    let reads = MemoryIo::count(&io.reads);
    for _ in 0..20 {
        io.fire_changed();
    }
    assert_eq!(
        scheduler.pending(),
        1,
        "one reload is scheduled, not twenty"
    );
    scheduler.fire();
    assert_eq!(scheduler.pending(), 0);
    assert_eq!(MemoryIo::count(&io.reads), reads + 1, "one reload happened");
}

#[test]
fn a_failed_watch_reports_a_diagnostic_and_retries() {
    let io = Arc::new(MemoryIo::default());
    let scheduler = FakeScheduler::default();
    let service = SettingsService::new(
        PathBuf::from("/data"),
        io.clone(),
        Arc::new(scheduler.clone()),
        BTreeMap::new(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(MemoryIo::count(&io.watches), 1);

    io.fire_failed();
    let (_, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope::default(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(diagnostics[0].code, SettingsCode::Io);
    assert_eq!(diagnostics[0].message, "Settings watcher failed");
    assert_eq!(scheduler.pending(), 1, "a retry is scheduled");

    scheduler.fire();
    assert_eq!(MemoryIo::count(&io.watches), 2, "the watch is reinstalled");
    let (_, diagnostics) = SettingsService::read(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope::default(),
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert!(diagnostics.is_empty(), "the recovered watch is quiet");
}

#[test]
fn a_subscription_hears_only_a_change_that_moves_its_effective_value() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io);
    let repo = workspace("subscribe");
    let scope = Scope {
        workspace: Some(repo.clone()),
        thread: None,
    };
    let layer = Layer::Workspace {
        workspace: repo.clone(),
    };
    SettingsService::set(&service, "threads.sortBy", &json!("manual"), &layer)
        .unwrap_or_else(|error| panic!("{error}"));

    let notices: Rc<RefCell<Vec<Notification>>> = Rc::new(RefCell::new(Vec::new()));
    let captured = notices.clone();
    let listener: Subscriber = Rc::new(move |notification| {
        captured.borrow_mut().push(notification.clone());
    });
    let stop =
        SettingsService::subscribe(&service, &["threads.sortBy".to_owned()], &scope, listener)
            .unwrap_or_else(|error| panic!("{error}"));

    // The workspace value shadows a global change: the effective entry did not move.
    SettingsService::set(
        &service,
        "threads.sortBy",
        &json!("created"),
        &Layer::Global,
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert!(notices.borrow().is_empty(), "{:?}", notices.borrow());

    SettingsService::set(&service, "threads.sortBy", &json!("created"), &layer)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        *notices.borrow(),
        vec![Notification::Changed {
            entries: vec![Entry {
                key: "threads.sortBy".to_owned(),
                value: json!("created"),
                provenance: Provenance::Workspace,
                local_value: None,
            }]
        }]
    );
    stop();
    assert!(
        !service
            .borrow()
            .pinned
            .contains(&repo.join(".ace").join("settings.json")),
        "a stopped subscription releases the file it held"
    );
    let _ = std::fs::remove_dir_all(&repo);
}

#[test]
fn a_subscription_hears_a_diagnostic_from_a_file_in_its_scope() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let notices: Rc<RefCell<Vec<Notification>>> = Rc::new(RefCell::new(Vec::new()));
    let captured = notices.clone();
    let listener: Subscriber = Rc::new(move |notification| {
        captured.borrow_mut().push(notification.clone());
    });
    let _stop = SettingsService::subscribe(
        &service,
        &["threads.settleOnClose".to_owned()],
        &Scope::default(),
        listener,
    )
    .unwrap_or_else(|error| panic!("{error}"));

    io.files
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .insert(PathBuf::from("/data/settings.json"), "{".to_owned());
    SettingsService::refresh(&service, &Layer::Global).unwrap_or_else(|error| panic!("{error}"));
    match &notices.borrow()[0] {
        Notification::Diagnostic(diagnostic) => {
            assert_eq!(diagnostic.code, SettingsCode::Parse);
            assert_eq!(diagnostic.layer, Provenance::Global);
        }
        other => panic!("{:?}", other),
    }
}

#[test]
fn a_change_listener_sees_exactly_the_layer_and_keys_that_changed() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io);
    type Seen = Rc<RefCell<Vec<(Layer, Vec<String>)>>>;
    let seen: Seen = Rc::new(RefCell::new(Vec::new()));
    let captured = seen.clone();
    let listener: ChangeListener = Rc::new(move |layer, keys| {
        captured.borrow_mut().push((layer.clone(), keys.to_vec()));
    });
    let _stop =
        SettingsService::on_change(&service, listener).unwrap_or_else(|error| panic!("{error}"));
    SettingsService::set(
        &service,
        "threads.sortBy",
        &json!("created"),
        &Layer::Global,
    )
    .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        *seen.borrow(),
        vec![(Layer::Global, vec!["threads.sortBy".to_owned()])]
    );
}

#[test]
fn a_change_listener_can_read_the_value_it_just_saw_committed() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io);
    type Seen = Rc<RefCell<Vec<(Layer, Vec<String>, Value)>>>;
    let seen: Seen = Rc::new(RefCell::new(Vec::new()));
    let captured = seen.clone();
    let weak = Rc::downgrade(&service);
    let listener: ChangeListener = Rc::new(move |layer, keys| {
        if let Some(service) = weak.upgrade() {
            let entry = SettingsService::get(&service, "threads.sortBy", &Scope::default())
                .unwrap_or_else(|error| panic!("{error}"));
            captured
                .borrow_mut()
                .push((layer.clone(), keys.to_vec(), entry.value));
        }
    });
    let _stop =
        SettingsService::on_change(&service, listener).unwrap_or_else(|error| panic!("{error}"));
    SettingsService::set(&service, "threads.sortBy", &json!("manual"), &Layer::Global)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        *seen.borrow(),
        vec![(
            Layer::Global,
            vec!["threads.sortBy".to_owned()],
            json!("manual")
        )]
    );
}

#[test]
fn reset_removes_more_than_thirty_two_keys_in_one_commit() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let keys: Vec<String> = [
        "storage.scheduledCleanup",
        "storage.worktreeRetentionDays",
        "storage.backupWorktrees",
        "storage.retentionDays",
        "logs.maxBytes",
        "threads.followUpBehavior",
        "threads.forkOnSwitch",
        "threads.limitPolicy",
        "providers.default",
        "providers.coder.provider",
        "providers.coder.model",
        "providers.coder.tier",
        "providers.coder.reasoningEffort",
        "providers.reviewer.provider",
        "providers.reviewer.model",
        "providers.reviewer.tier",
        "providers.reviewer.reasoningEffort",
        "providers.planner.provider",
        "providers.planner.model",
        "providers.planner.tier",
        "providers.planner.reasoningEffort",
        "providers.verifier.provider",
        "providers.verifier.model",
        "providers.verifier.tier",
        "providers.verifier.reasoningEffort",
        "providers.claude.chrome",
        "browser.backend",
        "browser.backendLoss",
        "browser.profile",
        "browser.profileScope",
        "browser.downloadDir",
        "browser.downloadDefault",
        "browser.userChrome.storageReads",
        "threads.sortBy",
        "threads.settleOnClose",
        "threads.settleOnMerge",
        "threads.keepSettledFor",
        "threads.useWorktree",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    assert!(keys.len() > 32, "test must exceed the 32-key batch cap");

    // Seed a few keys so reset has real entries to remove.
    SettingsService::set(&service, "threads.sortBy", &json!("manual"), &Layer::Global)
        .unwrap_or_else(|error| panic!("{error}"));
    SettingsService::set(
        &service,
        "threads.settleOnClose",
        &json!(true),
        &Layer::Global,
    )
    .unwrap_or_else(|error| panic!("{error}"));
    let writes_before = MemoryIo::count(&io.writes);

    // Empty reset is a zero-write no-op.
    SettingsService::reset(&service, &[]).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(MemoryIo::count(&io.writes), writes_before);

    // Unknown key is refused without writing.
    assert_eq!(
        SettingsService::reset(&service, &["not.a.real.key".to_owned()])
            .map_err(|error| error.code),
        Err(SettingsCode::Validation)
    );
    assert_eq!(MemoryIo::count(&io.writes), writes_before);

    SettingsService::reset(&service, &keys).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        MemoryIo::count(&io.writes),
        writes_before + 1,
        "all keys reset in a single commit"
    );
    assert_eq!(
        SettingsService::get(&service, "threads.sortBy", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"))
            .provenance,
        Provenance::Defaults
    );
    assert_eq!(
        SettingsService::get(&service, "threads.settleOnClose", &Scope::default())
            .unwrap_or_else(|error| panic!("{error}"))
            .provenance,
        Provenance::Defaults
    );
}

#[test]
fn a_secret_assignment_is_refused_before_opening_the_file() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let secret = json!({ "accent": "sk-ant-api03-123456789012345678901234567890" });
    let entries = vec![("clients.theme".to_owned(), secret.clone())];

    assert_eq!(
        SettingsService::set(&service, "clients.theme", &secret, &Layer::Global)
            .map_err(|error| error.code),
        Err(SettingsCode::Secret)
    );
    assert_eq!(
        SettingsService::set_if_absent(&service, "clients.theme", &secret, &Layer::Global)
            .map_err(|error| error.code),
        Err(SettingsCode::Secret)
    );
    assert_eq!(
        SettingsService::set_many(&service, &entries, &Layer::Global).map_err(|error| error.code),
        Err(SettingsCode::Secret)
    );
    assert_eq!(MemoryIo::count(&io.reads), 0, "file was never opened");
    assert_eq!(MemoryIo::count(&io.writes), 0, "file was never written");
    assert_eq!(MemoryIo::count(&io.watches), 0, "watch was never installed");
}

#[test]
fn a_write_rewatches_so_a_newly_created_directory_upgrades_its_watch() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    SettingsService::get(&service, "threads.sortBy", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    let watches_before = MemoryIo::count(&io.watches);
    SettingsService::set(&service, "threads.sortBy", &json!("manual"), &Layer::Global)
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        MemoryIo::count(&io.watches),
        watches_before + 1,
        "committing a write rewatches the file so a newly created parent directory is watched"
    );
}

#[test]
fn setting_providers_configuration_normalizes_cursor_rows_and_prefers_sdk_on_collision() {
    let io = Arc::new(MemoryIo::default());
    let service = service(io.clone());
    let rows = json!([
        {
            "provider": "cursor",
            "instance": "cursor-cli-default",
            "binaryPath": "/usr/local/bin/cursor-agent",
            "defaultModel": "cli-model"
        },
        {
            "provider": "cursor",
            "instance": "cursor-sdk-default",
            "binaryPath": "/usr/local/bin/cursor-sdk",
            "defaultModel": "sdk-model"
        },
        {
            "provider": "claude",
            "binaryPath": "/usr/local/bin/claude"
        }
    ]);
    SettingsService::set(&service, "providers.configuration", &rows, &Layer::Global)
        .unwrap_or_else(|error| panic!("{error}"));
    let entry = SettingsService::get(&service, "providers.configuration", &Scope::default())
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        entry.value,
        json!([
            {
                "provider": "cursor",
                "instance": "cursor-sdk-default",
                "defaultModel": "sdk-model"
            },
            {
                "provider": "claude",
                "binaryPath": "/usr/local/bin/claude"
            }
        ])
    );
    let writes = MemoryIo::count(&io.writes);
    SettingsService::refresh(&service, &Layer::Global).unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        MemoryIo::count(&io.writes),
        writes,
        "reloading normalized Cursor rows does not rewrite the file"
    );
}
