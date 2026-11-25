// SPDX-License-Identifier: Apache-2.0
//! The host's cases. `host-retire.test.ts` moved here: a retirement nobody
//! waits on is reported by the shell, an awaited one reaches the session, and
//! one stop is one report. The others cover what the host alone decides:
//! a crash settles every routed call exactly once, an unknown route waits for
//! its ancestry, and an open cancelled before it resolves exits the channel.

mod channels;
mod exit;
mod poison;
mod publication;
mod stop;

use ace_json::Value;
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::Timeout;

use super::*;
use crate::session::harness::{Event, HostRun, Scratch};
use crate::session::pool::{CODEX_ELISION, initialize};

/// The read-ahead a paused pump may still spend: 1 MiB over both pumps, plus
/// the chunks already in flight (`PAUSED_READ_BYTES`, 4 × 64 KiB each).
const PAUSED_SLACK: usize = 3 * 1024 * 1024;

/// What an unpaused pump moves in the same time, well past the slack.
const FLOWING_BYTES: usize = 4 * 1024 * 1024;

pub(super) fn run(name: &str, shared: bool) -> HostRun {
    let config = if shared {
        HostConfig::shared(initialize(), 1_000.0)
    } else {
        HostConfig::dedicated(initialize())
    };
    HostRun::start(Scratch::new(name), config, CODEX_ELISION, None)
}

/// A sink for a host with no child: it keeps the effects the host published,
/// in the order it published them, so a case can read them back, and delivers
/// each frame to the channel that took it.
struct LogSink {
    log: Arc<std::sync::Mutex<Vec<HostEffect>>>,
    handlers: Arc<std::sync::Mutex<std::collections::HashMap<u64, Arc<dyn ChannelHandlers>>>>,
}

impl HostSink for LogSink {
    fn stop(&self, _host: &Host, _reason: Retirement, _awaited: bool) {}

    fn effect(&self, host: &Host, effect: HostEffect) {
        if host.hand_over(&effect, |tenant| {
            self.handlers
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .get(&tenant)
                .cloned()
        }) {
            return;
        }
        self.log
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(effect);
    }
}

/// A host with no child and the effects it published, so a case drives one
/// input at a time and reads exactly what it published.
pub(super) struct Shell {
    pub host: Arc<Host>,
    log: Arc<std::sync::Mutex<Vec<HostEffect>>>,
    handlers: Arc<std::sync::Mutex<std::collections::HashMap<u64, Arc<dyn ChannelHandlers>>>>,
    /// How far into the log the shell has read: every effect is read once, in
    /// the order the host published it.
    read: std::sync::Mutex<usize>,
}

impl std::ops::Deref for Shell {
    type Target = Host;

    fn deref(&self) -> &Host {
        &self.host
    }
}

impl Shell {
    /// A host with no child, whose effects the shell keeps in order.
    pub(super) fn start(config: HostConfig) -> Shell {
        let log = Arc::new(std::sync::Mutex::new(Vec::new()));
        let handlers = Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let host = Arc::new(Host::new(config));
        host.set_sink(Arc::new(LogSink {
            log: Arc::clone(&log),
            handlers: Arc::clone(&handlers),
        }));
        Shell {
            host,
            log,
            handlers,
            read: std::sync::Mutex::new(0),
        }
    }

    /// A channel on this host, its frames delivered by the shell's sink.
    pub(super) fn attach(
        &self,
        tenant: u64,
        handlers: Arc<dyn ChannelHandlers>,
    ) -> Result<(), HostError> {
        self.handlers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(tenant, Arc::clone(&handlers));
        self.host.attach(tenant, handlers)
    }

    /// What the shell does with a host's effects: acknowledge every write,
    /// which hands out the next line, and keep the rest in order with the
    /// lines sent. Returns the other effects and the lines written.
    pub(super) fn pump(&self, run: impl FnOnce()) -> (Vec<HostEffect>, Vec<String>) {
        let mut cursor = *self.read.lock().unwrap_or_else(|error| error.into_inner());
        run();
        let mut rest = Vec::new();
        let mut lines = Vec::new();
        while let Some(effect) = self.at(cursor) {
            cursor += 1;
            match effect {
                HostEffect::Write { wire, ticket } => {
                    if let Ok(text) = std::str::from_utf8(&wire) {
                        lines.push(text.trim_end().to_owned());
                    }
                    self.host.written(ticket);
                }
                other => rest.push(other),
            }
        }
        let mut read = self.read.lock().unwrap_or_else(|error| error.into_inner());
        *read = (*read).max(cursor);
        (rest, lines)
    }

    fn at(&self, index: usize) -> Option<HostEffect> {
        self.log
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(index)
            .cloned()
    }
}

