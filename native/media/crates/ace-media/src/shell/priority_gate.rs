// SPDX-License-Identifier: Apache-2.0
//! Priority answers that must wait for sockets to be gone (docs/media/plan.md, "Revocation
//! deadline"): `revoked` and `closed` say every matching socket is shut, so an answer is held
//! until the closes its own message made have finished, and with them their sockets. Each held
//! answer waits for its own closes only: an answer with none goes at once, and one stream's slow
//! socket never holds back another's answer. The closes are bounded (`relay::GRACE`), and the
//! supervisor's 250 ms kill bounds everything.
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use std::future::Future;
use std::pin::Pin;
use tokio::task::JoinHandle;

type Held = Pin<Box<dyn Future<Output = Vec<u8>> + Send>>;

#[derive(Default)]
pub struct PriorityGate {
    /// Closes the message being applied made: its answer waits for them.
    closing: Vec<JoinHandle<()>>,
    held: FuturesUnordered<Held>,
}

impl PriorityGate {
    /// A close the current message made (`RelaySockets::close`'s handle).
    pub fn closed(&mut self, close: Option<JoinHandle<()>>) {
        self.closing.extend(close);
    }

    /// The current message's encoded answer: returned to send now when it made no close, or
    /// held until its closes have finished.
    pub fn answer(&mut self, bytes: Vec<u8>) -> Option<Vec<u8>> {
        if self.closing.is_empty() {
            return Some(bytes);
        }
        let closes = std::mem::take(&mut self.closing);
        self.held.push(Box::pin(async move {
            for close in closes {
                let _ = close.await;
            }
            bytes
        }));
        None
    }

    /// The message is applied: closes no answer followed hold nothing (they still run).
    pub fn settle(&mut self) {
        self.closing.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// A held answer whose closes have finished. Cancel-safe.
    pub async fn next(&mut self) -> Option<Vec<u8>> {
        self.held.next().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    fn waiting() -> (oneshot::Sender<()>, JoinHandle<()>) {
        let (release, held) = oneshot::channel::<()>();
        (
            release,
            tokio::spawn(async move {
                let _ = held.await;
            }),
        )
    }

    #[tokio::test]
    async fn an_answer_waits_for_its_own_closes_only() {
        let mut gate = PriorityGate::default();
        // Stream A's revocation: its socket is slow to go.
        let (release_a, close_a) = waiting();
        gate.closed(Some(close_a));
        assert_eq!(gate.answer(b"revoked a".to_vec()), None);
        gate.settle();
        // An epoch ack made no close: it goes at once, A or not.
        assert_eq!(gate.answer(b"epoch".to_vec()), Some(b"epoch".to_vec()));
        // Stream B's revocation, whose socket goes quickly: answered before A's.
        let (release_b, close_b) = waiting();
        gate.closed(Some(close_b));
        assert_eq!(gate.answer(b"revoked b".to_vec()), None);
        gate.settle();
        let _ = release_b.send(());
        let first = tokio::time::timeout(Duration::from_secs(1), gate.next()).await;
        assert_eq!(first.ok().flatten(), Some(b"revoked b".to_vec()));
        // A's answer is still held while its socket's tasks run.
        let early = tokio::time::timeout(Duration::from_millis(30), gate.next()).await;
        assert!(early.is_err(), "A answered while its socket was still open");
        let _ = release_a.send(());
        assert_eq!(gate.next().await, Some(b"revoked a".to_vec()));
        assert!(gate.is_empty());
    }

    #[tokio::test]
    async fn closes_no_answer_followed_hold_nothing() {
        let mut gate = PriorityGate::default();
        let (_release, close) = waiting();
        gate.closed(Some(close));
        gate.settle();
        assert_eq!(gate.answer(vec![1]), Some(vec![1]));
    }
}
