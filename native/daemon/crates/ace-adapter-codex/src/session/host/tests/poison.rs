// SPDX-License-Identifier: Apache-2.0
//! A sink that unwinds: the host poisons itself, stops its child once, and
//! never signals a process that is gone. The shared sink lives next to the
//! ordering cases (`super::publication`).

use std::sync::Arc;

use ace_supervisor::peer::Timeout;
use ace_supervisor::spawn::RawExit;

use super::*;
use crate::session::host::tests::publication::{Holding, Published, completed, renamed};

/// A sink that unwinds is a bug, not a protocol event: the drain catches it
/// once and poisons the host. Every pending call fails with the host's error,
/// the channels exit as after a crash, the shell is told the host is retired
/// so the pool can replace it, and nothing is left queued — whether the write
/// had reached stdin or not.
#[test]
fn a_sink_panic_on_a_write_poisons_the_host_before_or_after_submission() {
    for submitted in [false, true] {
        let sink = Arc::new(Holding::default());
        let host = sink.start();
        // A call with no deadline: only the poison settles it. Its write is
        // acknowledged, so the next one is handed out.
        let _ = sink.pump(&host, || {
            host.request(
                1,
                "thread/read",
                Some(&ace_json::json!({"threadId": "t"})),
                7,
                Timeout::Disabled,
            )
            .expect("the call is queued");
        });
        let before = sink.published().len();

        sink.lose_next_write(submitted);
        host.request(
            1,
            "thread/read",
            Some(&ace_json::json!({"threadId": "t"})),
            8,
            Timeout::Disabled,
        )
        .expect("the call is queued");

        assert!(
            host.poisoned(),
            "submitted={submitted}: the host is poisoned"
        );
        let published = sink.published();
        let failed = published[before..].iter().any(|thing| {
            matches!(
                thing,
                Published::Effect(HostEffect::Settle { id: 7, result: Err(error) })
                    if error.message() == HOST_FAILED
            )
        });
        assert!(
            failed,
            "submitted={submitted}: the pending call fails with the host's error: {:?}",
            &published[before..]
        );
        assert!(
            published[before..].iter().any(|thing| matches!(
                thing,
                Published::Effect(HostEffect::Exited { tenant: 1, .. })
            )),
            "submitted={submitted}: the channel exits as after a crash"
        );
        assert!(
            published[before..]
                .iter()
                .any(|thing| matches!(thing, Published::Effect(HostEffect::Retired))),
            "submitted={submitted}: the shell is told to replace the host"
        );
        assert_eq!(host.queued(), 0, "nothing stays queued");
        assert!(!host.available());
        // A dead host decides nothing more.
        host.line(&renamed("after"));
        assert_eq!(host.queued(), 0);
    }
}

/// A settlement decided before the panic keeps its place: another input can
/// settle a call and queue its settlement while a sink callback is in flight,
/// and poisoning must not drop it.
#[test]
fn a_settlement_queued_before_the_panic_is_still_delivered() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let (effects, _) = sink.pump(&host, || {
        for (id, ms) in [(7, 1_000.0), (8, 2_000.0)] {
            host.request(
                1,
                "thread/read",
                Some(&ace_json::json!({"threadId": "t"})),
                id,
                Timeout::After(ms),
            )
            .expect("the call is queued");
        }
    });
    let deadline = |ms: f64| {
        effects
            .iter()
            .find_map(|effect| match effect {
                HostEffect::ArmTimer { key, ms: armed } if *armed == ms => Some(key.clone()),
                _ => None,
            })
            .expect("the call's deadline is armed")
    };
    let first = deadline(1_000.0);
    let second = deadline(2_000.0);

    // Park inside the first settlement, settle the other while it is in
    // flight, then let the parked delivery unwind.
    sink.hold_next_settlement();
    sink.lose_next_settlement();
    let ticking = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.timer(&first))
    };
    assert!(sink.wait_parked(), "the publisher is inside a settlement");
    host.timer(&second);
    sink.let_go();
    ticking.join().expect("the timer's input returns");

    assert!(host.poisoned());
    assert!(
        sink.published()
            .iter()
            .any(|thing| matches!(thing, Published::Effect(HostEffect::Settle { id: 8, .. }))),
        "the settlement queued before the panic is still delivered: {:?}",
        sink.published()
    );
}

