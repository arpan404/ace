use std::sync::Arc;

use ace_json::Value;
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::Timeout;

use super::super::*;
use super::*;
use crate::session::harness::{Event, Recorder};
use crate::session::pool::initialize;

/// An unowned thread's frames wait for its ancestry instead of reaching a
/// channel that never opened it, and the read that decides is the host's own.
#[test]
fn an_unknown_route_is_held_for_its_ancestry_rather_than_guessed() {
    let run = run("unknown-route", true);
    // With one channel alone, every unowned frame is that channel's: the
    // ancestry walk only exists to tell neighbours apart.
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let line = ace_json::to_string(&ace_json::json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": "someone-elses",
            "turnId": "turn-x",
            "item": {"type": "agentMessage", "id": "m", "text": "hello"},
        },
    }));
    run.host.line(&line);

    // The read is the host's own request: it is written, and no channel sees
    // it as a frame of its own.
    assert!(
        run.events.satisfies(5_000, |log| {
            log.iter()
                .filter(|event| matches!(event, Event::Wrote { .. }))
                .count()
                >= 3
        }),
        "the host reads Codex's own record to find an owner"
    );
    for tenant in [1, 2] {
        assert!(
            !run.frames(tenant).iter().any(|data| data
                .get("params")
                .and_then(|params| params.get("threadId"))
                .and_then(Value::as_str)
                == Some("someone-elses")),
            "an unowned thread's frames never reach a channel"
        );
    }
    run.stop();
}

/// A message that names a thread the host already released is dropped, and a
/// name for an unloaded thread never claims one.
#[test]
fn a_released_threads_late_frames_reach_no_channel() {
    let run = run("released", true);
    let _ = run.attach(1);
    assert!(run.wait_ready(1));

    let line = ace_json::to_string(&ace_json::json!({
        "jsonrpc": "2.0",
        "method": "thread/name/updated",
        "params": {"threadId": "never-opened", "name": "elsewhere"},
    }));
    run.host.line(&line);
    assert!(!run.frames(1).iter().any(|data| {
        data.get("params")
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str)
            == Some("never-opened")
    }),);
    run.stop();
}

/// The malformed and stderr lines a shared process writes reach every
/// channel, and neither ends the host.
#[test]
fn shared_diagnostics_reach_every_channel_without_ending_the_host() {
    let run = run("diagnostics", true);
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    run.host.line("not json");
    run.host.stderr_line("mcp server says hello");

    for tenant in [1, 2] {
        assert!(
            run.events.until(5_000, |event| matches!(
                event,
                Event::Malformed { tenant: who, .. } if *who == tenant
            )),
            "tenant {tenant} hears the malformed line"
        );
        assert!(run.events.until(5_000, |event| matches!(
            event,
            Event::Stderr { tenant: who, .. } if *who == tenant
        )));
    }
    assert!(run.host.available());
    run.stop();
}

