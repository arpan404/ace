// SPDX-License-Identifier: Apache-2.0
//! Publication: the host hands every effect to the shell in the order it
//! decided it, frames included. The cases park the publisher inside one effect,
//! so a second input decides while the first is still going out
//! (`bridge.rs`'s ordered publication, ADR 0223 §7 rule 3; `porting-guide.md`'s
//! ordered effect publication).

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};

use ace_supervisor::peer::Timeout;
use ace_supervisor::spawn::RawExit;

use super::*;
use crate::session::pool::initialize;

/// One settlement a timer decided is published before the exit a pipe close
/// decides after it, whichever thread reaches the sink first.
#[test]
fn a_settlement_the_timer_decides_is_published_before_the_close_that_follows_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();

    // A call with a deadline: firing that deadline settles the call.
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::After(1_000.0),
    )
    .expect("the call is queued");
    let deadline = sink.deadline(&host, 1_000.0);

    // The timer fires and the publisher is held inside its settlement, which is
    // where the old shell applied effects: the pipe close decides next, and its
    // exit must wait for the settlement already decided.
    sink.hold_next_settlement();
    let ticking = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.timer(&deadline))
    };
    assert!(sink.wait_parked(), "the publisher is inside the settlement");
    host.closed(RawExit {
        code: Some(0),
        signal: None,
    });
    assert!(
        !sink
            .published()
            .iter()
            .any(|thing| matches!(thing, Published::Effect(HostEffect::Exited { .. }))),
        "the close's exit waits for the settlement in flight"
    );
    sink.let_go();
    ticking.join().expect("the timer's input returns");

    let published = sink.published();
    let settle = published
        .iter()
        .position(|thing| matches!(thing, Published::Effect(HostEffect::Settle { id: 7, .. })))
        .expect("the call settles");
    let exit = published
        .iter()
        .position(|thing| {
            matches!(
                thing,
                Published::Effect(HostEffect::Exited { tenant: 1, .. })
            )
        })
        .expect("the channel exits");
    assert!(
        settle < exit,
        "the timer's settlement is published before the close's exit"
    );
}

/// A frame another input decides while the publisher is held inside a
/// settlement is delivered after it: frames and settlements leave in one order,
/// the order the host decided them.
#[test]
fn a_frame_waits_for_the_settlement_the_host_decided_before_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();

    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::After(1_000.0),
    )
    .expect("the call is queued");
    let deadline = sink.deadline(&host, 1_000.0);

    sink.hold_next_settlement();
    let ticking = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.timer(&deadline))
    };
    assert!(sink.wait_parked(), "the publisher is inside the settlement");
    let published = sink.published().len();

    // Another input decides a frame for the same channel while the settlement
    // is still going out. It must reach the channel after the settlement, not
    // ahead of it.
    host.line(&frame(ace_json::json!({
        "jsonrpc": "2.0",
        "method": "thread/name/updated",
        "params": {"threadId": "t", "name": "later"},
    })));
    assert_eq!(
        sink.published().len(),
        published,
        "nothing is published while the publisher is inside the settlement"
    );
    sink.let_go();
    ticking.join().expect("the timer's input returns");

    let published = sink.published();
    let settle = published
        .iter()
        .position(|thing| matches!(thing, Published::Effect(HostEffect::Settle { id: 7, .. })))
        .expect("the call settles");
    let delivered = published
        .iter()
        .position(|thing| {
            matches!(
                thing,
                Published::Frame {
                    tenant: 1,
                    method,
                    ..
                } if method == "thread/name/updated"
            )
        })
        .expect("the frame reaches its channel");
    assert!(
        settle < delivered,
        "the settlement is published before the frame decided after it"
    );
}