/// A stop already queued behind the panicking effect is not lost: the child is
/// stopped by it, exactly once.
#[test]
fn the_child_is_stopped_when_its_stop_was_already_queued() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.hold_next_frame();
    sink.lose_next_frame();
    let first = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.line(&completed("first")))
    };
    assert!(sink.wait_parked(), "the publisher is inside a frame");
    // The stop is decided while the sink is in flight, so it waits in the queue
    // behind the effect that is about to unwind.
    host.retire(Retirement::User);
    sink.let_go();
    first.join().expect("the frame's input returns");

    assert!(host.poisoned());
    assert_eq!(
        sink.stops(),
        1,
        "the queued stop still stops the child: {:?}",
        sink.published()
    );
}

/// A second panic during the cleanup skips that effect and nothing else: the
/// child is still stopped and the other channels still hear their exits.
#[test]
fn a_second_panic_during_cleanup_still_stops_the_child_and_exits_the_others() {
    let sink = Arc::new(Holding::default());
    let host = sink.start_pair();
    // The first write unwinds, poisoning the host; the first exit unwinds too.
    sink.lose_next_write(false);
    sink.lose_next_exit();
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");

    assert!(host.poisoned());
    assert_eq!(sink.stops(), 1, "the child is stopped by the poison");
    assert!(
        sink.published().iter().any(|thing| matches!(
            thing,
            Published::Effect(HostEffect::Exited { tenant: 2, .. })
        )),
        "the second channel still hears its exit: {:?}",
        sink.published()
    );
    assert_eq!(host.queued(), 0, "every effect was handed over or skipped");
}

/// A stop that was decided before the poison is still carried out: when the
/// queued `Retire` is the effect that unwinds, the poison hands the stop over
/// itself instead of trusting a delivery that panicked.
#[test]
fn a_stop_that_unwinds_is_still_carried_out_by_the_poison() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.lose_next_retire();
    host.retire(Retirement::User);

    assert!(host.poisoned());
    assert_eq!(
        sink.stops(),
        1,
        "the child is stopped although its stop was the effect that unwound: {:?}",
        sink.published()
    );
}

/// A stop the poison could not make (a tree that outlived it) does not leave a
/// host nobody can stop: its owner's next retire stops the child.
#[test]
fn a_failed_stop_after_the_poison_still_lets_its_owner_stop_the_child() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.fail_next_stop();
    let _ = sink.pump(&host, || {});
    sink.lose_next_write(false);
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    assert!(host.poisoned());
    assert_eq!(sink.stops(), 1);
    assert_eq!(sink.failed_stops(), 1, "the poison's own stop failed");

    // The pool's shutdown asks again, and the child stops.
    host.retire(Retirement::Shutdown);
    assert_eq!(sink.stops(), 2, "the owner's retire stops the child");
    assert_eq!(sink.failed_stops(), 1, "and this stop succeeds");
}

/// A write decided before the poison is not sent to a child that is being
/// stopped: the turn it carried has already failed.
#[test]
fn a_write_queued_behind_the_panic_is_not_sent() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.hold_next_frame();
    let first = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.line(&completed("first")))
    };
    assert!(sink.wait_parked(), "the publisher is inside a frame");
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        8,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    let before = sink.published().len();
    sink.lose_next_frame();
    sink.let_go();
    first.join().expect("the frame's input returns");

    assert!(host.poisoned());
    let published = sink.published();
    assert!(
        published[before..]
            .iter()
            .any(|thing| matches!(thing, Published::Frame { .. })),
        "the frame decided before the poison still reaches its channel"
    );
    assert!(
        !published[before..]
            .iter()
            .any(|thing| matches!(thing, Published::Effect(HostEffect::Write { .. }))),
        "no write reaches the child after the poison: {:?}",
        &published[before..]
    );
    assert!(
        published[before..].iter().any(|thing| matches!(
            thing,
            Published::Effect(HostEffect::Settle { id: 8, result: Err(error) })
                if error.message() == HOST_FAILED
        )),
        "the call whose write was dropped fails with the host error: {:?}",
        &published[before..]
    );
}

