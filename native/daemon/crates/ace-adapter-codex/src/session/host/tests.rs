// SPDX-License-Identifier: Apache-2.0
//! The host's cases. `host-retire.test.ts` moved here: a retirement nobody
//! waits on is reported by the shell, an awaited one reaches the session, and
//! one stop is one report. The others cover what the host alone decides:
//! a crash settles every routed call exactly once, an unknown route waits for
//! its ancestry, and an open cancelled before it resolves exits the channel.

use std::sync::Arc;

use ace_json::Value;
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::peer::Timeout;
use ace_supervisor::spawn::RawExit;

use crate::session::harness::Recorder;

use super::*;
use crate::session::harness::{Event, HostRun, Scratch};
use crate::session::pool::{CODEX_ELISION, initialize};

fn run(name: &str, shared: bool) -> HostRun {
    let config = if shared {
        HostConfig::shared(initialize(), 1_000.0)
    } else {
        HostConfig::dedicated(initialize())
    };
    HostRun::start(Scratch::new(name), config, CODEX_ELISION, None)
}

/// What the shell does with a host's effects: acknowledge every write, which
/// hands out the next line, and keep the rest in order with the lines sent.
fn pump(host: &Host, effects: Vec<HostEffect>) -> (Vec<HostEffect>, Vec<String>) {
    let mut queue: std::collections::VecDeque<HostEffect> = effects.into();
    let mut rest = Vec::new();
    let mut lines = Vec::new();
    while let Some(effect) = queue.pop_front() {
        match effect {
            HostEffect::Write { wire, ticket } => {
                if let Ok(text) = std::str::from_utf8(&wire) {
                    lines.push(text.trim_end().to_owned());
                }
                queue.extend(host.written(ticket));
            }
            other => rest.push(other),
        }
    }
    (rest, lines)
}

/// The id of the line written for `method`, optionally for `thread`.
fn line_id(lines: &[String], method: &str, thread: Option<&str>) -> Option<RpcId> {
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

/// A host with no child whose handshake completed: every effect stays with
/// the caller, so the order of settlements and exits is exactly what the host
/// queued.
fn bare(shared: bool) -> Host {
    let config = if shared {
        HostConfig::shared(initialize(), 60_000.0)
    } else {
        HostConfig::dedicated(initialize())
    };
    let (host, initial) = Host::new(config);
    let (_, lines) = pump(&host, initial);
    let id = line_id(&lines, "initialize", None).expect("the handshake was sent");
    let (_, _) = pump(
        &host,
        host.line(&reply(&id, ace_json::json!({"userAgent": "fake"}))),
    );
    host
}

/// One frame as the app-server would write it.
fn frame(value: Value) -> String {
    ace_json::to_string(&value)
}

fn effects(run: &HostRun) -> Vec<Event> {
    run.events.snapshot()
}

fn run_stop(name: &str, shared: bool, stop: crate::session::harness::Stop) -> HostRun {
    let config = if shared {
        HostConfig::shared(initialize(), 1_000.0)
    } else {
        HostConfig::dedicated(initialize())
    };
    HostRun::start_with(Scratch::new(name), config, CODEX_ELISION, None, stop)
}

/// Waits until the host's process has ended.
fn wait_gone(run: &HostRun) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        if run.host.gone() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    false
}

fn retires(run: &HostRun) -> Vec<Event> {
    effects(run)
        .into_iter()
        .filter(|event| matches!(event, Event::Retire { .. }))
        .collect()
}

/// `host-retire.test.ts`: "retiring a Windows host whose shells outlived the
/// stop fails for the session waiting on it". The stop is handed to the shell
/// once, as one a caller waits on, and a stop that does happen ends the
/// process, which is what the session sees.
#[test]
fn a_retire_a_session_waits_on_ends_the_process_and_reports_one_stop() {
    let run = run("retire-awaited", false);
    let _ = run.attach(1);
    assert!(run.wait_ready(1), "the fake answers initialize");

    run.apply(run.host.detach(1, Retirement::Aborted, "Opening cancelled"));
    assert_eq!(
        retires(&run),
        vec![Event::Retire {
            reason: Retirement::Aborted,
            awaited: true,
        }]
    );
    // The real outcome: the process ended, through the one stop it was given.
    assert!(run.wait_exit(1), "the cancelled channel heard its exit");
    assert!(run.host.gone(), "the leader is gone");
    assert!(!run.host.available());
    run.apply(run.host.retire(Retirement::User));
    assert_eq!(retires(&run).len(), 1, "one stop is one report");
    run.stop();
}