/// A notification follows the frame it belongs to: an input that decides both
/// while the publisher is held inside a settlement publishes the frame, then
/// the notification, after the settlement.
#[test]
fn a_notification_is_published_after_the_frame_it_belongs_to() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let published = parked_settlement(&sink, &host, || {
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/name/updated",
            "params": {"threadId": "t", "name": "later"},
        })));
    });
    let settle = settle_at(&published);
    let delivered = position(
        &published,
        |thing| matches!(thing, Published::Frame { tenant: 1, method, .. } if method == "thread/name/updated"),
    );
    let notified = position(
        &published,
        |thing| matches!(thing, Published::Notification { tenant: 1, method } if method == "thread/name/updated"),
    );
    assert!(
        settle < delivered,
        "the settlement is published before the frame decided after it"
    );
    assert!(
        delivered < notified,
        "the notification follows the frame it belongs to"
    );
}

/// A server request is published after its frame, and its answer goes back
/// through the host, so the reply keeps the host's order too.
#[test]
fn a_server_request_is_published_after_the_frame_it_belongs_to() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let published = parked_settlement(&sink, &host, || {
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "id": "ask-1",
            "method": "mcpServer/elicitation/request",
            "params": {"threadId": "t", "serverName": "docs", "mode": "form"},
        })));
    });
    let settle = settle_at(&published);
    let delivered = position(&published, |thing| {
        matches!(
            thing,
            Published::Frame { tenant: 1, method, .. } if method == "mcpServer/elicitation/request"
        )
    });
    let served = position(&published, |thing| {
        matches!(
            thing,
            Published::Request { tenant: 1, method } if method == "mcpServer/elicitation/request"
        )
    });
    assert!(
        settle < delivered,
        "the settlement is published before the frame decided after it"
    );
    assert!(
        delivered < served,
        "the request follows the frame it belongs to"
    );
}

/// A refused frame's failure callback is published like everything else: a
/// channel never hears about the refusal before the effects decided before it.
#[test]
fn an_admission_failure_is_published_after_the_settlement_before_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let published = parked_settlement(&sink, &host, || {
        sink.refuse_next_frame("translation broke");
        host.line(&frame(ace_json::json!({
            "jsonrpc": "2.0",
            "method": "thread/name/updated",
            "params": {"threadId": "t", "name": "later"},
        })));
    });
    let settle = settle_at(&published);
    let failed = position(&published, |thing| {
        matches!(
            thing,
            Published::Failed { tenant: 1, message } if message == "translation broke"
        )
    });
    assert!(
        settle < failed,
        "the failure is published after the settlement decided before it"
    );
}

/// A dropped output line reaches its channel in the host's order, after the
/// settlement decided before it.
#[test]
fn a_dropped_line_is_published_after_the_settlement_before_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let published = parked_settlement(&sink, &host, || {
        host.dropped(&DroppedLine {
            bytes: 20_000_000,
            phase: DroppedPhase::Line,
            thread: None,
            response: None,
        });
    });
    let settle = settle_at(&published);
    let dropped = position(
        &published,
        |thing| matches!(thing, Published::Dropped { tenant: 1, bytes } if *bytes == 20_000_000),
    );
    assert!(
        settle < dropped,
        "the dropped line is published after the settlement decided before it"
    );
}

/// A diagnostic line reaches every channel in the host's order, after the
/// settlement decided before it.
#[test]
fn a_diagnostic_line_is_published_after_the_settlement_before_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    let published = parked_settlement(&sink, &host, || {
        host.stderr_line("mcp server says hello");
    });
    let settle = settle_at(&published);
    let heard = position(
        &published,
        |thing| matches!(thing, Published::Diagnostic { tenant: 1, text } if text == "mcp server says hello"),
    );
    assert!(
        settle < heard,
        "the diagnostic is published after the settlement decided before it"
    );
}

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
fn a_reply_produced_after_its_channels_exit_is_dropped_silently() {
    let sink = Arc::new(Holding::default());
    let host = sink.start_alone();

    // The publisher is held inside one frame, so the request and the detach are
    // both decided before either goes out.
    sink.hold_next_frame();
    let first = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.line(&completed("first")))
    };
    assert!(sink.wait_parked(), "the publisher is inside a frame");

    host.line(&frame(ace_json::json!({
        "jsonrpc": "2.0",
        "id": "ask-1",
        "method": "mcpServer/elicitation/request",
        "params": {"serverName": "docs", "mode": "form"},
    })));
    // The channel owns no thread, so its close completes at once and its exit
    // is queued behind the request it is still owed an answer for.
    host.detach(1, Retirement::User, "user closed");
    sink.let_go();
    first.join().expect("the frame's input returns");

    let published = sink.published();
    assert!(
        published
            .iter()
            .any(|thing| matches!(thing, Published::Request { tenant: 1, .. })),
        "the channel is asked for its request before it leaves: {published:#?}"
    );
    assert!(
        !published.iter().any(|thing| matches!(
            thing,
            Published::Frame { tenant: 1, dir: Direction::Send, id: Some(id), .. } if id == "ask-1"
        )),
        "the reply is never delivered to a channel that left: {published:#?}"
    );
    assert!(
        !published
            .iter()
            .any(|thing| matches!(thing, Published::Effect(HostEffect::Error { .. }))),
        "and nothing is reported for it, as TS logs nothing: {published:#?}"
    );
}