/// The frames a tenant marks unadmitted stop its translation, and a server
/// request can still be answered afterwards so the tree can be stopped.
#[test]
fn a_frame_a_channel_does_not_admit_mutes_it_without_stopping_the_peer() {
    let run = run("muted", true);
    struct Muted {
        events: Arc<crate::session::harness::Events>,
    }
    impl ChannelHandlers for Muted {
        fn admit(&self, _dir: ace_supervisor::peer::Direction, _data: &Value) -> Admission {
            Admission::Failed("translation broke".to_owned())
        }
        fn frame(&self, _dir: ace_supervisor::peer::Direction, _data: &Value) {}
        fn notification(&self, _method: &ace_json::JsString, _params: Option<&Value>) {}
        fn request(
            &self,
            _id: &ace_supervisor::jsonrpc::RpcId,
            _method: &ace_json::JsString,
            _params: Option<&Value>,
        ) -> RequestAnswer {
            RequestAnswer::Answered(ace_json::json!({}))
        }
        fn dropped(&self, _line: &DroppedLine) {}
        fn output_uncertain(&self) {}
        fn malformed(&self, _line: &str) {}
        fn stderr(&self, _line: &str) {}
        fn error(&self, _message: &str) {}
        fn failed(&self, message: &str) {
            self.events.push(Event::AdmissionFailed {
                tenant: 7,
                message: message.to_owned(),
            });
        }
        fn exited(&self, _exit: &HostExit) {}
        fn ready(&self) {}
    }
    let handler = Arc::new(Muted {
        events: Arc::clone(&run.events),
    });
    run.attach_handler(7, handler as Arc<dyn ChannelHandlers>);
    assert!(run.wait_ready(7));

    run.host.line(&ace_json::to_string(&ace_json::json!({
        "jsonrpc": "2.0",
        "method": "thread/started",
        "params": {"thread": {"id": "t"}},
    })));
    assert!(run.events.until(5_000, |event| matches!(
        event,
        Event::AdmissionFailed { tenant: 7, .. }
    )));
    // The peer is still reading: a second frame reports the same failure once.
    let failed = effects(&run)
        .into_iter()
        .filter(|event| matches!(event, Event::AdmissionFailed { .. }))
        .count();
    assert_eq!(failed, 1, "a muted channel hears one failure");
    assert!(!run.host.gone());
    run.stop();
}

/// `host.ts:466`: a reply the framing layer dropped settles its request once,
/// as the error the caller waits on, and the channel hears about the drop.
#[test]
fn a_dropped_reply_settles_its_request_once_and_reports_the_drop() {
    let host = Shell::start(HostConfig::shared(initialize(), 1_000.0));
    // No child here: the shell acknowledges the `initialize` write, which hands
    // out the next line.
    let _ = host.pump(|| {});
    let events = Arc::new(crate::session::harness::Events::default());
    host.attach(1, Recorder::new(1, Arc::clone(&events)))
        .expect("a channel attaches before the handshake");
    let (_, lines) = host.pump(|| {
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "owned"})),
            7,
            Timeout::After(1_000.0),
        )
        .expect("the request is queued");
    });
    let sent = lines
        .iter()
        .find(|line| line.contains("thread/read"))
        .expect("the request was written");
    let wire_id = ace_json::parse(sent)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_f64))
        .map(RpcId::Number)
        .expect("the wire id");

    // The owner first, so the dropped line can be attributed to it.
    let _ = host.pump(|| {
        host.line(&ace_json::to_string(&ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/started",
            "params": {"thread": {"id": "owned"}},
        })));
    });
    let (effects, _) = host.pump(|| {
        host.dropped(&DroppedLine {
            bytes: 20_000_000,
            phase: DroppedPhase::Line,
            attributed: crate::session::dropped::LineAttribution {
                id: Some(wire_id),
                thread_id: Some(ace_json::JsString::from("owned")),
                response: true,
            },
        });
    });
    let settles: Vec<&HostEffect> = effects
        .iter()
        .filter(|effect| matches!(effect, HostEffect::Settle { id: 7, .. }))
        .collect();
    assert_eq!(settles.len(), 1, "the caller's promise settles once");
    assert!(matches!(
        settles[0],
        HostEffect::Settle { result: Err(_), .. }
    ));
    assert!(
        !events
            .snapshot()
            .iter()
            .any(|event| matches!(event, Event::Uncertain { .. })),
        "a rejected request is not also uncertain"
    );
    assert!(events.snapshot().iter().any(|event| matches!(
        event,
        Event::Dropped {
            tenant: 1,
            bytes: 20_000_000
        }
    )));
}

/// A channel that refuses an outgoing frame over the frame bound, and nothing
/// else: the session's own admission, as a test double.
struct Bound {
    /// Server requests it holds for an answer, in order.
    deferred: std::sync::Mutex<Vec<RpcId>>,
    /// The errors the host reported to it.
    errors: std::sync::Mutex<Vec<String>>,
    /// The messages it was failed with.
    failed: std::sync::Mutex<Vec<String>>,
}