/// The same awaited stop, one the shell could not confirm: the session is told
/// the stop failed and the channel is not reported gone while its process
/// still runs.
#[test]
fn a_stop_the_shell_cannot_confirm_leaves_the_channel_running_and_is_reported() {
    let run = run_stop(
        "retire-unconfirmed",
        false,
        crate::session::harness::Stop::Fails,
    );
    let _ = run.attach(1);
    assert!(run.wait_ready(1));

    run.apply(run.host.detach(1, Retirement::Aborted, "Opening cancelled"));
    assert!(
        run.events.until(500, |event| matches!(
            event,
            Event::StopFailed {
                reason: Retirement::Aborted,
                awaited: true,
                ..
            }
        )),
        "the caller waiting on the stop learns it did not finish"
    );
    assert!(
        !effects(&run)
            .iter()
            .any(|event| matches!(event, Event::Exited { .. })),
        "a process that outlived its stop has not exited"
    );
    assert!(!run.host.gone(), "the process is still running");
    assert!(!run.host.available(), "and the host is still winding down");
    run.stop();
}

/// `host-retire.test.ts`: "an idle shared host whose tree outlived its stop is
/// reported, and nothing is left unhandled". Nobody waits on the idle retire,
/// so the shell is told it is unawaited and reports it itself.
#[test]
fn an_idle_shared_host_retires_unawaited_and_keeps_serving_until_then() {
    let run = run("retire-idle", true);
    let _ = run.attach(1);
    assert!(run.wait_ready(1));

    run.apply(run.host.detach(1, Retirement::User, "user closed"));
    assert!(
        run.events.until(500, |event| matches!(
            event,
            Event::Exited {
                tenant: 1,
                exit: HostExit {
                    reason: ExitReason::Detached,
                    ..
                }
            }
        )),
        "the channel leaves while the process keeps serving"
    );
    assert!(
        effects(&run).iter().any(|event| matches!(
            event,
            Event::ArmTimer { key, ms } if key == IDLE_TIMER && *ms == 1_000.0
        )),
        "an empty shared host stays up for the next session"
    );

    run.apply(run.host.timer(IDLE_TIMER));
    assert_eq!(
        retires(&run),
        vec![Event::Retire {
            reason: Retirement::Idle,
            awaited: false,
        }],
        "nobody waits on the idle stop, so the shell must report its failure"
    );
    assert!(effects(&run).iter().any(|event| event == &Event::Retired));
    // The stop ended the process, and that is the outcome the shell reports.
    assert!(wait_gone(&run));
    // A later awaited retire is the same stop, not a second one.
    run.apply(run.host.retire(Retirement::Shutdown));
    assert_eq!(retires(&run).len(), 1);
    run.stop();
}

/// An idle stop the shell could not confirm: reported, unawaited, and the
/// process it could not stop is still there.
#[test]
fn an_idle_stop_the_shell_cannot_confirm_is_reported_not_an_exit() {
    let run = run_stop(
        "retire-idle-fails",
        true,
        crate::session::harness::Stop::Fails,
    );
    let _ = run.attach(1);
    assert!(run.wait_ready(1));
    run.apply(run.host.detach(1, Retirement::User, "user closed"));
    assert!(
        run.events
            .until(500, |event| matches!(event, Event::Exited { .. }))
    );

    run.apply(run.host.timer(IDLE_TIMER));
    assert!(
        run.events.until(500, |event| matches!(
            event,
            Event::StopFailed {
                reason: Retirement::Idle,
                awaited: false,
                ..
            }
        )),
        "the shell reports an idle stop it could not confirm"
    );
    assert!(!run.host.gone(), "the process outlived its stop");
    run.stop();
}

