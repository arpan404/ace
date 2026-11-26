// SPDX-License-Identifier: Apache-2.0

//! Bounded delivery inside the daemon (`frame-hub.ts`): one frame in flight and the newest
//! pending per viewer, no history. A viewer the hub drops itself (its sink failed, or the hub
//! was cleared) hears it through `ended`, so whatever it holds is released as on unsubscribe.
//! A second kind of subscriber takes every frame as it is published, for a consumer that paces
//! itself (the shared media stream's ack window) and so must not lose one to coalescing.

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use super::frames::Frame;

/// A viewer's sink: it returns when it has taken the frame.
pub type Sink<T> = Arc<dyn Fn(T) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;
/// A listener's sink: it takes every frame, synchronously.
pub type EverySink<T> = Arc<dyn Fn(&T) + Send + Sync>;
/// What a dropped viewer hears, once.
pub type Ended = Arc<dyn Fn() + Send + Sync>;

/// Viewers one hub accepts (`frame-hub.ts:18`, `:45`).
const SUBSCRIBER_LIMIT: usize = 64;

struct Subscriber {
    id: u64,
    send: Sink<Frame>,
    busy: bool,
    pending: Option<Frame>,
    active: bool,
    ended: Option<Ended>,
}

struct Every {
    id: u64,
    send: EverySink<Frame>,
    ended: Option<Ended>,
}

#[derive(Default)]
struct State {
    next_id: u64,
    subscribers: Vec<Subscriber>,
    every: Vec<Every>,
}

impl State {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }
}

/// The hub for one screen stream (`FrameHub`, `frame-hub.ts:132`).
#[derive(Clone, Default)]
pub struct FrameHub {
    state: Arc<Mutex<State>>,
}

/// One subscription: dropping it unsubscribes, and `stop` does so at once.
pub struct Subscription {
    hub: Option<Arc<Mutex<State>>>,
    id: u64,
    every: bool,
}

impl Subscription {
    /// Stop this viewer now (`frame-hub.ts:31`, `:68`).
    pub fn stop(&mut self) {
        let Some(hub) = self.hub.take() else {
            return;
        };
        let mut state = hub.lock().unwrap_or_else(|error| error.into_inner());
        if self.every {
            state.every.retain(|listener| listener.id != self.id);
        } else if let Some(index) = state
            .subscribers
            .iter()
            .position(|subscriber| subscriber.id == self.id)
        {
            let mut subscriber = state.subscribers.remove(index);
            subscriber.active = false;
            subscriber.pending = None;
        }
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.stop();
    }
}

