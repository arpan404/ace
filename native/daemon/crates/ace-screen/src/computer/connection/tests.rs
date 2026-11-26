// SPDX-License-Identifier: Apache-2.0

//! The `helper-connection.process` cases, moved from TypeScript
//! (`packages/screen/src/computer/helper-connection.process.test.ts`): a request aborted
//! before it was sent, a broken stdin pipe, a helper that ignores SIGTERM, and one that
//! refuses SIGKILL. No real helper and no screen: the start is a fake process.

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ace_json::{Map, Value};
use ace_supervisor::signal::SignalName;
use tokio_util::sync::CancellationToken;

use super::{
    ChildEvents, Connection, ConnectionOptions, Dispatch, HelperProcess, HelperStart, StartFuture,
};

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
        self.reply_to(&id_in(line), result);
    }

    /// Answer a line by the id it carried, whoever asked.
    fn reply_to(&self, id: &str, result: &str) {
        self.output(&format!(
            "{{\"id\":\"{id}\",\"ok\":true,\"result\":{result}}}\n"
        ));
    }
}

/// The events of a helper that exits during its start.
fn events_for_exit(helper: &Helper) {
    if let Some(events) = helper.events.lock().ok().and_then(|events| events.clone()) {
        events.exit();
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
    /// The next helper exits before its start is reported (`helper-connection.ts:244`).
    exits_once: Arc<AtomicBool>,
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
        if self.exits_once.swap(false, Ordering::Relaxed) {
            // The exit reaches the connection before the start does.
            events_for_exit(&helper);
        }
        Box::pin(async move { Ok(Box::new(FakeProcess(helper)) as Box<dyn HelperProcess>) })
    }
}

fn options(start: Arc<FakeStart>) -> ConnectionOptions {
    let ids = Arc::new(AtomicU32::new(0));
    let mut options = ConnectionOptions::new(
        start,
        Arc::new(move || format!("r{}", ids.fetch_add(1, Ordering::Relaxed) + 1)),
    );
    options.max_reply_bytes = 1024 * 1024;
    options.grace_ms = 30;
    options.force_kill_ms = 60;
    options
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

/// A cancel's acknowledgment carries its own id, so it can never satisfy the action it
/// cancelled: the action keeps waiting for the helper's own reply and keeps the steps it did
/// (`helper-connection.ts:299`, `:374`-`:381`).
#[tokio::test]
async fn a_cancels_acknowledgment_never_answers_the_action_it_cancelled() {
    let start = Arc::new(FakeStart::default());
    let mut options = options(Arc::clone(&start));
    options.grace_ms = 5_000;
    let connection = Connection::start(options);
    let stop = CancellationToken::new();
    let acting = tokio::spawn({
        let connection = connection.clone();
        let stop = stop.clone();
        async move {
            connection
                .request("act", &payload(), 10_000, Some(stop), None)
                .await
        }
    });
    until("the act on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    stop.cancel();
    until("the cancel on the wire", || {
        start.helper(0).writes().len() == 2
    })
    .await;
    let act_id = id_in(&start.helper(0).writes()[0]);
    let cancel_id = id_in(&start.helper(0).writes()[1]);
    assert_ne!(act_id, cancel_id, "every line carries a fresh id");
    // The helper acknowledges the cancel at once; that is not the action's reply.
    start
        .helper(0)
        .reply_to(&cancel_id, r#"{"cancelled":true}"#);
    tokio::time::sleep(Duration::from_millis(40)).await;
    assert!(!acting.is_finished(), "the acknowledgment settled the act");
    start.helper(0).reply(0, r#"{"done":["did key"]}"#);
    let error = acting
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert_eq!(
        error.result,
        Some(ace_json::json!({ "done": ["did key"] })),
        "the action's own reply, not the cancel's acknowledgment"
    );
}

/// A helper that exits before its start is reported fails its request at once, and the next
/// request starts a fresh helper (`helper-connection.ts:244`): the exit is never lost behind
/// `Started`.
#[tokio::test]
async fn a_helper_that_exits_during_its_start_fails_the_request_and_the_next_starts_fresh() {
    let start = Arc::new(FakeStart {
        exits_once: Arc::new(AtomicBool::new(true)),
        ..FakeStart::default()
    });
    let connection = Connection::start(options(Arc::clone(&start)));
    let first = connection
        .request("state", &payload(), 5_000, None, None)
        .await
        .unwrap_err();
    assert_eq!(first.code, "helper_exited");
    assert_eq!(start.spawned(), 1, "the dead helper was never installed");

    let next = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("state", &payload(), 5_000, None, None)
                .await
        }
    });
    until("the second helper", || start.spawned() == 2).await;
    until("the state on the wire", || {
        start.helper(1).writes().len() == 1
    })
    .await;
    start.helper(1).reply(0, r#"{"app":"calculator"}"#);
    let result = next
        .await
        .unwrap_or_else(|_| panic!("request task"))
        .unwrap_or_else(|error| panic!("{error}"));
    assert_eq!(
        result.get("app").and_then(Value::as_str),
        Some("calculator")
    );
}

/// A retired connection answers `stopped` after its helper exited, even though its own shutdown
/// ended its task (`helper-connection.ts:101`-`:107`): otherwise the app's successor would wait
/// forever on a connection that has nothing left to stop (`client.ts:157`-`:165`).
#[tokio::test]
async fn a_retired_connections_stopped_answers_after_its_helper_exited() {
    let start = Arc::new(FakeStart::default());
    let connection = Connection::start(options(Arc::clone(&start)));
    let first = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("state", &payload(), 5_000, None, None)
                .await
        }
    });
    until("the state on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    start.helper(0).reply(0, r#"{"app":"calculator"}"#);
    let _ = first.await;
    connection.close();
    until("the helper's exit", || {
        start.helper(0).exited.load(Ordering::Relaxed)
    })
    .await;
    // The task ends once nothing is starting, running or stopping.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        connection.stopped().await.is_ok(),
        "a retired connection with no helper left answers stopped"
    );
}