impl Bound {
    fn new() -> Arc<Bound> {
        Arc::new(Bound {
            deferred: std::sync::Mutex::new(Vec::new()),
            errors: std::sync::Mutex::new(Vec::new()),
            failed: std::sync::Mutex::new(Vec::new()),
        })
    }

    fn failed(&self) -> Vec<String> {
        self.failed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn errors(&self) -> Vec<String> {
        self.errors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn deferred(&self) -> Vec<RpcId> {
        self.deferred
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }
}

impl ChannelHandlers for Bound {
    fn admit(&self, dir: Direction, data: &Value) -> Admission {
        let encoded = ace_json::to_string(data);
        if dir == Direction::Send && encoded.len() > crate::session::frames::MAX_PAYLOAD_BYTES {
            return Admission::Failed("Provider payload exceeds byte limit".to_owned());
        }
        // A received frame with `mute` mutes this channel.
        if dir == Direction::Recv
            && data.pointer("/params/mute").and_then(Value::as_bool) == Some(true)
        {
            return Admission::Failed("received frame refused".to_owned());
        }
        Admission::Taken
    }
    fn frame(&self, _dir: Direction, _data: &Value) {}
    fn notification(&self, _method: &ace_json::JsString, _params: Option<&Value>) {}
    fn request(
        &self,
        id: &RpcId,
        _method: &ace_json::JsString,
        _params: Option<&Value>,
    ) -> RequestAnswer {
        self.deferred
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(id.clone());
        RequestAnswer::Deferred
    }
    fn dropped(&self, _line: &DroppedLine) {}
    fn output_uncertain(&self) {}
    fn malformed(&self, _line: &str) {}
    fn stderr(&self, _line: &str) {}
    fn error(&self, message: &str) {
        self.errors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(message.to_owned());
    }
    fn failed(&self, message: &str) {
        self.failed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(message.to_owned());
    }
    fn exited(&self, _exit: &HostExit) {}
    fn ready(&self) {}
}

/// One host with a channel attached, its handshake acknowledged.
fn bound_shell(config: HostConfig) -> (Shell, Arc<Bound>) {
    let host = Shell::start(config);
    let _ = host.pump(|| {});
    let handlers = Bound::new();
    host.attach(1, handlers.clone())
        .expect("a channel attaches");
    let _ = host.pump(|| {});
    (host, handlers)
}

fn writes(effects: &[HostEffect]) -> Vec<u64> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            HostEffect::Write { ticket, .. } => Some(*ticket),
            _ => None,
        })
        .collect()
}

fn settlements(effects: &[HostEffect]) -> Vec<u64> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            HostEffect::Settle { id, .. } => Some(*id),
            _ => None,
        })
        .collect()
}

/// A request whose frame the bound refuses.
fn oversized() -> Value {
    ace_json::json!({"threadId": "t1", "instructions": "x".repeat(2_000_000)})
}

fn small(thread: &str) -> Value {
    ace_json::json!({"threadId": thread})
}

/// `session.ts:153`-`:156`, `jsonrpc.ts:291`-`:292`: a frame the bound refuses
/// never reaches the wire, and its call fails with the bound's error.
#[test]
fn a_refused_outgoing_frame_is_never_written_and_fails_its_call() {
    let (host, _) = bound_shell(HostConfig::dedicated(initialize()));
    let (effects, lines) = host.pump(|| {
        host.request(
            1,
            "turn/start",
            Some(&oversized()),
            7,
            Timeout::After(1_000.0),
        )
        .expect("the request is refused, not thrown");
    });
    assert!(
        !lines.iter().any(|line| line.contains("turn/start")),
        "nothing reached the wire"
    );
    assert_eq!(settlements(&effects), vec![7], "the call settles once");
    assert!(matches!(
        effects
            .iter()
            .find(|effect| matches!(effect, HostEffect::Settle { .. })),
        Some(HostEffect::Settle { result: Err(_), .. })
    ));
    assert!(!effects.iter().any(|effect| matches!(
        effect,
        HostEffect::ArmTimer { .. } | HostEffect::Write { .. }
    )));
}