impl FrameHub {
    pub fn new() -> FrameHub {
        FrameHub::default()
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// A viewer that gets the newest frame (`frame-hub.ts:19`). `initial` is offered before the
    /// call returns, so a new viewer sees a frame without replaying it to the others.
    pub fn subscribe(
        &self,
        send: Sink<Frame>,
        initial: Option<Frame>,
        ended: Option<Ended>,
    ) -> Result<Subscription, String> {
        let id = {
            let mut state = self.state();
            if state.subscribers.len() >= SUBSCRIBER_LIMIT {
                return Err("Subscriber limit".to_owned());
            }
            let id = state.id();
            state.subscribers.push(Subscriber {
                id,
                send,
                busy: false,
                pending: None,
                active: true,
                ended,
            });
            id
        };
        if let Some(frame) = initial {
            deliver(self.clone(), id, frame);
        }
        Ok(Subscription {
            hub: Some(Arc::clone(&self.state)),
            id,
            every: false,
        })
    }

    /// A listener that gets every frame, in order (`frame-hub.ts:45`). A listener that panics
    /// is removed and hears `ended`.
    pub fn subscribe_every(
        &self,
        send: EverySink<Frame>,
        initial: Option<Frame>,
        ended: Option<Ended>,
    ) -> Result<Subscription, String> {
        let id = {
            let mut state = self.state();
            if state.every.len() >= SUBSCRIBER_LIMIT {
                return Err("Subscriber limit".to_owned());
            }
            let id = state.id();
            state.every.push(Every { id, send, ended });
            id
        };
        if let Some(frame) = initial {
            listen(self, id, &frame);
        }
        Ok(Subscription {
            hub: Some(Arc::clone(&self.state)),
            id,
            every: true,
        })
    }

    /// Hand one frame to every viewer (`frame-hub.ts:86`): listeners first, then each viewer's
    /// newest-frame slot.
    pub fn publish(&self, frame: Frame) {
        let listeners: Vec<(u64, EverySink<Frame>)> = {
            let state = self.state();
            state
                .every
                .iter()
                .map(|listener| (listener.id, Arc::clone(&listener.send)))
                .collect()
        };
        for (id, send) in listeners {
            if catch_unwind(AssertUnwindSafe(|| send(&frame))).is_err() {
                self.drop_every(id);
            }
        }
        let deliveries: Vec<u64> = {
            let mut state = self.state();
            let mut deliveries = Vec::new();
            for subscriber in &mut state.subscribers {
                if subscriber.busy {
                    subscriber.pending = Some(frame.clone());
                } else {
                    subscriber.busy = true;
                    deliveries.push(subscriber.id);
                }
            }
            deliveries
        };
        for id in deliveries {
            deliver(self.clone(), id, frame.clone());
        }
    }

    /// Drop every viewer's queued frame without removing the viewers (`frame-hub.ts:97`).
    pub fn discard_pending(&self) {
        let mut state = self.state();
        for subscriber in &mut state.subscribers {
            subscriber.pending = None;
        }
    }

    /// Drop every viewer and listener, telling each through `ended` (`frame-hub.ts:101`).
    pub fn clear(&self) {
        let (subscribers, listeners) = {
            let mut state = self.state();
            (
                std::mem::take(&mut state.subscribers),
                std::mem::take(&mut state.every),
            )
        };
        for mut subscriber in subscribers {
            subscriber.active = false;
            subscriber.pending = None;
            if let Some(ended) = &subscriber.ended {
                ended();
            }
        }
        for listener in listeners {
            if let Some(ended) = &listener.ended {
                ended();
            }
        }
    }

    /// A listener panicked: remove it, telling its owner once (`frame-hub.ts:52`).
    fn drop_every(&self, id: u64) {
        let ended = {
            let mut state = self.state();
            let Some(index) = state.every.iter().position(|listener| listener.id == id) else {
                return;
            };
            state.every.remove(index).ended
        };
        if let Some(ended) = ended {
            ended();
        }
    }
}

/// One listener's turn (`frame-hub.ts:56`).
fn listen(hub: &FrameHub, id: u64, frame: &Frame) {
    let send = {
        let state = hub.state();
        state
            .every
            .iter()
            .find(|listener| listener.id == id)
            .map(|listener| Arc::clone(&listener.send))
    };
    let Some(send) = send else {
        return;
    };
    if catch_unwind(AssertUnwindSafe(|| send(frame))).is_err() {
        hub.drop_every(id);
    }
}

/// Hand `frame` to one viewer and, when it returns, the newest frame that arrived meanwhile
/// (`frame-hub.ts:113`).
fn deliver(hub: FrameHub, id: u64, frame: Frame) {
    let send = {
        let mut state = hub.state();
        let Some(subscriber) = state
            .subscribers
            .iter_mut()
            .find(|subscriber| subscriber.id == id)
        else {
            return;
        };
        subscriber.busy = true;
        Arc::clone(&subscriber.send)
    };
    tokio::spawn(async move {
        let handle = tokio::spawn(async move { send(frame).await });
        let taken = handle.await.is_ok();
        let mut next = None;
        let mut ended = None;
        {
            let mut state = hub.state();
            let Some(index) = state
                .subscribers
                .iter()
                .position(|subscriber| subscriber.id == id)
            else {
                return;
            };
            if taken {
                let subscriber = &mut state.subscribers[index];
                subscriber.busy = false;
                if subscriber.active {
                    next = subscriber.pending.take();
                } else {
                    subscriber.pending = None;
                }
            } else {
                let mut subscriber = state.subscribers.remove(index);
                let was = subscriber.active;
                subscriber.active = false;
                subscriber.pending = None;
                if was {
                    ended = subscriber.ended.take();
                }
            }
        }
        if let Some(ended) = ended {
            ended();
        }
        if let Some(next) = next {
            deliver(hub, id, next);
        }
    });
}

#[cfg(test)]
// The hub cases, moved from TypeScript (`packages/screen/src/frames.process.test.ts`): slow
// viewers get the newest frame (`:25`), unsubscribe discards queued frames and a failed viewer
// does not block others (`:50`), a new viewer gets its initial frame (`:85`), and the
// subscriber limit frees a slot on unsubscribe (`:102`).
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::sync::{Notify, oneshot};