/// A stop that already landed before the child exited is not made again: the
/// poison's own exit must not reach a process that is gone.
#[test]
fn a_stop_that_already_landed_is_not_repeated_by_the_poison() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    host.retire(Retirement::User);
    assert_eq!(sink.stops(), 1, "the retire stops the child");

    // The child exits and its pipes close; an exit delivery then unwinds.
    sink.lose_next_exit();
    host.exit(RawExit {
        code: Some(0),
        signal: None,
    });
    host.closed(RawExit {
        code: Some(0),
        signal: None,
    });

    assert!(host.poisoned());
    assert_eq!(
        sink.stops(),
        1,
        "a child that has exited is never stopped again: {:?}",
        sink.published()
    );
}

/// A child that crashed is never stopped by the poison: there is no process to
/// signal, and a reused pid would be someone else's.
#[test]
fn a_crashed_child_is_never_stopped_by_the_poison() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.lose_next_exit();
    host.exit(RawExit {
        code: Some(3),
        signal: None,
    });
    host.closed(RawExit {
        code: Some(3),
        signal: None,
    });

    assert!(host.poisoned());
    assert_eq!(
        sink.stops(),
        0,
        "a child that crashed is not stopped: {:?}",
        sink.published()
    );
}

/// A retire that arrives while the poison's own stop is in flight joins it
/// instead of signalling the child a second time.
#[test]
fn a_retire_during_the_poisons_stop_joins_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.hold_next_stop();
    sink.lose_next_write(false);
    let poisoning = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || {
            host.request(
                1,
                "thread/read",
                Some(&ace_json::json!({"threadId": "t"})),
                7,
                Timeout::Disabled,
            )
            .expect("the call is queued");
        })
    };
    assert!(sink.wait_parked(), "the poison's stop is in flight");

    host.retire(Retirement::Shutdown);
    sink.let_go();
    poisoning.join().expect("the request's input returns");

    assert!(host.poisoned());
    assert_eq!(
        sink.stops(),
        1,
        "one stop, whichever caller asked: {:?}",
        sink.published()
    );
}

/// A retire after the poison's stop landed asks for nothing more.
#[test]
fn a_retire_after_the_poisons_stop_landed_does_nothing() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let _ = sink.pump(&host, || {});
    sink.lose_next_write(false);
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    assert!(host.poisoned());
    assert_eq!(sink.stops(), 1);

    host.retire(Retirement::Shutdown);
    assert_eq!(sink.stops(), 1, "the child is already stopped");
}

/// A stop that unwinds never landed: it is not counted as done, so the owner
/// can still stop the child.
#[test]
fn a_stop_that_unwinds_may_be_asked_for_again() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.lose_next_stop();
    sink.lose_next_write(false);
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    assert!(host.poisoned());
    assert_eq!(sink.stops(), 0, "the stop unwound before it landed");

    host.retire(Retirement::Shutdown);
    assert_eq!(
        sink.stops(),
        1,
        "a stop that unwound is asked for again: {:?}",
        sink.published()
    );
}

/// A stop that failed stays failed: a delivery that the shell could not confirm
/// must not be counted as landed, or the tree leaks.
#[test]
fn a_stop_that_failed_in_the_queue_is_not_counted_as_landed() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.fail_next_stop();
    host.retire(Retirement::User);
    assert_eq!(sink.stops(), 1);
    assert_eq!(sink.failed_stops(), 1, "the retire's stop failed");

    // A poison owes no stop of its own: one was decided, and it failed.
    sink.lose_next_write(false);
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    assert!(host.poisoned());
    assert_eq!(sink.stops(), 1, "the poison repeats no stop");

    host.retire(Retirement::Shutdown);
    assert_eq!(
        sink.stops(),
        2,
        "the failure is not forgotten: the owner stops the child: {:?}",
        sink.published()
    );
}