/// The id of the line written for `method`, optionally for `thread`.
pub(super) fn line_id(lines: &[String], method: &str, thread: Option<&str>) -> Option<RpcId> {
    lines.iter().find_map(|line| {
        let value = ace_json::parse(line).ok()?;
        if value.get("method").and_then(Value::as_str) != Some(method) {
            return None;
        }
        if let Some(thread) = thread
            && value
                .get("params")
                .and_then(|params| params.get("threadId"))
                .and_then(Value::as_str)
                != Some(thread)
        {
            return None;
        }
        match value.get("id") {
            Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
            Some(Value::Number(number)) => number.as_f64().map(RpcId::Number),
            _ => None,
        }
    })
}

/// The ids of the lines written for `method`, in the order they went out.
pub(super) fn line_ids(lines: &[String], method: &str) -> Vec<RpcId> {
    lines
        .iter()
        .filter_map(|line| {
            let value = ace_json::parse(line).ok()?;
            if value.get("method").and_then(Value::as_str) != Some(method) {
                return None;
            }
            match value.get("id") {
                Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
                Some(Value::Number(number)) => number.as_f64().map(RpcId::Number),
                _ => None,
            }
        })
        .collect()
}

/// A host with no child whose handshake completed: every effect stays with
/// the caller, so the order of settlements and exits is exactly what the host
/// published.
pub(super) fn bare(shared: bool) -> Shell {
    let config = if shared {
        HostConfig::shared(initialize(), 60_000.0)
    } else {
        HostConfig::dedicated(initialize())
    };
    bare_with(config)
}

/// A host with no child over the given config, its handshake completed.
pub(super) fn bare_with(config: HostConfig) -> Shell {
    let shell = Shell::start(config);
    let (_, lines) = shell.pump(|| {});
    let id = line_id(&lines, "initialize", None).expect("the handshake was sent");
    let (_, _) = shell.pump(|| {
        shell
            .host
            .line(&reply(&id, ace_json::json!({"userAgent": "fake"})));
    });
    shell
}

/// One frame as the app-server would write it.
pub(super) fn frame(value: Value) -> String {
    ace_json::to_string(&value)
}

pub(super) fn effects(run: &HostRun) -> Vec<Event> {
    run.events.snapshot()
}

pub(super) fn run_stop(name: &str, shared: bool, stop: crate::session::harness::Stop) -> HostRun {
    let config = if shared {
        HostConfig::shared(initialize(), 1_000.0)
    } else {
        HostConfig::dedicated(initialize())
    };
    HostRun::start_with(Scratch::new(name), config, CODEX_ELISION, None, stop)
}

/// Waits until the host's process has ended.
pub(super) fn wait_gone(run: &HostRun) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if run.host.gone() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    false
}

pub(super) fn retires(run: &HostRun) -> Vec<Event> {
    effects(run)
        .into_iter()
        .filter(|event| matches!(event, Event::Retire { .. }))
        .collect()
}

/// A reply the app-server would write for `id`.
pub(super) fn reply(id: &RpcId, result: Value) -> String {
    let mut map = ace_json::Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_to_value(id));
    map.insert("result", result);
    frame(Value::Object(map))
}

/// How many frames one channel was given for `thread`.
pub(super) fn seen_for(
    events: &crate::session::harness::Events,
    tenant: u64,
    thread: &str,
) -> usize {
    events
        .snapshot()
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::Frame {
                    tenant: who,
                    dir: ace_supervisor::peer::Direction::Recv,
                    data,
                } if *who == tenant
                        && data
                            .get("params")
                            .and_then(|params| params.get("threadId"))
                            .and_then(Value::as_str)
                            == Some(thread)
            )
        })
        .count()
}

/// Claims `thread` for `tenant` on a host with no child.
pub(super) fn claim_thread(host: &Shell, tenant: u64, thread: &str) {
    let (_, lines) = host.pump(|| {
        host.request(
            tenant,
            "thread/resume",
            Some(&ace_json::json!({"threadId": thread})),
            tenant,
            Timeout::Default,
        )
        .expect("the open is queued");
    });
    let opening = line_id(&lines, "thread/resume", Some(thread)).expect("the open's id");
    let _ = host.pump(|| {
        host.line(&reply(
            &opening,
            ace_json::json!({"thread": {"id": thread}}),
        ));
    });
}

/// Claims `thread` and records a running turn for it, so a close interrupts.
pub(super) fn busy_thread(host: &Shell, tenant: u64, thread: &str) {
    claim_thread(host, tenant, thread);
    let _ = host.pump(|| {
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "turn/started",
            "params": {"threadId": thread, "turn": {"id": "turn-1"}},
        })));
    });
}

/// `host.ts:226`–`:234`: shared output pauses while any channel is out of
/// room, and the last resume releases it.
#[test]
fn shared_output_pauses_while_any_channel_is_out_of_room() {
    let gate = HostGate::new();
    assert!(!gate.paused());
    gate.set_paused(1, true);
    assert!(gate.paused());
    gate.set_paused(2, true);
    gate.set_paused(1, false);
    assert!(gate.paused(), "one channel still has no room");
    gate.set_paused(2, false);
    assert!(!gate.paused());
    // A channel that leaves stops holding the others back.
    gate.set_paused(3, true);
    gate.release(3);
    assert!(!gate.paused());
}

