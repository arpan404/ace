use std::sync::Arc;

use ace_supervisor::peer::Timeout;

use super::super::*;
use super::*;
use crate::session::harness::{Event, Recorder};
use crate::session::pool::initialize;

/// Records a running turn for a thread the channel already owns.
fn busy_turn(host: &Host, thread: &str) {
    let _ = pump(
        host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "turn/started",
            "params": {"threadId": thread, "turn": {"id": format!("turn-{thread}")}},
        }))),
    );
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

    // A later awaited retire is the same stop: it surfaces the same failure.
    run.apply(run.host.retire(Retirement::Shutdown));
    assert!(
        run.events.until(500, |event| matches!(
            event,
            Event::StopFailed {
                reason: Retirement::Shutdown,
                awaited: true,
                message,
            } if message == "the process tree outlived its stop"
        )),
        "a caller that joins the stop sees the failure it already has"
    );

    // A surviving host takes backpressure again after the failed stop.
    run.host.set_paused(1, true);
    assert!(run.host.paused(), "the drain did not stay latched");
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

/// A close whose interrupt the provider refuses keeps the turn's work
/// attached, and the close reports the refusal (`session.ts`'s close).
#[test]
fn a_refused_interrupt_keeps_the_channel_and_surfaces_the_failure() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    busy_thread(&host, 1, "t");

    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let interrupt = line_id(&lines, "turn/interrupt", Some("t")).expect("the interrupt");
    // A response carrying `error` is a refusal, not a result.
    let (effects, _) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": id_to_value(&interrupt),
            "error": {"code": -32602.0, "message": "turn/interrupt needs a turnId"},
        }))),
    );
    let failure = effects
        .iter()
        .find_map(|effect| match effect {
            HostEffect::DetachFailed {
                tenant: 1, message, ..
            } => Some(message.clone()),
            _ => None,
        })
        .expect("the close reports the refused interrupt");
    assert!(failure.contains("turnId"), "{failure}");

    // The channel and its work are still attached.
    assert_eq!(host.tenant_count(), 1);
    assert!(
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "t"})),
            5,
            Timeout::Disabled
        )
        .is_ok()
    );
}

/// A close whose interrupt is never answered is the same: no detach, and the
/// close reports the deadline.
#[test]
fn a_timed_out_interrupt_keeps_the_channel_and_surfaces_the_failure() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    busy_thread(&host, 1, "t");

    let (effects, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    assert!(line_id(&lines, "turn/interrupt", Some("t")).is_some());
    let timer = effects
        .iter()
        .find_map(|effect| match effect {
            HostEffect::ArmTimer { key, ms } if *ms == 10_000.0 => Some(key.clone()),
            _ => None,
        })
        .expect("the interrupt has a deadline");

    let (effects, _) = pump(&host, host.timer(&timer));
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            HostEffect::DetachFailed { tenant: 1, message, .. } if message.contains("timed out")
        )),
        "the close reports the deadline"
    );
    assert_eq!(host.tenant_count(), 1, "the channel stays attached");
}

/// An interrupt the peer refuses to enqueue cannot stop the turn: nothing
/// detaches, and the close reports it (`session.ts`'s close).
#[test]
fn an_interrupt_the_peer_refuses_to_enqueue_fails_the_close() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    busy_thread(&host, 1, "t");
    // Fill the peer's pending table, so the close's own request is refused.
    for id in 100..1124 {
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "t"})),
            id,
            Timeout::Disabled,
        )
        .expect("a call with no deadline is queued");
    }

    let (effects, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    assert!(
        line_id(&lines, "turn/interrupt", Some("t")).is_none(),
        "the interrupt never reached the peer"
    );
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            HostEffect::DetachFailed {
                tenant: 1,
                message,
                ..
            } if message.contains("refused the interrupt")
        )),
        "the close reports the refused interrupt: {effects:#?}"
    );
    assert_eq!(host.tenant_count(), 1, "the channel stays attached");
}