/// A blocked sink's backlog closes the gate at TS's intake budget — 256 queued
/// frames or 4 MiB, back below 64 frames and 1 MiB
/// (`apps/daemon/src/engine/actor.ts:84`–`:103`, `engine/limits.ts:9`–`:17`) —
/// so the child's pumps stop reading, and it reopens when the sink drains.
#[test]
fn a_blocked_sink_closes_the_gate_at_the_intake_budget_and_draining_reopens_it() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();

    // The publisher is held inside one frame: what the drain decides from now
    // on waits in the queue.
    sink.hold_next_frame();
    let first = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.line(&renamed("first")))
    };
    assert!(sink.wait_parked(), "the publisher is inside a frame");
    assert!(!host.paused(), "one frame in flight is not a backlog");

    let mut queued = 0;
    while !host.paused() && queued < 1_000 {
        host.line(&renamed(&format!("later-{queued}")));
        queued += 1;
    }
    assert!(
        host.paused(),
        "the gate closes once the queue holds the intake budget"
    );
    assert!(
        queued < 256,
        "the budget counts every payload-bearing effect, so fewer inputs than the\
         budget closed it: {queued}"
    );

    sink.let_go();
    first.join().expect("the frame's input returns");
    assert!(!host.paused(), "the sink drained: the gate reopens");
    assert!(sink.published().iter().any(|thing| matches!(
        thing,
        Published::Frame { tenant: 1, method, .. } if method == "thread/name/updated"
    )));
}

/// A backlog of non-frame payloads counts against the same budget: a blocked
/// sink's flood of diagnostics closes the gate at the byte budget, so the
/// child's lines cannot pile up while delivery is stopped.
#[test]
fn a_blocked_sink_counts_diagnostics_against_the_intake_budget() {
    let sink = Arc::new(Holding::default());
    let host = sink.start();
    sink.hold_next_frame();
    let first = {
        let host = Arc::clone(&host);
        std::thread::spawn(move || host.line(&renamed("first")))
    };
    assert!(sink.wait_parked(), "the publisher is inside a frame");

    let line = "d".repeat(64 * 1024);
    let mut sent = 0;
    while !host.paused() && sent < 200 {
        host.stderr_line(&line);
        sent += 1;
    }
    assert!(
        host.paused(),
        "the byte budget closes the gate on diagnostics, after {sent} lines"
    );
    assert!(
        sent <= 64,
        "no more than the budget's worth is queued: {sent} lines of 64 KiB"
    );

    sink.let_go();
    first.join().expect("the frame's input returns");
    assert!(!host.paused(), "the sink drained: the gate reopens");
}