/// A refused request leaves the pipe whole: an idle writer takes the next
/// normal request, and acknowledges it.
#[test]
fn a_refused_request_with_an_idle_writer_is_followed_by_a_written_request() {
    let (host, _) = bound_shell(HostConfig::dedicated(initialize()));
    let (refused, lines) = host.pump(|| {
        host.request(
            1,
            "turn/start",
            Some(&oversized()),
            7,
            Timeout::After(1_000.0),
        )
        .expect("the request is refused, not thrown");
    });
    assert!(lines.is_empty());
    assert_eq!(settlements(&refused), vec![7]);
    let (first, lines) = host.pump(|| {
        host.request(
            1,
            "thread/read",
            Some(&small("t1")),
            8,
            Timeout::After(1_000.0),
        )
        .expect("the request is queued");
    });
    assert_eq!(lines.len(), 1, "the next request is written");
    assert!(settlements(&first).is_empty());
    let (second, lines) = host.pump(|| {
        host.request(
            1,
            "thread/read",
            Some(&small("t2")),
            9,
            Timeout::After(1_000.0),
        )
        .expect("the request is queued");
    });
    assert_eq!(lines.len(), 1, "the writer kept moving");
    assert!(settlements(&second).is_empty());
}

/// The same with the writer holding an active, unacknowledged line.
#[test]
fn a_refused_request_with_a_busy_writer_leaves_the_pipe_moving() {
    let (host, _) = bound_shell(HostConfig::dedicated(initialize()));
    // One normal request whose write is never acknowledged: it is the active
    // line, and the writer is busy.
    host.request(
        1,
        "thread/read",
        Some(&small("t1")),
        7,
        Timeout::After(1_000.0),
    )
    .expect("the request is queued");
    let active = host.collect();
    let tickets = writes(&active);
    assert_eq!(tickets.len(), 1, "the first line is the active write");
    // A second normal request waits behind it.
    host.request(
        1,
        "thread/read",
        Some(&small("t2")),
        8,
        Timeout::After(1_000.0),
    )
    .expect("the request is queued");
    assert!(writes(&host.collect()).is_empty(), "the writer is busy");
    // The refused request allocates nothing, so it cannot take the claim.
    host.request(
        1,
        "turn/start",
        Some(&oversized()),
        9,
        Timeout::After(1_000.0),
    )
    .expect("the request is refused, not thrown");
    let refused = host.collect();
    assert!(writes(&refused).is_empty());
    assert_eq!(settlements(&refused), vec![9], "the call settles once");
    // The active line's acknowledgement still moves the queued one.
    host.written(tickets[0]);
    let moving = writes(&host.collect());
    assert_eq!(moving.len(), 1, "the queued line moved");
    host.written(moving[0]);
    assert!(writes(&host.collect()).is_empty());
}

/// `peer.rs:540`-`:548` and the bound: a full queue and an oversized frame each
/// settle their call exactly once, whichever comes first.
#[test]
fn a_full_queue_and_an_oversized_frame_each_settle_once() {
    let (host, _) = bound_shell(HostConfig {
        max_queued_bytes: Some(512),
        ..HostConfig::dedicated(initialize())
    });
    // Nothing is acknowledged, so the queue fills behind the active line.
    for id in 0..16 {
        host.request(1, "thread/read", Some(&small("t1")), id, Timeout::Disabled)
            .expect("queued or refused");
    }
    let filled = host.collect();
    assert!(
        !settlements(&filled).is_empty(),
        "the queue refused at least one call"
    );
    // An oversized frame is refused by the bound before the queue is touched.
    host.request(1, "turn/start", Some(&oversized()), 100, Timeout::Disabled)
        .expect("the request is refused, not thrown");
    let refused = host.collect();
    assert_eq!(settlements(&refused), vec![100], "one settlement");
    assert!(writes(&refused).is_empty());
    // A normal frame in the same full queue settles once, with the queue's own
    // refusal.
    host.request(1, "thread/read", Some(&small("t2")), 101, Timeout::Disabled)
        .expect("queued");
    let full = host.collect();
    assert_eq!(settlements(&full), vec![101], "one settlement");
    assert!(writes(&full).is_empty());
}