/// A reply to a failed close's interrupt is not the retry's: the retried close
/// waits for its own interrupts, and only then releases the channel.
#[test]
fn a_late_reply_from_a_failed_detach_never_counts_for_the_retry() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    busy_thread(&host, 1, "t1");
    busy_thread(&host, 1, "t2");

    // The first close: t1's interrupt is refused, so t2's stays outstanding.
    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let first_t1 = line_id(&lines, "turn/interrupt", Some("t1")).expect("t1's interrupt");
    let first_t2 = line_id(&lines, "turn/interrupt", Some("t2")).expect("t2's interrupt");
    let (effects, _) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": id_to_value(&first_t1),
            "error": {"code": -32602.0, "message": "no turn to stop"},
        }))),
    );
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::DetachFailed { tenant: 1, .. }))
    );
    assert_eq!(host.tenant_count(), 1);

    // The retry asks again.
    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let second_t1 = line_id(&lines, "turn/interrupt", Some("t1")).expect("t1's retry");
    let second_t2 = line_id(&lines, "turn/interrupt", Some("t2")).expect("t2's retry");
    assert_ne!(first_t1, second_t1);

    // The old close's t2 answer is not the retry's.
    let (_, lines) = pump(&host, host.line(&reply(&first_t2, ace_json::json!({}))));
    assert!(
        line_id(&lines, "thread/unsubscribe", Some("t1")).is_none(),
        "a stale answer never releases the channel"
    );
    // One of the retry's two still outstanding is not enough either.
    let (_, lines) = pump(&host, host.line(&reply(&second_t1, ace_json::json!({}))));
    assert!(line_id(&lines, "thread/unsubscribe", Some("t1")).is_none());

    // Both of the retry's interrupts answered: the close moves on to the
    // threads' terminals, and leaves only once they are stopped.
    let (_, lines) = pump(&host, host.line(&reply(&second_t2, ace_json::json!({}))));
    let lists = line_ids(&lines, "thread/backgroundTerminals/list");
    assert_eq!(lists.len(), 2, "one list per thread");
    assert!(line_id(&lines, "thread/unsubscribe", Some("t1")).is_none());
    let mut written = Vec::new();
    for list in &lists {
        let (_, more) = pump(
            &host,
            host.line(&reply(list, ace_json::json!({"data": []}))),
        );
        written.extend(more);
    }
    assert!(
        line_id(&written, "thread/unsubscribe", Some("t1")).is_some(),
        "the last terminal step releases the thread: {written:?}"
    );
}

/// A close against a full write queue: the peer cannot take the interrupt, so
/// the close fails at once instead of waiting for an answer that never comes
/// (`peer.rs:540` settles a refused enqueue inside its effects).
#[test]
fn a_full_write_queue_fails_the_close_instead_of_waiting_forever() {
    let host = bare_with(HostConfig {
        max_queued_bytes: Some(512),
        ..HostConfig::shared(initialize(), 60_000.0)
    });
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    busy_thread(&host, 1, "t");
    // Nothing is acknowledged here, so the queue fills.
    for id in 0..16 {
        let _ = host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "t"})),
            id,
            Timeout::Disabled,
        );
    }

    let (effects, _) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            HostEffect::DetachFailed {
                tenant: 1,
                message,
                ..
            } if message.contains("write queue")
        )),
        "the close reports the refused interrupt: {effects:#?}"
    );
    assert_eq!(host.tenant_count(), 1, "the channel stays attached");
}

/// Two live turns and one pending slot left: the first interrupt is taken and
/// claims the active write, the second is refused. The close fails, but the
/// claimed write must still reach the shell, or shared stdin stalls forever
/// (`peer.rs:540` keeps the ticket charged until `written`).
#[test]
fn a_refused_second_interrupt_still_hands_over_the_claimed_write() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    busy_thread(&host, 1, "t1");
    busy_thread(&host, 1, "t2");

    // Fill the peer's pending table to one slot below its bound, acknowledging
    // every write so the next enqueue claims the active ticket.
    for id in 100..1123 {
        let effects = host
            .request(
                1,
                "thread/read",
                Some(&ace_json::json!({"threadId": "t1"})),
                id,
                Timeout::Disabled,
            )
            .expect("a call with no deadline is queued");
        let _ = pump(&host, effects);
    }

    let (effects, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            HostEffect::DetachFailed {
                tenant: 1,
                message,
                ..
            } if message.contains("refused the interrupt")
        )),
        "the close reports the refused interrupt: {effects:#?}"
    );
    assert!(
        line_id(&lines, "turn/interrupt", Some("t1")).is_some(),
        "the claimed write still goes out, so stdin is not stalled: {lines:?}"
    );
    assert_eq!(host.tenant_count(), 1, "the channel stays attached");
}