    use super::{FrameHub, Sink, Subscription};
    use crate::session::frames::{Frame, FrameHeader, wire_frame};

    fn frame(sequence: u64) -> Frame {
        let header = FrameHeader::v1("test", sequence, 8);
        wire_frame(header, &[sequence as u8; 8]).unwrap_or_else(|error| panic!("{error}"))
    }

    fn sink(
        handle: impl Fn(Frame) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        + Send
        + Sync
        + 'static,
    ) -> Sink<Frame> {
        Arc::new(handle)
    }

    fn seen(log: &Arc<Mutex<Vec<u64>>>) -> Vec<u64> {
        log.lock().map(|seen| seen.clone()).unwrap_or_default()
    }

    async fn until(what: &str, condition: impl Fn() -> bool) {
        for _ in 0..1_000 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        panic!("timed out waiting for {what}");
    }

    /// `frames.process.test.ts:25`: a slow viewer keeps only the newest pending frame while a
    /// fast one keeps receiving.
    #[tokio::test]
    async fn slow_subscribers_get_the_newest_frame_and_fast_subscribers_keep_receiving() {
        let hub = FrameHub::new();
        let slow = Arc::new(Mutex::new(Vec::new()));
        let fast = Arc::new(Mutex::new(Vec::new()));
        let started = Arc::new(Notify::new());
        let (gate, release) = oneshot::channel::<()>();
        let release = Arc::new(Mutex::new(Some(release)));
        let slow_sink = {
            let slow = Arc::clone(&slow);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            sink(move |value| {
                if let Ok(mut log) = slow.lock() {
                    log.push(value.header.sequence);
                }
                if value.header.sequence == 1 {
                    started.notify_one();
                    let gate = release.lock().ok().and_then(|mut slot| slot.take());
                    return Box::pin(async move {
                        if let Some(gate) = gate {
                            let _ = gate.await;
                        }
                    });
                }
                Box::pin(async {})
            })
        };
        let _slow_subscription = hub
            .subscribe(slow_sink, None, None)
            .unwrap_or_else(|error| panic!("{error}"));
        let fast_sink = {
            let fast = Arc::clone(&fast);
            sink(move |value| {
                if let Ok(mut log) = fast.lock() {
                    log.push(value.header.sequence);
                }
                Box::pin(async {})
            })
        };
        let _fast_subscription = hub
            .subscribe(fast_sink, None, None)
            .unwrap_or_else(|error| panic!("{error}"));
        hub.publish(frame(1));
        started.notified().await;
        for sequence in 2..=100 {
            hub.publish(frame(sequence));
        }
        let _ = gate.send(());
        until("the newest frame", || seen(&slow).len() == 2).await;
        assert_eq!(seen(&slow), vec![1, 100]);
        until("the fast viewer's last frame", || {
            seen(&fast).last() == Some(&100)
        })
        .await;
    }