/// A single input can release a hold above the byte budget with far fewer than
/// 256 entries: that batch must be measured too, so the gate closes while it
/// waits for a blocked sink.
#[test]
fn a_released_hold_above_the_byte_budget_closes_the_gate() {
    let sink = Arc::new(Holding::default());
    let host = sink.start_pair();

    // Two channels, so a frame for a thread nobody owns waits in the host's
    // hold instead of reaching one of them: three 2 MiB frames, one batch.
    let big = "x".repeat(2 * 1024 * 1024);
    for index in 0..3 {
        host.line(&completed_for("owner", &format!("{index}{big}")));
    }

    host.request(
        1,
        "thread/resume",
        Some(&ace_json::json!({"threadId": "owner"})),
        9,
        Timeout::Default,
    )
    .expect("the open is queued");
    let (_, lines) = sink.pump(&host, || {});
    let opening = line_id(&lines, "thread/resume", Some("owner")).expect("the open's id");

    // Claiming the thread releases the hold in one input; the publisher is held
    // inside the first frame, so the rest of the batch waits.
    sink.hold_next_frame();
    let claiming = {
        let host = Arc::clone(&host);
        let reply = reply(&opening, ace_json::json!({"thread": {"id": "owner"}}));
        std::thread::spawn(move || host.line(&reply))
    };
    assert!(
        sink.wait_parked(),
        "the publisher is inside a released frame"
    );
    assert!(
        host.paused(),
        "the gate closes on a released hold above the budget"
    );

    sink.let_go();
    claiming.join().expect("the open's reply returns");
    assert!(!host.paused(), "the hold drained: the gate reopens");
    let delivered = sink
        .published()
        .iter()
        .filter(|thing| {
            matches!(
                thing,
                Published::Frame {
                    tenant: 1,
                    dir: Direction::Recv,
                    method,
                    ..
                } if method == "item/completed"
            )
        })
        .count();
    assert_eq!(delivered, 3, "every held frame reached the channel");
}

/// One thing the shell published, in the order it published it.
#[derive(Debug, Clone, PartialEq)]
enum Published {
    /// One effect, as the host decided it.
    Effect(HostEffect),
    /// One frame delivered to its channel, by direction, method and id.
    Frame {
        tenant: u64,
        dir: Direction,
        method: String,
        id: Option<String>,
    },
    /// One notification delivered to its channel, by method.
    Notification { tenant: u64, method: String },
    /// One server request served to its channel, by method.
    Request { tenant: u64, method: String },
    /// One refused frame, and why.
    Failed { tenant: u64, message: String },
    /// One dropped output line.
    Dropped { tenant: u64, bytes: usize },
    /// One diagnostic line.
    Diagnostic { tenant: u64, text: String },
    /// The child was stopped, by a queued `Retire` or by the poison.
    Stopped { awaited: bool },
}

/// A channel that records each frame it is given in the shell's own log, so a
/// case can tell where a delivery falls in the publication order.
struct Channel {
    tenant: u64,
    log: Arc<Mutex<Vec<Published>>>,
    refuse: Arc<Mutex<Option<String>>>,
}

impl Channel {
    fn record(&self, thing: Published) {
        self.log.lock().expect("publication log").push(thing);
    }
}

impl ChannelHandlers for Channel {
    fn admit(&self, _dir: Direction, _data: &Value) -> Admission {
        match self.refuse.lock().expect("refuse").take() {
            Some(message) => Admission::Failed(message),
            None => Admission::Taken,
        }
    }

    fn frame(&self, dir: Direction, data: &Value) {
        let id = match data.get("id") {
            Some(Value::String(text)) => Some(text.as_str().to_owned()),
            Some(Value::Number(number)) => number.as_f64().map(|id| id.to_string()),
            _ => None,
        };
        self.record(Published::Frame {
            tenant: self.tenant,
            dir,
            method: method_of(data),
            id,
        });
    }

    fn notification(&self, method: &JsString, _params: Option<&Value>) {
        self.record(Published::Notification {
            tenant: self.tenant,
            method: method.as_str().to_owned(),
        });
    }

    fn request(&self, _id: &RpcId, method: &JsString, _params: Option<&Value>) -> RequestAnswer {
        self.record(Published::Request {
            tenant: self.tenant,
            method: method.as_str().to_owned(),
        });
        RequestAnswer::Answered(ace_json::json!({}))
    }

    fn dropped(&self, line: &DroppedLine) {
        self.record(Published::Dropped {
            tenant: self.tenant,
            bytes: line.bytes,
        });
    }