/// When SIGKILL is refused, a request already waiting on the stop hears `helper_stopping` at
/// once instead of waiting for its own deadline (`helper-connection.ts:125`-`:131`, `:451`).
#[tokio::test]
async fn a_refused_sigkill_wakes_a_stopped_waiter_with_helper_stopping() {
    let mut start = FakeStart::ignoring_stop();
    start.refuses_kill = true;
    let start = Arc::new(start);
    let connection = Connection::start(options(Arc::clone(&start)));
    let stuck = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("act", &payload(), 5_000, None, None)
                .await
        }
    });
    until("the act on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    // Shutdown starts the stop; the helper ignores SIGTERM and refuses SIGKILL.
    connection.close();
    let waited = tokio::time::timeout(Duration::from_secs(2), connection.stopped()).await;
    let result = waited.expect("stopped answered once SIGKILL was refused");
    assert_eq!(
        result.unwrap_err().code,
        "helper_stopping",
        "the waiter is told the old helper is still running"
    );
    let _ = stuck.await;
}

/// A dispatch whose authority check begins shutdown: the answer is already in the mailbox when
/// `close` arrives, and the action must not reach stdin (`helper-connection.ts:186`-`:195`,
/// `:230`-`:254`).
struct ClosesDuringAuthorize {
    connection: Arc<OnceLock<Connection>>,
}

impl Dispatch for ClosesDuringAuthorize {
    fn ready(&self) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + '_>> {
        Box::pin(async { Ok(true) })
    }

    fn authorize(&self) -> bool {
        if let Some(connection) = self.connection.get() {
            connection.close();
        }
        true
    }

    fn wait(
        &self,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn a_dispatch_that_finishes_after_shutdown_began_writes_nothing() {
    let start = Arc::new(FakeStart::default());
    let connection = Connection::start(options(Arc::clone(&start)));
    let cell = Arc::new(OnceLock::new());
    let _ = cell.set(connection.clone());
    let dispatch = Arc::new(ClosesDuringAuthorize { connection: cell });
    let error = connection
        .request("act", &payload(), 10_000, None, Some(dispatch))
        .await
        .unwrap_err();
    assert_eq!(error.code, "closed");
    assert_eq!(error.message, "Computer use stopped.");
    until("the helper", || start.spawned() == 1).await;
    assert!(
        start.helper(0).writes().is_empty(),
        "no action reaches stdin after shutdown began"
    );
}

/// A dispatch whose authority check takes a while, holding the connection's task exactly where
/// the TypeScript awaits one.
struct SlowDispatch;

impl Dispatch for SlowDispatch {
    fn ready(&self) -> Pin<Box<dyn Future<Output = Result<bool, String>> + Send + '_>> {
        Box::pin(async { Ok(true) })
    }

    fn authorize(&self) -> bool {
        std::thread::sleep(std::time::Duration::from_millis(150));
        true
    }

    fn wait(
        &self,
        _cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        Box::pin(async { Ok(()) })
    }
}

/// A request's clock starts when it is asked for, not when the task reads it
/// (`helper-connection.ts:145`): time the task spends on another request is queue time, and
/// the deadline covers it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_requests_clock_starts_when_it_is_asked_not_when_the_task_reads_it() {
    use super::RequestTiming;

    let start = Arc::new(FakeStart::default());
    let timings: Arc<Mutex<Vec<RequestTiming>>> = Arc::new(Mutex::new(Vec::new()));
    let mut options = options(Arc::clone(&start));
    let began = std::time::Instant::now();
    options.now = Arc::new(move || began.elapsed().as_secs_f64() * 1_000.0);
    let sink = Arc::clone(&timings);
    options.timing = Some(Arc::new(move |timing| {
        if let Ok(mut timings) = sink.lock() {
            timings.push(timing);
        }
    }));
    let connection = Connection::start(options);
    let acting = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("act", &payload(), 5_000, None, Some(Arc::new(SlowDispatch)))
                .await
        }
    });
    // The task is now blocked in the act's authority check.
    tokio::time::sleep(Duration::from_millis(40)).await;
    let queued = tokio::spawn({
        let connection = connection.clone();
        async move {
            connection
                .request("state", &payload(), 30_000, None, None)
                .await
        }
    });
    until("the act on the wire", || {
        start.spawned() == 1 && start.helper(0).writes().len() == 1
    })
    .await;
    start.helper(0).reply(0, r#"{"done":[]}"#);
    let _ = acting.await;
    until("the state on the wire", || {
        start.helper(0).writes().len() == 2
    })
    .await;
    start.helper(0).reply(1, r#"{"app":"calculator"}"#);
    let _ = queued.await;
    let state = timings
        .lock()
        .ok()
        .and_then(|timings| timings.iter().find(|timing| timing.op == "state").cloned())
        .unwrap_or_else(|| panic!("the state's timing was reported"));
    assert!(
        state.queue_ms >= 100.0,
        "time spent behind the act is queue time: {}ms",
        state.queue_ms
    );
}