/// `host.ts:437`: an oversized answer to a server request is refused before the
/// peer claims a ticket, so the pipe keeps moving.
#[test]
fn an_oversized_answer_never_claims_a_ticket() {
    let (host, handlers) = bound_shell(HostConfig::dedicated(initialize()));
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/started",
            "params": {"thread": {"id": "t1"}},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "id": 900,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "t1", "turnId": "x", "itemId": "y"},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    assert_eq!(handlers.deferred(), vec![RpcId::Number(900.0)]);
    host.answer(
        &RpcId::Number(900.0),
        &ace_json::json!({"data": "x".repeat(2_000_000)}),
    );
    let refused = host.collect();
    assert!(writes(&refused).is_empty(), "the reply claimed no ticket");
    assert!(
        handlers
            .errors()
            .iter()
            .any(|message| message.contains("exceeds byte limit")),
        "the channel hears the refusal: {:?}",
        handlers.errors()
    );
    // The pipe still moves: the next answer is written and acknowledged.
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "id": 901,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "t1", "turnId": "x", "itemId": "y"},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    host.answer(&RpcId::Number(901.0), &ace_json::json!({}));
    let (_, lines) = host.pump(|| {});
    assert_eq!(lines.len(), 1, "the next answer reaches the wire");
}

/// `host.ts:126`, `:170`: a muted channel's requests still flow, so its tree
/// can be stopped, and its answer still reaches Codex. Neither reports an error.
#[test]
fn a_muted_channel_still_interrupts_and_answers() {
    let (host, handlers) = bound_shell(HostConfig::dedicated(initialize()));
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/started",
            "params": {"thread": {"id": "t1"}},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "id": 900,
            "method": "item/commandExecution/requestApproval",
            "params": {"threadId": "t1", "turnId": "x", "itemId": "y"},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    assert_eq!(handlers.deferred(), vec![RpcId::Number(900.0)]);
    // A received frame the channel refuses mutes it.
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/started",
            "params": {"thread": {"id": "t1"}, "mute": true},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    assert_eq!(handlers.failed(), vec!["received frame refused".to_owned()]);
    // An interrupt still reaches the wire, with no false refusal.
    let (effects, lines) = host.pump(|| {
        host.request(
            1,
            "turn/interrupt",
            Some(&ace_json::json!({"threadId": "t1", "turnId": "x"})),
            10,
            Timeout::Disabled,
        )
        .expect("the request is queued");
    });
    assert_eq!(lines.len(), 1, "the interrupt is written");
    assert!(!effects.iter().any(|effect| matches!(
        effect,
        HostEffect::Error { .. } | HostEffect::AdmissionFailed { .. }
    )));
    // And the pending approval's answer.
    host.answer(
        &RpcId::Number(900.0),
        &ace_json::json!({"decision": "accept"}),
    );
    let (effects, lines) = host.pump(|| {});
    assert_eq!(lines.len(), 1, "the answer is written");
    assert!(!effects.iter().any(|effect| matches!(
        effect,
        HostEffect::Error { .. } | HostEffect::AdmissionFailed { .. }
    )));
    assert!(handlers.errors().is_empty(), "{:?}", handlers.errors());
}