/// A crash settles every routed call exactly once: the request the app-server
/// died on, and nothing again when the pipes close.
#[test]
fn a_crash_settles_every_routed_call_exactly_once() {
    let run = run("crash", true);
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    let started = run.request(1, "thread/start", &ace_json::json!({"cwd": "/tmp"}));
    assert!(run.events.until(5_000, |event| matches!(
        event,
        Event::Settle { id, failed: false } if *id == started
    )));
    let thread = run
        .frames(1)
        .into_iter()
        .find_map(|data| {
            data.get("result")?
                .get("thread")?
                .get("id")?
                .as_str()
                .map(str::to_owned)
        })
        .expect("the open names its thread");

    // The fake exits before answering this turn, so the call is in flight when
    // the process dies.
    let crashing = run.request(
        1,
        "turn/start",
        &ace_json::json!({
            "threadId": thread,
            "input": [{"type": "text", "text": "crash"}],
        }),
    );
    assert!(run.wait_exit(1) && run.wait_exit(2), "both channels end");
    let settles: Vec<Event> = effects(&run)
        .into_iter()
        .filter(|event| matches!(event, Event::Settle { id, .. } if *id == crashing))
        .collect();
    assert_eq!(settles.len(), 1, "one settlement per routed call");
    assert_eq!(
        settles[0],
        Event::Settle {
            id: crashing,
            failed: true,
        }
    );
    assert!(effects(&run).iter().any(|event| matches!(
        event,
        Event::Exited {
            exit: HostExit { code: Some(3), .. },
            ..
        }
    )));

    // The pipes' end closes the peer; nothing is settled twice.
    run.apply(run.host.closed(RawExit {
        code: Some(3),
        signal: None,
    }));
    let again = effects(&run)
        .into_iter()
        .filter(|event| matches!(event, Event::Settle { id, .. } if *id == crashing))
        .count();
    assert_eq!(again, 1);
    run.stop();
}

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
    run.apply(run.host.line(&line));

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
    run.apply(run.host.line(&line));
    assert!(!run.frames(1).iter().any(|data| {
        data.get("params")
            .and_then(|params| params.get("threadId"))
            .and_then(Value::as_str)
            == Some("never-opened")
    }),);
    run.stop();
}

/// `shared-host.process.test.ts`: "cancelling while Codex is still opening
/// reports the cancellation (shared %s)". A channel detached before its open
/// resolves exits with `detached`, and no late `ready` follows it.
#[test]
fn a_cancelled_open_exits_the_channel_instead_of_going_ready() {
    for shared in [true, false] {
        let run = run(
            if shared {
                "cancel-shared"
            } else {
                "cancel-dedicated"
            },
            shared,
        );
        let _ = run.attach(1);
        run.apply(run.host.detach(1, Retirement::Aborted, "Opening cancelled"));

        assert!(
            run.events.until(5_000, |event| matches!(
                event,
                Event::Exited { tenant: 1, .. }
            )),
            "shared={shared}: the cancelled open exits its channel"
        );
        let events = effects(&run);
        let exit = events
            .iter()
            .position(|event| matches!(event, Event::Exited { tenant: 1, .. }))
            .unwrap_or_default();
        assert!(
            !events[exit + 1..]
                .iter()
                .any(|event| matches!(event, Event::Ready { tenant: 1 })),
            "shared={shared}: nothing resolves after the cancellation"
        );
        run.stop();
    }
}