    fn output_uncertain(&self) {}
    fn malformed(&self, _line: &str) {}
    fn stderr(&self, line: &str) {
        self.record(Published::Diagnostic {
            tenant: self.tenant,
            text: line.to_owned(),
        });
    }
    fn error(&self, _message: &str) {}
    fn failed(&self, message: &str) {
        self.record(Published::Failed {
            tenant: self.tenant,
            message: message.to_owned(),
        });
    }
    fn exited(&self, _exit: &HostExit) {}
    fn ready(&self) {}
}

/// How a frame's data names its method.
fn method_of(data: &Value) -> String {
    data.get("method")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// One `thread/name/updated` notification for the channel's thread.
fn renamed(name: &str) -> String {
    frame(ace_json::json!({
        "jsonrpc": "2.0",
        "method": "thread/name/updated",
        "params": {"threadId": "t", "name": name},
    }))
}

/// One `item/completed` frame for `thread`.
fn completed_for(thread: &str, text: &str) -> String {
    frame(ace_json::json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": thread,
            "turnId": "turn-1",
            "item": {"type": "agentMessage", "id": "m", "text": text},
        },
    }))
}

/// One `item/completed` frame for the channel's thread.
fn completed(text: &str) -> String {
    frame(ace_json::json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "threadId": "t",
            "turnId": "turn-1",
            "item": {"type": "agentMessage", "id": "m", "text": text},
        },
    }))
}

/// The position of the first published thing `pred` takes.
fn position(published: &[Published], pred: impl Fn(&Published) -> bool) -> usize {
    published
        .iter()
        .position(pred)
        .expect("the thing is published")
}

/// The position of call 7's settlement.
fn settle_at(published: &[Published]) -> usize {
    position(published, |thing| {
        matches!(thing, Published::Effect(HostEffect::Settle { id: 7, .. }))
    })
}

/// The publication log after `decide` runs while the publisher is held inside
/// the settlement of call 7: nothing `decide` publishes reaches the shell until
/// the settlement is done.
fn parked_settlement(
    sink: &Arc<Holding>,
    host: &Arc<Host>,
    decide: impl FnOnce(),
) -> Vec<Published> {
    host.request(
        1,
        "thread/read",
        Some(&ace_json::json!({"threadId": "t"})),
        7,
        Timeout::After(1_000.0),
    )
    .expect("the call is queued");
    let deadline = sink.deadline(host, 1_000.0);

    sink.hold_next_settlement();
    let ticking = {
        let host = Arc::clone(host);
        std::thread::spawn(move || host.timer(&deadline))
    };
    assert!(sink.wait_parked(), "the publisher is inside the settlement");
    let published = sink.published().len();
    decide();
    assert_eq!(
        sink.published().len(),
        published,
        "nothing is published while the publisher is inside the settlement"
    );
    sink.let_go();
    ticking.join().expect("the timer's input returns");
    sink.published()
}

/// A sink that can hold the publisher inside one settlement, records every
/// effect in the order it publishes it, and delivers frames to their channel.
#[derive(Default)]
struct Holding {
    log: Arc<Mutex<Vec<Published>>>,
    read: Mutex<usize>,
    hold: Mutex<bool>,
    hold_frame: Mutex<bool>,
    lose_frame: Mutex<bool>,
    lose_settlement: Mutex<bool>,
    lose_exit: Mutex<bool>,
    lose_write: Mutex<Option<bool>>,
    parked: Mutex<bool>,
    parked_wake: Condvar,
    release: Mutex<bool>,
    released: Condvar,
    handlers: Mutex<HashMap<u64, Arc<dyn ChannelHandlers>>>,
    /// The next frame's refusal, which the channel reports.
    refuse: Arc<Mutex<Option<String>>>,
}