/// A handler whose translation broke refuses every frame, sends included. The
/// host has muted it, so its requests still flow and its tree can be stopped
/// (`host.ts:126`).
#[test]
fn a_channel_that_refuses_every_frame_still_interrupts() {
    struct Broken {
        /// Set the first time the host fails a frame: every later frame is
        /// refused, whatever its direction.
        broken: std::sync::atomic::AtomicBool,
    }
    impl ChannelHandlers for Broken {
        fn admit(&self, dir: Direction, data: &Value) -> Admission {
            if dir == Direction::Recv
                && data.pointer("/params/mute").and_then(Value::as_bool) == Some(true)
            {
                return Admission::Failed("translation broke".to_owned());
            }
            if self.broken.load(std::sync::atomic::Ordering::SeqCst) {
                return Admission::Failed("translation broke".to_owned());
            }
            Admission::Taken
        }
        fn frame(&self, _dir: Direction, _data: &Value) {}
        fn notification(&self, _method: &ace_json::JsString, _params: Option<&Value>) {}
        fn request(
            &self,
            _id: &RpcId,
            _method: &ace_json::JsString,
            _params: Option<&Value>,
        ) -> RequestAnswer {
            RequestAnswer::Answered(ace_json::json!({}))
        }
        fn dropped(&self, _line: &DroppedLine) {}
        fn output_uncertain(&self) {}
        fn malformed(&self, _line: &str) {}
        fn stderr(&self, _line: &str) {}
        fn error(&self, _message: &str) {}
        fn failed(&self, _message: &str) {
            self.broken.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        fn exited(&self, _exit: &HostExit) {}
        fn ready(&self) {}
    }
    let host = Shell::start(HostConfig::dedicated(initialize()));
    let _ = host.pump(|| {});
    let handler = Arc::new(Broken {
        broken: std::sync::atomic::AtomicBool::new(false),
    });
    host.attach(1, handler.clone()).expect("a channel attaches");
    let _ = host.pump(|| {});
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/started",
            "params": {"thread": {"id": "t1"}},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    // A received frame fails admission: the host mutes the channel, its
    // handler breaks, and every later frame would be refused.
    host.line(
        &ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/started",
            "params": {"thread": {"id": "t1"}, "mute": true},
        })
        .to_json(),
    );
    let _ = host.pump(|| {});
    assert!(
        handler.broken.load(std::sync::atomic::Ordering::SeqCst),
        "the failed frame breaks the handler"
    );
    let (effects, lines) = host.pump(|| {
        host.request(
            1,
            "turn/interrupt",
            Some(&ace_json::json!({"threadId": "t1", "turnId": "x"})),
            10,
            Timeout::Disabled,
        )
        .expect("the request is queued");
    });
    assert_eq!(lines.len(), 1, "the interrupt is written");
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::Error { .. } | HostEffect::Settle { .. }))
    );
}

/// `host.rs:233`: admission is decided once per frame, by the veto, and the
/// delivery uses that verdict. A handler that answers differently the second
/// time is not asked again.
#[test]
fn a_send_frame_is_admitted_once() {
    struct Once {
        admits: std::sync::atomic::AtomicUsize,
    }
    impl ChannelHandlers for Once {
        fn admit(&self, dir: Direction, data: &Value) -> Admission {
            let ours = dir == Direction::Send
                && data.get("method").and_then(Value::as_str) == Some("thread/read");
            if ours {
                let count = self
                    .admits
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if count >= 1 {
                    return Admission::Failed("admitted twice".to_owned());
                }
            }
            Admission::Taken
        }
        fn frame(&self, _dir: Direction, _data: &Value) {}
        fn notification(&self, _method: &ace_json::JsString, _params: Option<&Value>) {}
        fn request(
            &self,
            _id: &RpcId,
            _method: &ace_json::JsString,
            _params: Option<&Value>,
        ) -> RequestAnswer {
            RequestAnswer::Answered(ace_json::json!({}))
        }
        fn dropped(&self, _line: &DroppedLine) {}
        fn output_uncertain(&self) {}
        fn malformed(&self, _line: &str) {}
        fn stderr(&self, _line: &str) {}
        fn error(&self, _message: &str) {}
        fn failed(&self, _message: &str) {}
        fn exited(&self, _exit: &HostExit) {}
        fn ready(&self) {}
    }
    let host = Shell::start(HostConfig::dedicated(initialize()));
    let _ = host.pump(|| {});
    let handler = Arc::new(Once {
        admits: std::sync::atomic::AtomicUsize::new(0),
    });
    host.attach(1, handler.clone()).expect("a channel attaches");
    let _ = host.pump(|| {});
    let (effects, lines) = host.pump(|| {
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "t1"})),
            7,
            Timeout::After(1_000.0),
        )
        .expect("the request is queued");
    });
    assert_eq!(lines.len(), 1, "the frame is written");
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::AdmissionFailed { .. })),
        "the veto's verdict stands: {effects:#?}"
    );
}