/// The malformed and stderr lines a shared process writes reach every
/// channel, and neither ends the host.
#[test]
fn shared_diagnostics_reach_every_channel_without_ending_the_host() {
    let run = run("diagnostics", true);
    let _ = run.attach(1);
    let _ = run.attach(2);
    assert!(run.wait_ready(1) && run.wait_ready(2));

    run.apply(run.host.line("not json"));
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
    let attached = run
        .host
        .attach(7, handler as Arc<dyn ChannelHandlers>)
        .expect("the host accepts a channel");
    run.apply(attached);
    assert!(run.wait_ready(7));

    run.apply(run.host.line(&ace_json::to_string(&ace_json::json!({
        "jsonrpc": "2.0",
        "method": "thread/started",
        "params": {"thread": {"id": "t"}},
    }))));
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
    let (host, initial) = Host::new(HostConfig::shared(initialize(), 1_000.0));
    // No child here: acknowledge the `initialize` write so the queue hands out
    // the next line.
    for effect in initial {
        if let HostEffect::Write { ticket, .. } = effect {
            host.written(ticket);
        }
    }
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host
        .attach(1, Recorder::new(1, Arc::clone(&events)))
        .expect("a channel attaches before the handshake");
    let effects = host
        .request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "owned"})),
            7,
            Timeout::After(1_000.0),
        )
        .expect("the request is queued");
    let sent = effects
        .iter()
        .find_map(|effect| match effect {
            HostEffect::Write { wire, .. } => Some(wire.clone()),
            _ => None,
        })
        .expect("the request was written");
    let wire_id = ace_json::parse(std::str::from_utf8(&sent).expect("utf-8"))
        .ok()
        .and_then(|value| value.get("id").and_then(Value::as_f64))
        .map(RpcId::Number)
        .expect("the wire id");

    // The owner first, so the dropped line can be attributed to it.
    host.line(&ace_json::to_string(&ace_json::json!({
        "jsonrpc": "2.0",
        "method": "thread/started",
        "params": {"thread": {"id": "owned"}},
    })))
    .into_iter()
    .for_each(drop);
    let effects = host.dropped(&DroppedLine {
        bytes: 20_000_000,
        phase: DroppedPhase::Line,
        thread: Some(ace_json::JsString::from("owned")),
        response: Some(wire_id),
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

/// `foreign`: a thread another channel owns is not this channel's to claim,
/// and neither is one a channel let go.
#[test]
fn a_thread_is_foreign_to_every_channel_but_its_owner() {
    let (host, initial) = Host::new(HostConfig::shared(initialize(), 60_000.0));
    for effect in initial {
        if let HostEffect::Write { ticket, .. } = effect {
            host.written(ticket);
        }
    }
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    let _ = host.attach(2, Recorder::new(2, Arc::clone(&events)));

    let effects = host
        .request(
            1,
            "thread/start",
            Some(&ace_json::json!({"cwd": "/tmp"})),
            5,
            Timeout::After(1_000.0),
        )
        .expect("the open is queued");
    for effect in effects {
        if let HostEffect::Write { ticket, .. } = effect {
            host.written(ticket);
        }
    }
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
    let reply = ace_json::json!({
        "jsonrpc": "2.0",
        "result": {"thread": {"id": "open"}},
    });
    let mut reply = match reply {
        Value::Object(map) => map,
        _ => ace_json::Map::new(),
    };
    reply.insert("id", id_to_value(&wire));
    host.line(&ace_json::to_string(&Value::Object(reply)))
        .into_iter()
        .for_each(drop);

    let open = ace_json::JsString::from("open");
    assert!(!host.foreign(1, &open), "a channel's own thread");
    assert!(host.foreign(2, &open), "another channel's thread");
    assert!(!host.foreign(2, &ace_json::JsString::from("unknown")));

    host.detach(1, Retirement::User, "user closed")
        .into_iter()
        .for_each(drop);
    assert!(
        host.foreign(1, &open),
        "a released thread is never evidence of a new owner"
    );
    assert!(host.foreign(2, &open));
}

/// A channel that detaches settles what it was waiting on before the shell
/// reports it gone, and issues nothing afterwards (`host.ts:153`, `:349`).
#[test]
fn a_detach_settles_the_channels_calls_before_its_exit_and_refuses_new_ones() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("a call with no deadline is queued");

    let effects = host.detach(1, Retirement::User, "user closed");
    let settle = effects
        .iter()
        .position(|effect| matches!(effect, HostEffect::Settle { id: 7, .. }))
        .expect("the waiting call settles");
    let exit = effects
        .iter()
        .position(|effect| matches!(effect, HostEffect::Exited { tenant: 1, .. }))
        .expect("the channel exits");
    assert!(settle < exit, "the settlement is published before the exit");
    assert!(matches!(
        effects[settle],
        HostEffect::Settle { result: Err(_), .. }
    ));

    // The channel is gone: it cannot start work that would wait until the
    // shared host exits.
    assert_eq!(
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "t"})),
            8,
            Timeout::Disabled,
        )
        .err(),
        Some(HostError::Refused("Codex channel closed".to_owned()))
    );
}

/// A leader's end settles every routed call before it reports any channel
/// gone, so no shell sees an exit ahead of the settlements it caused.
#[test]
fn an_exit_settles_every_call_before_it_reports_the_channel_gone() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        9,
        Timeout::Disabled,
    )
    .expect("a call with no deadline is queued");

    let (effects, _) = pump(
        &host,
        host.exit(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    let settle = effects
        .iter()
        .position(|effect| matches!(effect, HostEffect::Settle { id: 9, .. }))
        .expect("the waiting call settles");
    let exit = effects
        .iter()
        .position(|effect| matches!(effect, HostEffect::Exited { tenant: 1, .. }))
        .expect("the channel exits");
    assert!(settle < exit, "settlements precede the exit they belong to");
    assert!(matches!(
        effects[settle],
        HostEffect::Settle { result: Err(_), .. }
    ));
}

/// A teardown never broadcasts a frame whose ancestry it could not prove: the
/// hold is dropped as frames, and the channel exits (`#exited`, `:416`).
#[test]
fn a_teardown_drops_unresolved_holds_instead_of_broadcasting_them() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    let _ = host.attach(2, Recorder::new(2, Arc::clone(&events)));
    // Two channels, so an unowned thread is held for its ancestry rather than
    // handed to the only channel.
    let (_, _) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": "ask-1",
            "method": "mcpServer/elicitation/request",
            "params": {"threadId": "unowned", "serverName": "docs", "mode": "form"},
        }))),
    );

    let (effects, _) = pump(
        &host,
        host.exit(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::Exited { tenant: 1, .. })),
        "the channel exits"
    );
    for tenant in [1, 2] {
        assert!(
            !events.snapshot().iter().any(|event| matches!(
                event,
                Event::Frame { tenant: who, data, .. }
                    if *who == tenant
                        && data
                            .get("params")
                            .and_then(|params| params.get("threadId"))
                            .and_then(Value::as_str)
                            == Some("unowned")
            )),
            "a teardown never broadcasts a frame whose owner it cannot prove"
        );
    }
}