impl Holding {
    /// A host whose shell is this sink, its handshake answered, one channel
    /// attached and a thread of its own.
    fn start(self: &Arc<Self>) -> Arc<Host> {
        let host = self.start_alone();
        // The channel owns a thread, so a frame for it is routed to it.
        host.request(
            1,
            "thread/resume",
            Some(&ace_json::json!({"threadId": "t"})),
            9,
            Timeout::Default,
        )
        .expect("the open is queued");
        let (_, lines) = self.pump(&host, || {});
        let opening = line_id(&lines, "thread/resume", Some("t")).expect("the open's id");
        let _ = self.pump(&host, || {
            host.line(&reply(&opening, ace_json::json!({"thread": {"id": "t"}})));
        });
        host
    }

    /// A host with two channels attached and no threads of their own.
    fn start_pair(self: &Arc<Self>) -> Arc<Host> {
        self.start_with(&[1, 2])
    }

    /// A host whose shell is this sink, its handshake answered and one channel
    /// attached, with no thread of its own.
    fn start_alone(self: &Arc<Self>) -> Arc<Host> {
        self.start_with(&[1])
    }

    /// A host with the given channels attached.
    fn start_with(self: &Arc<Self>, tenants: &[u64]) -> Arc<Host> {
        let host = Arc::new(Host::new(HostConfig::shared(initialize(), 60_000.0)));
        host.set_sink(Arc::clone(self) as Arc<dyn HostSink>);
        let (_, lines) = self.pump(&host, || {});
        let id = line_id(&lines, "initialize", None).expect("the handshake was sent");
        let _ = self.pump(&host, || {
            host.line(&reply(&id, ace_json::json!({"userAgent": "fake"})));
        });
        for tenant in tenants {
            let channel: Arc<dyn ChannelHandlers> = Arc::new(Channel {
                tenant: *tenant,
                log: Arc::clone(&self.log),
                refuse: Arc::clone(&self.refuse),
            });
            self.handlers
                .lock()
                .expect("channel handlers")
                .insert(*tenant, Arc::clone(&channel));
            host.attach(*tenant, channel)
                .expect("the host accepts a channel");
        }
        let _ = self.pump(&host, || {});
        host
    }

    /// The channel refuses the next frame, with `message`.
    fn refuse_next_frame(&self, message: &str) {
        *self.refuse.lock().expect("refuse") = Some(message.to_owned());
    }

    /// The deadline of the last call's timer that arms at `ms`.
    fn deadline(&self, host: &Host, ms: f64) -> String {
        self.pump(host, || {})
            .0
            .into_iter()
            .find_map(|effect| match effect {
                HostEffect::ArmTimer { key, ms: armed } if armed == ms => Some(key),
                _ => None,
            })
            .expect("the call's deadline is armed")
    }

    fn published(&self) -> Vec<Published> {
        self.log.lock().expect("publication log").clone()
    }

    /// Runs one input, then acknowledges every write it published, as the
    /// child's stdin would, and returns the other effects and the lines
    /// written.
    fn pump(&self, host: &Host, run: impl FnOnce()) -> (Vec<HostEffect>, Vec<String>) {
        let mut rest = Vec::new();
        let mut lines = Vec::new();
        let mut read = self.read.lock().expect("publication read");
        run();
        loop {
            let next = self
                .log
                .lock()
                .expect("publication log")
                .get(*read)
                .cloned();
            let Some(thing) = next else {
                return (rest, lines);
            };
            *read += 1;
            let Published::Effect(effect) = thing else {
                continue;
            };
            match effect {
                HostEffect::Write { wire, ticket } => {
                    if let Ok(text) = std::str::from_utf8(&wire) {
                        lines.push(text.trim_end().to_owned());
                    }
                    host.written(ticket);
                }
                other => rest.push(other),
            }
        }
    }

    fn hold_next_settlement(&self) {
        *self.hold.lock().expect("hold") = true;
    }

    /// Holds the publisher inside the next frame, once.
    fn hold_next_frame(&self) {
        *self.hold_frame.lock().expect("hold frame") = true;
    }

    /// Unwinds on the next frame, once, after any hold.
    fn lose_next_frame(&self) {
        *self.lose_frame.lock().expect("lose frame") = true;
    }