/// `host.ts:469`-`:473`: only a dropped *reply* rejects a pending call. A
/// server request that reuses a client call's numeric id is not that reply.
#[test]
fn a_dropped_server_request_never_rejects_a_client_call_with_the_same_id() {
    let host = Shell::start(HostConfig::shared(initialize(), 1_000.0));
    let _ = host.pump(|| {});
    let events = Arc::new(crate::session::harness::Events::default());
    host.attach(1, Recorder::new(1, Arc::clone(&events)))
        .expect("a channel attaches before the handshake");
    let (_, lines) = host.pump(|| {
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "owned"})),
            7,
            Timeout::After(1_000.0),
        )
        .expect("the request is queued");
    });
    let sent = lines
        .iter()
        .find(|line| line.contains("thread/read"))
        .expect("the request was written");
    let wire_id = ace_json::parse(sent)
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_f64))
        .map(RpcId::Number)
        .expect("the wire id");
    let (effects, _) = host.pump(|| {
        host.dropped(&DroppedLine {
            bytes: 20_000_000,
            phase: DroppedPhase::Line,
            // A request, not a reply, that happens to carry the same id.
            attributed: crate::session::dropped::LineAttribution {
                id: Some(wire_id),
                thread_id: None,
                response: false,
            },
        });
    });
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::Settle { id: 7, .. })),
        "the client call keeps its own settlement"
    );
    assert!(events.snapshot().iter().any(|event| matches!(
        event,
        Event::Dropped {
            tenant: 1,
            bytes: 20_000_000
        }
    )));
}

/// `foreign`: a thread another channel owns is not this channel's to claim,
/// and neither is one a channel let go.
#[test]
fn a_thread_is_foreign_to_every_channel_but_its_owner() {
    let host = bare_with(HostConfig::shared(initialize(), 60_000.0));
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    let _ = host.attach(2, Recorder::new(2, Arc::clone(&events)));

    let _ = host.pump(|| {
        host.request(
            1,
            "thread/start",
            Some(&ace_json::json!({"cwd": "/tmp"})),
            5,
            Timeout::After(1_000.0),
        )
        .expect("the open is queued");
    });
    let wire = events
        .snapshot()
        .into_iter()
        .find_map(|event| match event {
            Event::Frame {
                tenant: 1,
                dir: ace_supervisor::peer::Direction::Send,
                data,
            } if data.get("method").and_then(Value::as_str) == Some("thread/start") => {
                data.get("id").and_then(Value::as_f64).map(RpcId::Number)
            }
            _ => None,
        })
        .expect("the open's wire id");
    let _ = host.pump(|| host.line(&reply(&wire, ace_json::json!({"thread": {"id": "open"}}))));

    let open = ace_json::JsString::from("open");
    assert!(!host.foreign(1, &open), "a channel's own thread");
    assert!(host.foreign(2, &open), "another channel's thread");
    assert!(!host.foreign(2, &ace_json::JsString::from("unknown")));

    let (_, lines) = host.pump(|| host.detach(1, Retirement::User, "user closed"));
    // A leaving channel still owns its thread until its unsubscribe lands.
    assert!(!host.foreign(1, &open));
    let list = line_id(&lines, "thread/backgroundTerminals/list", Some("open"))
        .expect("the terminals are read first");
    let (_, lines) = host.pump(|| {
        host.line(&reply(
            &list,
            ace_json::json!({"data": [], "nextCursor": null}),
        ))
    });
    let unsub = line_id(&lines, "thread/unsubscribe", Some("open")).expect("the unsubscribe");
    let (_, _) =
        host.pump(|| host.line(&reply(&unsub, ace_json::json!({"status": "unsubscribed"}))));
    assert!(
        host.foreign(1, &open),
        "a released thread is never evidence of a new owner"
    );
    assert!(host.foreign(2, &open));
}