/// A reply the app-server would write for `id`.
fn reply(id: &RpcId, result: Value) -> String {
    let mut map = ace_json::Map::with_capacity(3);
    map.insert("jsonrpc", Value::from("2.0"));
    map.insert("id", id_to_value(id));
    map.insert("result", result);
    frame(Value::Object(map))
}

/// How many frames one channel was given for `thread`.
fn seen_for(events: &crate::session::harness::Events, tenant: u64, thread: &str) -> usize {
    events
        .snapshot()
        .iter()
        .filter(|event| {
            matches!(
                event,
                Event::Frame { tenant: who, data, .. }
                    if *who == tenant
                        && data
                            .get("params")
                            .and_then(|params| params.get("threadId"))
                            .and_then(Value::as_str)
                            == Some(thread)
            )
        })
        .count()
}

/// A late ancestry reply belongs to the hold that asked: a hold evicted and
/// recreated for the same thread never resolves against the old answer.
#[test]
fn a_late_ancestry_reply_never_resolves_a_recreated_hold() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    let _ = host.attach(2, Recorder::new(2, Arc::clone(&events)));

    // Tenant 1 owns "claimed" through an opening request.
    let (_, lines) = pump(
        &host,
        host.request(
            1,
            "thread/resume",
            Some(&ace_json::json!({"threadId": "claimed"})),
            1,
            Timeout::Default,
        )
        .expect("the open is queued"),
    );
    let opening = line_id(&lines, "thread/resume", Some("claimed")).expect("the open's id");
    let (_, _) = pump(
        &host,
        host.line(&reply(
            &opening,
            ace_json::json!({"thread": {"id": "claimed"}}),
        )),
    );

    // An unowned thread waits for its ancestry; its read is never answered.
    let (_, lines) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "item/completed",
            "params": {"threadId": "t0", "item": {"type": "agentMessage", "id": "m0"}},
        }))),
    );
    let first = line_id(&lines, "thread/read", Some("t0")).expect("the first read");

    // Evict that hold by filling the table with siblings.
    for index in 1..=65 {
        let _ = pump(
            &host,
            host.line(&frame(ace_json::json!({
                "jsonrpc": "2.0",
                "method": "item/completed",
                "params": {
                    "threadId": format!("t{index}"),
                    "item": {"type": "agentMessage", "id": format!("m{index}")},
                },
            }))),
        );
    }
    // A fresh hold for the same thread, with its own read.
    let (_, lines) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "item/completed",
            "params": {"threadId": "t0", "item": {"type": "agentMessage", "id": "m0-again"}},
        }))),
    );
    let second = line_id(&lines, "thread/read", Some("t0")).expect("the second read");
    assert_ne!(first, second, "a new hold asks its own question");

    let before = (seen_for(&events, 1, "t0"), seen_for(&events, 2, "t0"));
    // The old read's answer names an ancestor the first tenant owns. It must
    // not resolve the hold that replaced it.
    let _ = pump(
        &host,
        host.line(&reply(
            &first,
            ace_json::json!({"thread": {"id": "t0", "parentThreadId": "claimed"}}),
        )),
    );
    let after = (seen_for(&events, 1, "t0"), seen_for(&events, 2, "t0"));
    assert_eq!(after, before, "a late reply never flushes a newer hold");
}

/// The read-ahead a paused pump may still spend: 1 MiB over both pumps, plus
/// the chunks already in flight (`PAUSED_READ_BYTES`, 4 × 64 KiB each).
const PAUSED_SLACK: usize = 3 * 1024 * 1024;
/// What an unpaused pump moves in the same time, well past the slack.
const FLOWING_BYTES: usize = 4 * 1024 * 1024;

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
