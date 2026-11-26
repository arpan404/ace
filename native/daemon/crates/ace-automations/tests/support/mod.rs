// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic, dead_code)]
//! Shared harness for the service-level ports of `packages/automations/src/*.test.ts`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use ace_automations::scheduler::{Admission, Clock, IdSource, Random};
use ace_automations::service::{Action, Ports, Service, TimerPort, Workspace};
use ace_automations::{AutomationStore, Definition, Schedule, ScheduleKind, Trigger};
use ace_json::Value;

pub(crate) fn json(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

pub(crate) fn sv<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.as_object()?.get(key)?.as_str()
}

pub(crate) fn iv(value: &Value, key: &str) -> Option<i64> {
    value.as_object()?.get(key)?.as_i64()
}

pub(crate) fn bv(value: &Value, key: &str) -> Option<bool> {
    value.as_object()?.get(key)?.as_bool()
}

pub(crate) fn arr(value: &Value, key: &str) -> Vec<Value> {
    value
        .as_object()
        .and_then(|object| object.get(key))
        .and_then(Value::as_array)
        .map(|items| items.iter().cloned().collect())
        .unwrap_or_default()
}

pub(crate) fn at<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object()?.get(key)
}

pub(crate) const START: i64 = 1_704_099_600_000;
pub(crate) const DAY: i64 = 86_400_000;

pub(crate) struct TestClock(pub(crate) Cell<i64>);

impl Clock for TestClock {
    fn now_ms(&self) -> i64 {
        self.0.get()
    }
}

pub(crate) struct TestRandom(pub(crate) Cell<f64>);

impl Random for TestRandom {
    fn draw(&self) -> f64 {
        self.0.get()
    }
}

pub(crate) struct TestAdmission {
    pub(crate) open: Cell<bool>,
}

impl Admission for TestAdmission {
    fn open(&self) -> bool {
        self.open.get()
    }
}

/// A host id generator: one counter for the whole test file, including across reopens, as a
/// daemon's generator is not reset by a restart.
#[derive(Default)]
pub(crate) struct TestIds {
    next: Cell<u64>,
}

impl IdSource for TestIds {
    fn next_id(&self) -> String {
        let next = self.next.get() + 1;
        self.next.set(next);
        format!("run-{next}")
    }
}

#[derive(Default)]
pub(crate) struct TestWorkspace {
    pub(crate) subscriptions: RefCell<Vec<String>>,
    pub(crate) unsubscriptions: Cell<usize>,
    pub(crate) released: RefCell<Vec<u64>>,
    pub(crate) next: Cell<u64>,
    pub(crate) fail: Cell<bool>,
}

impl Workspace for TestWorkspace {
    fn subscribe(&self, workspace: &str, _paths: &[String]) -> Result<u64, String> {
        if self.fail.get() {
            return Err("Project folder unavailable".to_owned());
        }
        let handle = self.next.get() + 1;
        self.next.set(handle);
        self.subscriptions.borrow_mut().push(workspace.to_owned());
        Ok(handle)
    }

    fn unsubscribe(&self, subscription: u64) {
        self.unsubscriptions.set(self.unsubscriptions.get() + 1);
        self.released.borrow_mut().push(subscription);
    }
}

#[derive(Default)]
pub(crate) struct TestTimer {
    pub(crate) delay: Cell<Option<i64>>,
    pub(crate) arms: Cell<usize>,
    pub(crate) cancels: Cell<usize>,
    pub(crate) fail_arm: Cell<bool>,
    pub(crate) fail_cancel: Cell<bool>,
}

impl TimerPort for TestTimer {
    fn arm(&self, delay_ms: i64) -> Result<(), String> {
        if self.fail_arm.get() {
            self.fail_arm.set(false);
            return Err("database is locked".to_owned());
        }
        self.arms.set(self.arms.get() + 1);
        self.delay.set(Some(delay_ms));
        Ok(())
    }

    fn cancel(&self) -> Result<(), String> {
        self.cancels.set(self.cancels.get() + 1);
        self.delay.set(None);
        if self.fail_cancel.get() {
            self.fail_cancel.set(false);
            return Err("timer cancellation failed".to_owned());
        }
        Ok(())
    }
}