    /// Unwinds on the next settlement, once, after any hold.
    fn lose_next_settlement(&self) {
        *self.lose_settlement.lock().expect("lose settlement") = true;
    }

    /// Unwinds on the next channel exit, once.
    fn lose_next_exit(&self) {
        *self.lose_exit.lock().expect("lose exit") = true;
    }

    /// How many times the shell stopped the child.
    fn stops(&self) -> usize {
        self.published()
            .iter()
            .filter(|thing| matches!(thing, Published::Stopped { .. }))
            .count()
    }

    /// Unwinds on the next write, once, after acknowledging it when `submitted`.
    fn lose_next_write(&self, submitted: bool) {
        *self.lose_write.lock().expect("lose write") = Some(submitted);
    }

    fn wait_parked(&self) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut parked = self.parked.lock().expect("parked");
        loop {
            if *parked {
                return true;
            }
            let Some(left) = deadline.checked_duration_since(std::time::Instant::now()) else {
                return false;
            };
            let (next, _) = self
                .parked_wake
                .wait_timeout(parked, left)
                .expect("parked wait");
            parked = next;
        }
    }

    /// Holds the publisher until `let_go`, and says it is here.
    fn park(&self) {
        *self.parked.lock().expect("parked") = true;
        self.parked_wake.notify_all();
        let mut released = self.release.lock().expect("release");
        while !*released {
            released = self.released.wait(released).expect("release wait");
        }
    }

    fn let_go(&self) {
        *self.release.lock().expect("release") = true;
        self.released.notify_all();
    }
}

impl HostSink for Holding {
    fn stop(&self, _host: &Host, _reason: Retirement, awaited: bool) {
        self.log
            .lock()
            .expect("publication log")
            .push(Published::Stopped { awaited });
    }

    fn effect(&self, host: &Host, effect: HostEffect) {
        // The hooks meet an effect in the order a sink would: a hold parks it,
        // then a scripted unwind lets it go.
        if matches!(effect, HostEffect::Frame { .. }) {
            if take(&self.hold_frame) {
                self.park();
            }
            if take(&self.lose_frame) {
                panic!("the shell unwinds on a frame");
            }
        }
        if matches!(effect, HostEffect::Settle { .. }) {
            if take(&self.hold) {
                self.park();
            }
            if take(&self.lose_settlement) {
                panic!("the shell unwinds on a settlement");
            }
        }
        if matches!(effect, HostEffect::Exited { .. }) && take(&self.lose_exit) {
            panic!("the shell unwinds on an exit");
        }
        if let HostEffect::Retire { reason, awaited } = effect {
            self.stop(host, reason, awaited);
            return;
        }
        if let HostEffect::Exited { tenant, exit } = &effect {
            // A session leaves with its exit: the sink forgets its channel, so
            // nothing after it is delivered there.
            let channel = self
                .handlers
                .lock()
                .expect("channel handlers")
                .remove(tenant);
            if let Some(channel) = channel {
                channel.exited(exit);
            }
        }
        // Frames and callbacks reach their channel here, in the order the host
        // published them: the channel records each delivery in the same log.
        if host.hand_over(&effect, |tenant| {
            self.handlers
                .lock()
                .expect("channel handlers")
                .get(&tenant)
                .cloned()
        }) {
            return;
        }
        let lose_write = {
            let mut lose = self.lose_write.lock().expect("lose write");
            match (*lose, &effect) {
                (Some(submitted), HostEffect::Write { ticket, .. }) => {
                    *lose = None;
                    Some((submitted, *ticket))
                }
                _ => None,
            }
        };
        if let Some((submitted, ticket)) = lose_write {
            if submitted {
                // The bytes reached the child's stdin before the shell unwound.
                host.written(ticket);
            }
            panic!("the shell unwinds on a write");
        }
        self.log
            .lock()
            .expect("publication log")
            .push(Published::Effect(effect));
    }
}

/// Takes a one-shot flag.
fn take(flag: &Mutex<bool>) -> bool {
    let mut flag = flag.lock().expect("one-shot flag");
    let armed = *flag;
    *flag = false;
    armed
}