/// A leader can die while a background-terminal child still holds the pipes,
/// so a poison before the pipe barrier must still stop the tree.
#[test]
fn a_poison_between_the_leaders_exit_and_the_pipes_still_stops_the_tree() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    let _ = sink.pump(&host, || {});

    // The leader dies: the call it was waiting on settles, and that delivery
    // unwinds. The pipes are still open.
    sink.lose_next_settlement();
    host.exit(RawExit {
        code: Some(3),
        signal: None,
    });

    assert!(host.poisoned(), "the settlement's delivery unwound");
    assert_eq!(
        sink.stops(),
        1,
        "a tree that outlived its leader is still stopped: {:?}",
        sink.published()
    );
}

/// A stop that landed through the queue counts as done: the poison and the
/// owner after it ask for nothing more.
#[test]
fn a_queued_stop_that_landed_is_not_repeated_by_its_owner() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    host.retire(Retirement::User);
    assert_eq!(sink.stops(), 1, "the retire's own stop lands");

    // Poison with nothing left to stop.
    sink.lose_next_write(false);
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    assert!(host.poisoned());
    assert_eq!(sink.stops(), 1, "the poison repeats no stop");

    host.retire(Retirement::Shutdown);
    assert_eq!(sink.stops(), 1, "nor does the owner after it");
}

/// The pool starts a new host for the next open once a poisoned one is retired.
#[test]
fn a_poisoned_host_is_replaced_by_the_pool() {
    use crate::session::pool::{Channel, HostPool};

    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let mut pool = HostPool::new(None).expect("the default idle time");
    assert!(pool.claim("key"));
    pool.started("key", Arc::clone(&host));
    assert_eq!(pool.open_channel("key"), Channel::Reuse);

    let _ = sink.pump(&host, || {});
    sink.lose_next_write(false);
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::Disabled,
    )
    .expect("the call is queued");
    assert!(host.poisoned());
    assert!(
        sink.published()
            .iter()
            .any(|thing| matches!(thing, Published::Effect(HostEffect::Retired))),
        "the pool hears the retirement"
    );

    pool.released("key", &host);
    assert_eq!(
        pool.open_channel("key"),
        Channel::Start,
        "the next request starts a new host"
    );
}

/// A server request still queued when its channel leaves is still served to it,
/// but the reply it produces lands after the channel's exit: a sink that drops
/// a channel at its exit never delivers it, and the host reports nothing. TS
/// does the same — `#sent` (`host.ts:437`) ignores a delivery a closed tenant
/// refuses (`deliver`, `host.ts:169`), and the router forgot the attribution at
/// release (`host-routing.ts:81`) — so a reply to a request whose channel
/// closed is dropped silently.
#[test]
fn taking_a_queued_stop_leaves_the_other_effects() {
    let mut publication = Publication::default();
    publication.hold(
        HostEffect::Frame {
            tenant: 1,
            dir: Direction::Recv,
            data: Value::Null,
        },
        Some(4),
    );
    publication.hold(
        HostEffect::Retire {
            reason: Retirement::Idle,
            awaited: false,
        },
        None,
    );
    publication.hold(
        HostEffect::ArmTimer {
            key: "timer".to_owned(),
            ms: 1.0,
        },
        None,
    );
    assert_eq!(publication.backlog(), (1, 4), "a stop reserves no room");

    assert_eq!(
        publication.take_retire(),
        Some((Retirement::Idle, false)),
        "the stop comes out with what it asked for"
    );
    assert_eq!(publication.backlog(), (1, 4), "the rest keeps its room");
    assert_eq!(publication.depth(), 2, "and its place");
    assert_eq!(publication.take_retire(), None, "one stop is taken once");
}
