use std::sync::Arc;

use ace_json::Value;
use ace_supervisor::peer::Timeout;
use ace_supervisor::spawn::RawExit;

use super::super::*;
use super::*;
use crate::session::harness::{Event, Recorder};

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

/// A leader's end records the status and settles what was waiting, without
/// ending the channels: the frames after the leader still reach them, and only
/// the pipe barrier publishes the exit (`host.ts:239`, `:268`).
#[test]
fn a_leader_death_settles_calls_and_keeps_the_channels_until_the_pipes_end() {
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
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            HostEffect::Settle {
                id: 9,
                result: Err(_)
            }
        )),
        "the waiting call settles at the leader's end"
    );
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::Exited { .. })),
        "the channels are not gone while their pipes still drain"
    );
    assert!(host.gone(), "the leader is gone");
    assert!(!host.available());

    // A frame written after the leader still reaches its channel.
    let _ = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "item/completed",
            "params": {"threadId": "final", "item": {"type": "agentMessage", "id": "m"}},
        }))),
    );
    assert_eq!(
        seen_for(&events, 1, "final"),
        1,
        "the final frames lose no channel"
    );

    host.output_cut();
    let (effects, _) = pump(
        &host,
        host.closed(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    let exit = effects
        .iter()
        .find_map(|effect| match effect {
            HostEffect::Exited { tenant: 1, exit } => Some(exit.clone()),
            _ => None,
        })
        .expect("the pipe barrier publishes the exit");
    assert!(!exit.output_drained, "a drain the cutoff ended reports it");
}

/// The pipe barrier publishes settlements before the exit they belong to.
#[test]
fn closed_publishes_settlements_before_the_exit() {
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
        host.closed(RawExit {
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

    let _ = pump(
        &host,
        host.exit(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    let (effects, _) = pump(
        &host,
        host.closed(RawExit {
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

/// No exit reaches a channel before the pipe barrier, even one that was
/// detaching when the leader died (`#exited` at `close`).
#[test]
fn a_tenant_detaching_during_leader_death_waits_for_the_pipe_barrier() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t");

    // The channel leaves with an unsubscribe in flight.
    let (_, lines) = pump(&host, host.detach(1, Retirement::Idle, "idle"));
    assert!(line_id(&lines, "thread/unsubscribe", Some("t")).is_some());
    // Then the leader dies: the unsubscribe is settled by the teardown.
    let (effects, _) = pump(
        &host,
        host.exit(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::Exited { .. })),
        "the exit waits for the pipes"
    );

    let (effects, _) = pump(
        &host,
        host.closed(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    assert_eq!(
        effects
            .iter()
            .filter(|effect| matches!(effect, HostEffect::Exited { tenant: 1, .. }))
            .count(),
        1,
        "the channel hears its exit once, at the barrier"
    );
}

/// A stop failure that arrives after the leader died cannot undo the drain the
/// exit started.
#[test]
fn a_late_stop_failure_does_not_undo_the_leaders_drain() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    let _ = pump(
        &host,
        host.exit(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    host.set_paused(1, true);
    host.stop_failed();
    assert!(
        !host.paused(),
        "a dead leader's drain is not undone by a late failure"
    );
}

/// A channel that leaves while the leader dies keeps its routes until the pipe
/// barrier, so the frames the pipes still carry reach it.
#[test]
fn a_detaching_tenant_still_receives_its_final_frames() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t");

    // The channel leaves with an unsubscribe in flight.
    let (_, lines) = pump(&host, host.detach(1, Retirement::Idle, "idle"));
    assert!(line_id(&lines, "thread/unsubscribe", Some("t")).is_some());
    // The leader dies: the teardown settles the unsubscribe, and the channel
    // waits for the barrier with its routes.
    let (_, _) = pump(
        &host,
        host.exit(RawExit {
            code: Some(1),
            signal: None,
        }),
    );

    let (_, _) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "item/completed",
            "params": {"threadId": "t", "item": {"type": "agentMessage", "id": "last"}},
        }))),
    );
    assert_eq!(
        seen_for(&events, 1, "t"),
        1,
        "the leaving channel still gets its final frames"
    );

    let (effects, _) = pump(
        &host,
        host.closed(RawExit {
            code: Some(1),
            signal: None,
        }),
    );
    assert_eq!(
        effects
            .iter()
            .filter(|effect| matches!(effect, HostEffect::Exited { tenant: 1, .. }))
            .count(),
        1,
        "and one exit, at the barrier"
    );
}
