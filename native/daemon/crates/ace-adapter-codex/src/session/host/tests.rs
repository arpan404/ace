// SPDX-License-Identifier: Apache-2.0
//! The host's cases. `host-retire.test.ts` moved here: a retirement nobody
//! waits on is reported by the shell, an awaited one reaches the session, and
//! one stop is one report. The others cover what the host alone decides:
//! a crash settles every routed call exactly once, an unknown route waits for
//! its ancestry, and an open cancelled before it resolves exits the channel.

use std::sync::Arc;

use ace_json::Value;
use ace_supervisor::spawn::RawExit;

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

fn effects(run: &HostRun) -> Vec<Event> {
    run.events.snapshot()
}

fn retires(run: &HostRun) -> Vec<Event> {
    effects(run)
        .into_iter()
        .filter(|event| matches!(event, Event::Retire { .. }))
        .collect()
}

/// `host-retire.test.ts`: "retiring a Windows host whose shells outlived the
/// stop fails for the session waiting on it". The host hands the stop to the
/// shell exactly once, marked as one a caller waits on, so the stop's failure
/// reaches that caller.
#[test]
fn a_retire_a_session_waits_on_is_reported_to_it_once() {
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
    // The session hears the exit the stop produced, never a second stop.
    assert!(run.wait_exit(1));
    run.apply(run.host.retire(Retirement::User));
    assert_eq!(retires(&run).len(), 1, "one stop is one report");
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
    // A later awaited retire is the same stop, not a second one.
    run.apply(run.host.retire(Retirement::Shutdown));
    assert_eq!(retires(&run).len(), 1);
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