/// A request whose frame the only channel did not admit is refused, not
/// dispatched (`#request` throws `Unsupported Codex request`).
#[test]
fn a_request_whose_frame_was_not_admitted_is_refused() {
    struct Unadmitting {
        events: Arc<crate::session::harness::Events>,
    }
    impl ChannelHandlers for Unadmitting {
        fn admit(&self, _dir: ace_supervisor::peer::Direction, _data: &Value) -> Admission {
            Admission::Failed("translation broke".to_owned())
        }
        fn frame(&self, _dir: ace_supervisor::peer::Direction, _data: &Value) {}
        fn notification(&self, _method: &ace_json::JsString, _params: Option<&Value>) {}
        fn request(
            &self,
            id: &RpcId,
            method: &ace_json::JsString,
            params: Option<&Value>,
        ) -> RequestAnswer {
            self.events.push(Event::Request {
                tenant: 9,
                id: id.clone(),
                method: method.clone(),
                params: params.cloned(),
            });
            RequestAnswer::Answered(ace_json::json!({}))
        }
        fn dropped(&self, _line: &DroppedLine) {}
        fn output_uncertain(&self) {}
        fn malformed(&self, _line: &str) {}
        fn stderr(&self, _line: &str) {}
        fn error(&self, _message: &str) {}
        fn failed(&self, _message: &str) {}
        fn exited(&self, _exit: &HostExit) {}
        fn ready(&self) {}
    }
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let handler = Arc::new(Unadmitting {
        events: Arc::clone(&events),
    });
    host.attach(9, handler as Arc<dyn ChannelHandlers>)
        .expect("the channel attaches");

    // A request naming no thread or turn, with one channel that cannot take it.
    let (_, lines) = host.pump(|| {
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": "ask-1",
            "method": "mcpServer/elicitation/request",
            "params": {"serverName": "docs", "mode": "form"},
        })))
    });
    assert!(
        !events
            .snapshot()
            .iter()
            .any(|event| matches!(event, Event::Request { .. })),
        "the request is never dispatched"
    );
    assert!(
        lines
            .iter()
            .any(|line| line.contains("Unsupported Codex request")),
        "and it is refused as TS does: {lines:?}"
    );
}

/// One decoded received frame is shared by every tenant: the publication
/// carries the same `Arc`, never a per-recipient clone.
#[test]
fn one_received_frame_is_shared_by_every_tenant() {
    let run = run("shared-value", true);
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));
    let shared = run.host.input(|inner| {
        let data = Arc::new(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "account/rateLimits/updated",
            "params": {},
        }));
        inner.broadcast_init(ace_supervisor::peer::Direction::Recv, &data);
        let frames: Vec<Arc<Value>> = inner
            .out
            .iter()
            .filter_map(|effect| match effect {
                HostEffect::Frame { data, .. } => Some(Arc::clone(data)),
                _ => None,
            })
            .collect();
        frames.len() == 2 && Arc::ptr_eq(&frames[0], &frames[1])
    });
    assert!(shared, "each tenant was handed its own copy");
    run.stop();
}