pub(crate) struct Harness {
    pub(crate) dir: tempfile::TempDir,
    pub(crate) store: AutomationStore,
    pub(crate) clock: TestClock,
    pub(crate) random: TestRandom,
    pub(crate) admission: TestAdmission,
    pub(crate) workspace: TestWorkspace,
    pub(crate) timer: TestTimer,
    pub(crate) ids: TestIds,
}

impl Harness {
    pub(crate) fn new() -> Harness {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = AutomationStore::open(dir.path().join("auto.sqlite").to_str().expect("utf8"))
            .expect("store");
        Harness {
            dir,
            store,
            clock: TestClock(Cell::new(START - 60_000)),
            random: TestRandom(Cell::new(0.0)),
            admission: TestAdmission {
                open: Cell::new(true),
            },
            workspace: TestWorkspace::default(),
            timer: TestTimer::default(),
            ids: TestIds::default(),
        }
    }

    pub(crate) fn path(&self) -> std::path::PathBuf {
        self.dir.path().join("auto.sqlite")
    }

    pub(crate) fn service(&self) -> Service<'_> {
        self.service_on(&self.store)
    }

    /// A service over another store (a reopen) with this harness's ports and id generator.
    pub(crate) fn service_on<'b>(&'b self, store: &'b AutomationStore) -> Service<'b> {
        Service::new(
            store,
            Ports {
                clock: &self.clock,
                random: &self.random,
                admission: &self.admission,
                timer: &self.timer,
                ids: &self.ids,
                workspace: Some(&self.workspace),
                model_loading: None,
            },
        )
    }

    pub(crate) fn started(&self) -> Service<'_> {
        let mut service = self.service();
        service.start().expect("start");
        service
    }

    pub(crate) fn reopen(&self) -> AutomationStore {
        AutomationStore::open(self.path().to_str().expect("utf8")).expect("reopen")
    }
}

pub(crate) fn definition() -> Definition {
    Definition {
        id: "triage".to_owned(),
        title: "Triage".to_owned(),
        enabled: true,
        workspace: "/project".to_owned(),
        provider: "codex".to_owned(),
        access: None,
        model: Some("test-model".to_owned()),
        effort: None,
        instance: None,
        prompt: "Triage {{subject}}".to_owned(),
        worktree: true,
        trigger: Trigger::Manual,
        missed_run: "skip".to_owned(),
        concurrency: 1,
        jitter_ms: 0,
        extra: Default::default(),
    }
}

pub(crate) fn scheduled(policy: &str, jitter_ms: i64) -> Definition {
    Definition {
        prompt: "Triage {{scheduled_at}}".to_owned(),
        trigger: Trigger::Schedule {
            schedule: Schedule {
                kind: ScheduleKind::Rrule,
                expression: "FREQ=DAILY".to_owned(),
                timezone: "UTC".to_owned(),
                start_at: START,
            },
        },
        missed_run: policy.to_owned(),
        jitter_ms,
        ..definition()
    }
}

pub(crate) fn variables(subject: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("subject".to_owned(), subject.to_owned())])
}

pub(crate) fn run_id(run: &Value) -> String {
    sv(run, "id").expect("run id").to_owned()
}

pub(crate) fn run_status(run: &Value) -> String {
    sv(run, "status").expect("run status").to_owned()
}

pub fn input_prompt(action: &Action) -> String {
    match action {
        Action::Execute { input, .. }
        | Action::Recover { input, .. }
        | Action::Interrupt { input, .. } => sv(input, "prompt").expect("prompt").to_owned(),
        Action::PollGithub { .. } => panic!("expected a run action"),
    }
}

pub(crate) fn execute(action: &Action) -> (String, Value) {
    match action {
        Action::Execute { run_id, input } => (run_id.clone(), input.clone()),
        other => panic!("expected execute, got {other:?}"),
    }
}

pub(crate) fn inputs_prompt(action: &Action) -> String {
    match action {
        Action::Execute { input, .. } => sv(input, "prompt").expect("prompt").to_owned(),
        other => panic!("expected execute, got {other:?}"),
    }
}
