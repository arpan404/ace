// SPDX-License-Identifier: Apache-2.0

//! The `helper-connection.process` cases, moved from TypeScript
//! (`packages/screen/src/computer/helper-connection.process.test.ts`): a request aborted
//! before it was sent, a broken stdin pipe, a helper that ignores SIGTERM, and one that
//! refuses SIGKILL. No real helper and no screen: the start is a fake process.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ace_json::{Map, Value};
use ace_supervisor::signal::SignalName;
use tokio_util::sync::CancellationToken;

use super::{ChildEvents, Connection, ConnectionOptions, HelperProcess, HelperStart, StartFuture};

/// One fake helper, as the test drives it. `ignores_stop` stands in for
/// `FAKE_IGNORE_STOP`; `refuses_kill` for a system that rejects SIGKILL.
#[derive(Clone, Default)]
struct Helper {
    pid: u32,
    writes: Arc<Mutex<Vec<String>>>,
    kills: Arc<Mutex<Vec<SignalName>>>,
    ignores_stop: Arc<AtomicBool>,
    refuses_kill: Arc<AtomicBool>,
    exited: Arc<AtomicBool>,
    events: Arc<Mutex<Option<Arc<dyn ChildEvents>>>>,
}

impl Helper {
    fn writes(&self) -> Vec<String> {
        self.writes
            .lock()
            .map(|writes| writes.clone())
            .unwrap_or_default()
    }

    fn kills(&self) -> Vec<SignalName> {
        self.kills
            .lock()
            .map(|kills| kills.clone())
            .unwrap_or_default()
    }

    fn output(&self, text: &str) {
        if let Some(events) = self.events.lock().ok().and_then(|events| events.clone()) {
            events.output(text.as_bytes().to_vec());
        }
    }

    fn report_exit(&self) {
        self.exited.store(true, Ordering::Relaxed);
        if let Some(events) = self.events.lock().ok().and_then(|events| events.clone()) {
            events.exit();
        }
    }

    fn break_stdin(&self) {
        if let Some(events) = self.events.lock().ok().and_then(|events| events.clone()) {
            events.stdin_error();
        }
    }

    fn reply(&self, index: usize, result: &str) {
        let writes = self.writes();
        let Some(line) = writes.get(index) else {
            panic!("no write {index} to reply to");
        };
        let id = id_in(line);
        self.output(&format!(
            "{{\"id\":\"{id}\",\"ok\":true,\"result\":{result}}}\n"
        ));
    }
}

struct FakeProcess(Helper);

impl HelperProcess for FakeProcess {
    fn pid(&self) -> u32 {
        self.0.pid
    }

    fn write(&self, bytes: Vec<u8>) {
        if let Ok(mut writes) = self.0.writes.lock() {
            writes.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }

    fn end_stdin(&self) {}

    fn kill(&self, signal: SignalName) -> bool {
        if let Ok(mut kills) = self.0.kills.lock() {
            kills.push(signal);
        }
        match signal {
            SignalName::Term => {
                if self.0.ignores_stop.load(Ordering::Relaxed) {
                    return true;
                }
                self.0.report_exit();
                true
            }
            SignalName::Kill => {
                if self.0.refuses_kill.load(Ordering::Relaxed) {
                    return false;
                }
                self.0.report_exit();
                true
            }
        }
    }
}

/// Every helper the connection asked for, in order, and whether all earlier ones had exited
/// when each started (`helper-connection.process.test.ts:34`).
#[derive(Default)]
struct FakeStart {
    helpers: Mutex<Vec<Helper>>,
    started_after_exit: Mutex<Vec<bool>>,
    spawns: AtomicU32,
    ignores_stop: bool,
    refuses_kill: bool,
}

impl FakeStart {
    fn ignoring_stop() -> Self {
        Self {
            ignores_stop: true,
            ..Self::default()
        }
    }

    fn spawned(&self) -> usize {
        self.helpers
            .lock()
            .map(|helpers| helpers.len())
            .unwrap_or(0)
    }

    fn helper(&self, index: usize) -> Helper {
        self.helpers
            .lock()
            .ok()
            .and_then(|helpers| helpers.get(index).cloned())
            .unwrap_or_else(|| panic!("no helper {index}"))
    }