/// A turn that started while its thread was held starts for real when the hold
/// is released; the close must interrupt it too (`track_active`).
#[test]
fn a_turn_replayed_from_a_hold_is_interrupted_by_the_close() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    // A second channel, so an unowned thread is held for its ancestry rather
    // than handed to the only one.
    let _ = host.attach(2, Recorder::new(2, Arc::clone(&events)));
    claim_thread(&host, 1, "parent");
    busy_turn(&host, "parent");

    // The child speaks before its parent reveals it: held, then flushed.
    let (_, lines) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "turn/started",
            "params": {"threadId": "child", "turn": {"id": "turn-child"}},
        }))),
    );
    let read = line_id(&lines, "thread/read", Some("child")).expect("the ancestry read");
    let _ = pump(
        &host,
        host.line(&reply(
            &read,
            ace_json::json!({"thread": {"id": "child", "parentThreadId": "parent"}}),
        )),
    );
    assert_eq!(
        seen_for(&events, 1, "child"),
        1,
        "the held start was replayed"
    );

    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    assert!(
        line_id(&lines, "turn/interrupt", Some("parent")).is_some(),
        "the parent's turn is interrupted: {lines:?}"
    );
    assert!(
        line_id(&lines, "turn/interrupt", Some("child")).is_some(),
        "and so is the replayed child's: {lines:?}"
    );
}

/// A close stops the channel's background terminals, in TS's order: the turn's
/// interrupt, then each thread's terminals, then the unsubscribe
/// (`stopShells`, `session-commands.ts:183`).
#[test]
fn a_close_stops_the_channels_background_terminals_before_it_unsubscribes() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t");
    busy_turn(&host, "t");

    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let interrupt = line_id(&lines, "turn/interrupt", Some("t")).expect("the interrupt");
    assert!(
        line_id(&lines, "thread/backgroundTerminals/list", Some("t")).is_none(),
        "the terminals are read after the turn stops"
    );

    let (_, lines) = pump(&host, host.line(&reply(&interrupt, ace_json::json!({}))));
    let list = line_id(&lines, "thread/backgroundTerminals/list", Some("t"))
        .expect("the thread's terminals are read");

    let (_, lines) = pump(
        &host,
        host.line(&reply(
            &list,
            ace_json::json!({"data": [{"processId": "p1"}, {"processId": "p2"}]}),
        )),
    );
    let stops: Vec<&String> = lines
        .iter()
        .filter(|line| line.contains("thread/backgroundTerminals/terminate"))
        .collect();
    assert_eq!(stops.len(), 2, "one stop per terminal: {stops:?}");
    assert!(stops[0].contains("\"processId\":\"p1\""));
    assert!(stops[1].contains("\"processId\":\"p2\""));
    let stop_ids = line_ids(&lines, "thread/backgroundTerminals/terminate");
    assert!(
        line_id(&lines, "thread/unsubscribe", Some("t")).is_none(),
        "the thread leaves only after its terminals stop"
    );

    let (_, lines) = pump(&host, host.line(&reply(&stop_ids[0], ace_json::json!({}))));
    assert!(line_id(&lines, "thread/unsubscribe", Some("t")).is_none());
    let (_, lines) = pump(&host, host.line(&reply(&stop_ids[1], ace_json::json!({}))));
    assert!(
        line_id(&lines, "thread/unsubscribe", Some("t")).is_some(),
        "the last terminal stopped: the thread is unsubscribed"
    );
}

/// A terminal the close cannot stop is the close's failure: the channel and
/// its work stay attached (`interruptOne` collects the failure).
#[test]
fn a_terminal_the_close_cannot_stop_fails_the_close() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t");
    busy_turn(&host, "t");

    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let interrupt = line_id(&lines, "turn/interrupt", Some("t")).expect("the interrupt");
    let (_, lines) = pump(&host, host.line(&reply(&interrupt, ace_json::json!({}))));
    let list =
        line_id(&lines, "thread/backgroundTerminals/list", Some("t")).expect("the terminal list");
    let (_, lines) = pump(
        &host,
        host.line(&reply(
            &list,
            ace_json::json!({"data": [{"processId": "p1"}]}),
        )),
    );
    let stop = line_ids(&lines, "thread/backgroundTerminals/terminate")[0].clone();

    let (effects, _) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": id_to_value(&stop),
            "error": {"code": -32603.0, "message": "no such terminal"},
        }))),
    );
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            HostEffect::DetachFailed {
                tenant: 1,
                message,
                ..
            } if message.contains("background terminals")
        )),
        "the close reports the terminal it could not stop: {effects:#?}"
    );
    assert_eq!(host.tenant_count(), 1, "the channel stays attached");
}