    /// `frames.process.test.ts:50`: unsubscribe discards the queued frame, a viewer whose sink
    /// failed is removed, and neither keeps another viewer from being served.
    #[tokio::test]
    async fn unsubscribe_discards_queued_frames_and_a_failed_subscriber_does_not_block_others() {
        let hub = FrameHub::new();
        let received = Arc::new(Mutex::new(Vec::new()));
        let started = Arc::new(Notify::new());
        let (gate, release) = oneshot::channel::<()>();
        let release = Arc::new(Mutex::new(Some(release)));
        let first = {
            let received = Arc::clone(&received);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            sink(move |value| {
                if let Ok(mut log) = received.lock() {
                    log.push(value.header.sequence);
                }
                if value.header.sequence == 1 {
                    started.notify_one();
                    let gate = release.lock().ok().and_then(|mut slot| slot.take());
                    return Box::pin(async move {
                        if let Some(gate) = gate {
                            let _ = gate.await;
                        }
                    });
                }
                Box::pin(async {})
            })
        };
        let mut stop = hub
            .subscribe(first, None, None)
            .unwrap_or_else(|error| panic!("{error}"));
        let failing: Sink<Frame> = sink(|_| Box::pin(async { panic!("gone") }));
        let _failing = hub
            .subscribe(failing, None, None)
            .unwrap_or_else(|error| panic!("{error}"));
        hub.publish(frame(1));
        started.notified().await;
        hub.publish(frame(2));
        stop.stop();
        let _ = gate.send(());
        let served = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&served);
        let _served = hub
            .subscribe(
                sink(move |_| {
                    counter.fetch_add(1, Ordering::Relaxed);
                    Box::pin(async {})
                }),
                None,
                None,
            )
            .unwrap_or_else(|error| panic!("{error}"));
        hub.publish(frame(3));
        until("the third frame", || served.load(Ordering::Relaxed) == 1).await;
        // Drain the queued promise chain, then offer another frame to expose retained viewers.
        tokio::time::sleep(Duration::from_millis(20)).await;
        hub.publish(frame(4));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(seen(&received), vec![1]);
        assert_eq!(served.load(Ordering::Relaxed), 2);
    }

    /// `frames.process.test.ts:85`: a new viewer gets its initial frame, and the existing ones
    /// are not shown it again.
    #[tokio::test]
    async fn a_new_viewer_gets_its_initial_frame_without_replaying_it_to_existing_viewers() {
        let hub = FrameHub::new();
        let received = Arc::new(Mutex::new(Vec::new()));
        let first = Arc::new(Notify::new());
        let existing = {
            let received = Arc::clone(&received);
            let first = Arc::clone(&first);
            sink(move |value| {
                if let Ok(mut log) = received.lock() {
                    log.push(value.header.sequence);
                }
                first.notify_one();
                Box::pin(async {})
            })
        };
        let _existing = hub
            .subscribe(existing, None, None)
            .unwrap_or_else(|error| panic!("{error}"));
        hub.publish(frame(1));
        first.notified().await;
        let second = Arc::new(Notify::new());
        let viewer = {
            let second = Arc::clone(&second);
            sink(move |_| {
                second.notify_one();
                Box::pin(async {})
            })
        };
        let _viewer = hub
            .subscribe(viewer, Some(frame(1)), None)
            .unwrap_or_else(|error| panic!("{error}"));
        second.notified().await;
        assert_eq!(seen(&received), vec![1]);
    }

    /// `frames.process.test.ts:102`: the limit rejects the sixty-fifth viewer and a slot frees
    /// on unsubscribe; `clear` drops everyone.
    #[test]
    fn subscriber_limits_reject_excess_viewers_and_free_a_slot_on_unsubscribe() {
        let hub = FrameHub::new();
        let quiet: Sink<Frame> = sink(|_| Box::pin(async {}));
        let mut stops: Vec<Subscription> = Vec::new();
        for _ in 0..64 {
            stops.push(
                hub.subscribe(Arc::clone(&quiet), None, None)
                    .unwrap_or_else(|error| panic!("{error}")),
            );
        }
        assert_eq!(
            hub.subscribe(Arc::clone(&quiet), None, None).err(),
            Some("Subscriber limit".to_owned())
        );
        stops[0].stop();
        assert!(hub.subscribe(quiet, None, None).is_ok());
        hub.clear();
    }
}
