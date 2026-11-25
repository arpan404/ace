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

    // The channel owns a thread, so a frame for it is routed to it.
    host.request(
        1,
        "thread/resume",
        Some(&ace_json::json!({"threadId": "t"})),
        9,
        Timeout::Default,
    )
    .expect("the open is queued");
    let (_, lines) = sink.pump(&host, || {});
    let opening = line_id(&lines, "thread/resume", Some("t")).expect("the open's id");
    let _ = sink.pump(&host, || {
        host.line(&reply(&opening, ace_json::json!({"thread": {"id": "t"}})));
    });

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
                } if method == "thread/name/updated"
            )
        })
        .expect("the frame reaches its channel");
    assert!(
        settle < delivered,
        "the settlement is published before the frame decided after it"
    );
}

/// One thing the shell published, in the order it published it.
#[derive(Debug, Clone, PartialEq)]
enum Published {
    /// One effect, as the host decided it.
    Effect(HostEffect),
    /// One frame delivered to its channel, by method.
    Frame { tenant: u64, method: String },
}

/// A channel that records each frame it is given in the shell's own log, so a
/// case can tell where a delivery falls in the publication order.
struct Channel {
    tenant: u64,
    log: Arc<Mutex<Vec<Published>>>,
}

impl ChannelHandlers for Channel {
    fn admit(&self, _dir: Direction, _data: &Value) -> Admission {
        Admission::Taken
    }

    fn frame(&self, _dir: Direction, data: &Value) {
        self.log
            .lock()
            .expect("publication log")
            .push(Published::Frame {
                tenant: self.tenant,
                method: data
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            });
    }

    fn notification(&self, _method: &JsString, _params: Option<&Value>) {}
    fn request(&self, _id: &RpcId, _method: &JsString, _params: Option<&Value>) -> RequestAnswer {
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

/// A sink that can hold the publisher inside one settlement, records every
/// effect in the order it publishes it, and delivers frames to their channel.
#[derive(Default)]
struct Holding {
    log: Arc<Mutex<Vec<Published>>>,
    read: Mutex<usize>,
    hold: Mutex<bool>,
    parked: Mutex<bool>,
    parked_wake: Condvar,
    release: Mutex<bool>,
    released: Condvar,
    handlers: Mutex<HashMap<u64, Arc<dyn ChannelHandlers>>>,
}

impl Holding {
    /// A host whose shell is this sink, its handshake answered and one channel
    /// attached.
    fn start(self: &Arc<Self>) -> Arc<Host> {
        let host = Arc::new(Host::new(HostConfig::shared(initialize(), 60_000.0)));
        host.set_sink(Arc::clone(self) as Arc<dyn HostSink>);
        let (_, lines) = self.pump(&host, || {});
        let id = line_id(&lines, "initialize", None).expect("the handshake was sent");
        let _ = self.pump(&host, || {
            host.line(&reply(&id, ace_json::json!({"userAgent": "fake"})));
        });
        let channel: Arc<dyn ChannelHandlers> = Arc::new(Channel {
            tenant: 1,
            log: Arc::clone(&self.log),
        });
        self.handlers
            .lock()
            .expect("channel handlers")
            .insert(1, Arc::clone(&channel));
        host.attach(1, channel).expect("the host accepts a channel");
        let _ = self.pump(&host, || {});
        host
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

    fn let_go(&self) {
        *self.release.lock().expect("release") = true;
        self.released.notify_all();
    }
}

impl HostSink for Holding {
    fn effect(&self, _host: &Host, effect: HostEffect) {
        // A frame reaches its channel here, in the order the host published it:
        // the channel records the delivery in the same log.
        if let HostEffect::Frame { tenant, dir, data } = &effect {
            let handler = self
                .handlers
                .lock()
                .expect("channel handlers")
                .get(tenant)
                .cloned();
            if let Some(handler) = handler {
                handler.frame(*dir, data);
            }
            return;
        }
        let hold = {
            let mut hold = self.hold.lock().expect("hold");
            let holding = *hold && matches!(effect, HostEffect::Settle { .. });
            if holding {
                *hold = false;
            }
            holding
        };
        if hold {
            *self.parked.lock().expect("parked") = true;
            self.parked_wake.notify_all();
            let mut released = self.release.lock().expect("release");
            while !*released {
                released = self.released.wait(released).expect("release wait");
            }
        }
        self.log
            .lock()
            .expect("publication log")
            .push(Published::Effect(effect));
    }
}