    fn started_after_exit(&self) -> Vec<bool> {
        self.started_after_exit
            .lock()
            .map(|starts| starts.clone())
            .unwrap_or_default()
    }
}

impl HelperStart for FakeStart {
    fn start(&self, events: Arc<dyn ChildEvents>) -> StartFuture {
        let earlier_exited = self
            .helpers
            .lock()
            .map(|helpers| {
                helpers
                    .iter()
                    .all(|helper| helper.exited.load(Ordering::Relaxed))
            })
            .unwrap_or(false);
        if let Ok(mut starts) = self.started_after_exit.lock() {
            starts.push(earlier_exited);
        }
        let spawn = self.spawns.fetch_add(1, Ordering::Relaxed) + 1;
        let helper = Helper {
            pid: 4_000 + spawn,
            ignores_stop: Arc::new(AtomicBool::new(self.ignores_stop)),
            refuses_kill: Arc::new(AtomicBool::new(self.refuses_kill)),
            events: Arc::new(Mutex::new(Some(events))),
            ..Helper::default()
        };
        if let Ok(mut helpers) = self.helpers.lock() {
            helpers.push(helper.clone());
        }
        Box::pin(async move { Ok(Box::new(FakeProcess(helper)) as Box<dyn HelperProcess>) })
    }
}

fn options(start: Arc<FakeStart>) -> ConnectionOptions {
    let ids = Arc::new(AtomicU32::new(0));
    ConnectionOptions {
        start,
        next_id: Arc::new(move || format!("r{}", ids.fetch_add(1, Ordering::Relaxed) + 1)),
        max_reply_bytes: 1024 * 1024,
        grace_ms: 30,
        force_kill_ms: 60,
        ..ConnectionOptions::default()
    }
}

fn payload() -> Map {
    Map::new()
}

fn id_in(line: &str) -> String {
    let value = ace_json::parse(line).unwrap_or(Value::Null);
    value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

async fn until(what: &str, condition: impl Fn() -> bool) {
    for _ in 0..1_000 {
        if condition() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn a_request_whose_signal_was_aborted_before_it_was_sent_never_reaches_the_helper() {
    let start = Arc::new(FakeStart::default());
    let connection = Connection::start(options(Arc::clone(&start)));
    let stop = CancellationToken::new();
    stop.cancel();
    let error = connection
        .request("act", &payload(), 10_000, Some(stop), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(error.message, "Cancelled.");
    assert!(!connection.busy().await);
    assert_eq!(start.spawned(), 0, "nothing may be spawned");
}

#[tokio::test]
async fn a_helper_whose_stdin_pipe_breaks_mid_request_fails_it_and_the_next_gets_a_fresh_helper() {
    let start = Arc::new(FakeStart::default());
    let connection = Connection::start(options(Arc::clone(&start)));
    let stuck = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("act", &payload(), 10_000, None, None)
                .await
        }
    });
    until("the act on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    start.helper(0).break_stdin();
    let error = stuck
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_err();
    assert_eq!(error.code, "helper_exited");
    // A helper that took SIGTERM exited; the connection is still usable.
    assert!(!connection.is_closed());
    let next = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("state", &payload(), 10_000, None, None)
                .await
        }
    });
    until("the second helper", || start.spawned() == 2).await;
    until("the state on the wire", || {
        start.helper(1).writes().len() == 1
    })
    .await;
    start.helper(1).reply(0, "{\"app\":\"calculator\"}");
    let result = next
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        result.get("app").and_then(Value::as_str),
        Some("calculator")
    );
}

#[tokio::test]
async fn a_stuck_helper_that_ignores_sigterm_is_force_killed_and_its_replacement_waits_for_it() {
    let start = Arc::new(FakeStart::ignoring_stop());
    let connection = Connection::start(options(Arc::clone(&start)));
    let stuck = tokio::spawn({
        let connection = connection.clone();
        async move { connection.request("act", &payload(), 200, None, None).await }
    });
    until("the act on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    // Queued behind the stuck request: it needs a new helper for the same connection.
    let next = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("state", &payload(), 10_000, None, None)
                .await
        }
    });
    let error = stuck
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    until("the state on the second helper", || {
        start.spawned() == 2 && start.helper(1).writes().len() == 1
    })
    .await;
    start.helper(1).reply(0, "{\"app\":\"calculator\"}");
    next.await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_or_else(|error| panic!("{error}"));
    // SIGTERM first, then SIGKILL; the replacement started only once the old one had exited.
    assert_eq!(
        start.helper(0).kills(),
        vec![SignalName::Term, SignalName::Kill]
    );
    assert_eq!(start.started_after_exit(), vec![true, true]);
    assert_eq!(start.spawned(), 2);
}

#[tokio::test]
async fn while_a_stopping_helper_cannot_be_killed_the_apps_next_request_fails_instead_of_starting()
{
    let mut start = FakeStart::ignoring_stop();
    start.refuses_kill = true;
    let start = Arc::new(start);
    let connection = Connection::start(options(Arc::clone(&start)));
    let stuck = tokio::spawn({
        let connection = connection.clone();
        async move { connection.request("act", &payload(), 200, None, None).await }
    });
    until("the act on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    let next = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("state", &payload(), 1_000, None, None)
                .await
        }
    });
    let error = stuck
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_err();
    assert_eq!(error.code, "timeout");
    let error = next
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_err();
    assert_eq!(error.code, "helper_stopping");
    assert_eq!(start.spawned(), 1, "no successor while the helper lives");
    assert!(!start.helper(0).exited.load(Ordering::Relaxed));
}