/// `host.ts:226`–`:234` over both pipes: a pause stops what the child writes
/// once the read-ahead is spent, and the last resume starts both again.
#[test]
fn a_paused_channel_stops_both_pipes_and_a_resume_restarts_them() {
    let run = crate::session::harness::GateRun::start(Scratch::new("gate-pause"));
    assert!(run.wait_for(512 * 1024), "both pipes deliver");

    run.gate.set_paused(1, true);
    let (out0, err0) = run.bytes();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out1, err1) = run.bytes();
    assert!(
        out1 - out0 <= PAUSED_SLACK && err1 - err0 <= PAUSED_SLACK,
        "a pause stops both pumps: stdout +{}, stderr +{}",
        out1 - out0,
        err1 - err0
    );

    run.gate.set_paused(1, false);
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out2, err2) = run.bytes();
    assert!(
        out2 - out1 >= FLOWING_BYTES && err2 - err1 >= FLOWING_BYTES,
        "a resume restarts both pumps: stdout +{}, stderr +{}",
        out2 - out1,
        err2 - err1
    );
    run.stop();
}

/// A publication backlog stops both pumps the way a full channel does, and
/// the pumps read on when it drains: a stalled sink never reads the child's
/// output into an unbounded queue (`actor.ts:84`–`:103`).
#[test]
fn a_publication_backlog_stops_both_pipes_until_it_drains() {
    let run = crate::session::harness::GateRun::start(Scratch::new("gate-backlog"));
    assert!(run.wait_for(512 * 1024), "both pipes deliver");

    run.gate.set_backlog(true);
    assert!(
        run.gate.paused(),
        "a backlog past its budget holds the pumps"
    );
    let (out0, err0) = run.bytes();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out1, err1) = run.bytes();
    assert!(
        out1 - out0 <= PAUSED_SLACK && err1 - err0 <= PAUSED_SLACK,
        "a backlog stops both pumps: stdout +{}, stderr +{}",
        out1 - out0,
        err1 - err0
    );

    run.gate.set_backlog(false);
    assert!(!run.gate.paused());
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out2, err2) = run.bytes();
    assert!(
        out2 - out1 >= FLOWING_BYTES && err2 - err1 >= FLOWING_BYTES,
        "the drain restarts both pumps: stdout +{}, stderr +{}",
        out2 - out1,
        err2 - err1
    );
    run.stop();
}

/// A close that starts while a channel is paused must not stall the drain:
/// the gate stops honouring pauses and both pipes read on (`retire`, `:379`).
#[test]
fn a_drain_lets_a_paused_hosts_pipes_finish() {
    let run = crate::session::harness::GateRun::start(Scratch::new("gate-drain"));
    assert!(run.wait_for(512 * 1024));

    run.gate.set_paused(1, true);
    let (out0, err0) = run.bytes();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out1, err1) = run.bytes();
    assert!(
        out1 - out0 <= PAUSED_SLACK && err1 - err0 <= PAUSED_SLACK,
        "the pause holds: stdout +{}, stderr +{}",
        out1 - out0,
        err1 - err0
    );

    run.gate.drain();
    assert!(!run.gate.paused(), "a draining gate never pauses");
    assert!(run.gate.draining());
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out2, err2) = run.bytes();
    assert!(
        out2 - out1 >= FLOWING_BYTES && err2 - err1 >= FLOWING_BYTES,
        "a drain reads on past a pause: stdout +{}, stderr +{}",
        out2 - out1,
        err2 - err1
    );
    // A pause that arrives during the drain changes nothing.
    run.gate.set_paused(1, true);
    assert!(!run.gate.paused());
    run.stop();
}

/// A close whose stop failed leaves a live host: backpressure works again
/// afterwards, on both pipes (porting guide E3.0c step 2, `undrain`).
#[test]
fn a_failed_stop_restores_backpressure_on_both_pipes() {
    let run = crate::session::harness::GateRun::start(Scratch::new("gate-undrain"));
    assert!(run.wait_for(512 * 1024), "both pipes deliver");

    run.gate.drain();
    assert!(run.gate.draining());
    // The stop failed: the host survives, so the drain is cleared.
    run.gate.undrain();
    assert!(!run.gate.draining(), "a surviving host is not draining");

    run.gate.set_paused(1, true);
    assert!(run.gate.paused(), "backpressure applies again");
    let (out0, err0) = run.bytes();
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out1, err1) = run.bytes();
    assert!(
        out1 - out0 <= PAUSED_SLACK && err1 - err0 <= PAUSED_SLACK,
        "both pumps pause again: stdout +{}, stderr +{}",
        out1 - out0,
        err1 - err0
    );

    run.gate.set_paused(1, false);
    std::thread::sleep(std::time::Duration::from_millis(400));
    let (out2, err2) = run.bytes();
    assert!(
        out2 - out1 >= FLOWING_BYTES && err2 - err1 >= FLOWING_BYTES,
        "and both resume: stdout +{}, stderr +{}",
        out2 - out1,
        err2 - err1
    );
    run.stop();
}