/// A leader that has died takes no new channel, even while its pipes drain
/// (`#attach`: a process that exited never opens one).
#[test]
fn an_attach_after_the_leaders_death_is_refused() {
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
    assert_eq!(
        host.attach(2, Recorder::new(2, Arc::clone(&events))).err(),
        Some(HostError::Unavailable)
    );
}

/// A channel with no live turn still has shells: the close reads them before
/// it unsubscribes (`stopShells` runs for every thread).
#[test]
fn a_close_with_no_live_turn_still_stops_its_shells() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t");

    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let list = line_id(&lines, "thread/backgroundTerminals/list", Some("t"))
        .expect("the shell list is read with no turn to interrupt");
    assert!(line_id(&lines, "thread/unsubscribe", Some("t")).is_none());
    let (_, lines) = pump(
        &host,
        host.line(&reply(
            &list,
            ace_json::json!({"data": [], "nextCursor": null}),
        )),
    );
    assert!(line_id(&lines, "thread/unsubscribe", Some("t")).is_some());
}

/// Every page of a thread's terminals is read before any is stopped, as
/// `readBackgroundTerminals` does (`background-terminals.ts:16`).
#[test]
fn a_close_pages_through_every_shell_before_stopping_them() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t");

    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let first =
        line_id(&lines, "thread/backgroundTerminals/list", Some("t")).expect("the first page");
    assert!(
        !lines[0].contains("cursor"),
        "the first page names no cursor"
    );

    let (_, lines) = pump(
        &host,
        host.line(&reply(
            &first,
            ace_json::json!({"data": [{"processId": "p1"}], "nextCursor": "c1"}),
        )),
    );
    let second = line_ids(&lines, "thread/backgroundTerminals/list");
    assert_eq!(second.len(), 1, "the continuation is asked for: {lines:?}");
    assert!(lines[0].contains("\"cursor\":\"c1\""));
    assert!(
        line_ids(&lines, "thread/backgroundTerminals/terminate").is_empty(),
        "nothing is stopped before the last page"
    );

    let (_, lines) = pump(
        &host,
        host.line(&reply(
            &second[0],
            ace_json::json!({
                "data": [{"processId": "p2"}],
                "nextCursor": null,
            }),
        )),
    );
    let stops: Vec<&String> = lines
        .iter()
        .filter(|line| line.contains("thread/backgroundTerminals/terminate"))
        .collect();
    assert_eq!(stops.len(), 2, "both pages' terminals stop: {stops:?}");
    assert!(stops[0].contains("\"processId\":\"p1\""));
    assert!(stops[1].contains("\"processId\":\"p2\""));
}

/// A terminal reply from a failed close is not the retry's: only the current
/// attempt's pages and stops advance it.
#[test]
fn a_late_terminal_reply_from_a_failed_detach_never_counts_for_the_retry() {
    let host = bare(true);
    let events = Arc::new(crate::session::harness::Events::default());
    let _ = host.attach(1, Recorder::new(1, Arc::clone(&events)));
    claim_thread(&host, 1, "t1");
    claim_thread(&host, 1, "t2");

    // The first close: t1's list is refused, so t2's stays outstanding.
    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let first_t1 =
        line_id(&lines, "thread/backgroundTerminals/list", Some("t1")).expect("t1's list");
    let first_t2 =
        line_id(&lines, "thread/backgroundTerminals/list", Some("t2")).expect("t2's list");
    let (effects, _) = pump(
        &host,
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": id_to_value(&first_t1),
            "error": {"code": -32603.0, "message": "no terminals"},
        }))),
    );
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, HostEffect::DetachFailed { tenant: 1, .. }))
    );

    // The retry reads again.
    let (_, lines) = pump(&host, host.detach(1, Retirement::User, "user closed"));
    let second_t2 =
        line_id(&lines, "thread/backgroundTerminals/list", Some("t2")).expect("t2's retry");
    assert_ne!(first_t2, second_t2);

    // The old close's t2 answer is not the retry's.
    let (_, lines) = pump(
        &host,
        host.line(&reply(
            &first_t2,
            ace_json::json!({"data": [{"processId": "stale"}], "nextCursor": null}),
        )),
    );
    assert!(
        line_ids(&lines, "thread/backgroundTerminals/terminate").is_empty(),
        "a stale page stops nothing: {lines:?}"
    );
}
