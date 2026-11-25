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
        fn frame(&self, _dir: ace_supervisor::peer::Direction, _data: &Value) -> Admission {
            Admission::Failed("translation broke".to_owned())
        }
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
    run.host
        .attach(7, handler as Arc<dyn ChannelHandlers>)
        .expect("the host accepts a channel");
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
            thread: Some(ace_json::JsString::from("owned")),
            response: Some(wire_id),
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
        fn frame(&self, _dir: ace_supervisor::peer::Direction, _data: &Value) -> Admission {
            Admission::Failed("translation broke".to_owned())
        }
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
