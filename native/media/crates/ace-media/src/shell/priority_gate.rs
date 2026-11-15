// SPDX-License-Identifier: Apache-2.0
//! Priority answers that must wait for sockets to be gone (docs/media/plan.md, "Revocation
//! deadline"): `revoked` and `closed` say every matching socket is shut, so an answer that follows
//! a relay stream's close is held until every task that owned that socket has ended, and with
//! them the socket (closed with a reset, so nothing queued in the kernel leaves either). Answers
//! leave in the order they were made; one with nothing to wait for behind none goes at once.
//! The supervisor's 250 ms kill bounds any wait.
use std::collections::VecDeque;
use tokio::task::JoinHandle;

#[derive(Default)]
pub struct PriorityGate {
    /// Socket tasks closed since the last answer, which the next answer waits for.
    closing: Vec<JoinHandle<()>>,
    queue: VecDeque<(Vec<JoinHandle<()>>, Vec<u8>)>,
}

impl PriorityGate {
    /// The tasks of a socket just closed: the next answer waits until they have ended.
    pub fn closed(&mut self, tasks: Vec<JoinHandle<()>>) {
        self.closing.extend(tasks);
    }

    /// An encoded priority answer: returned to send now, or held behind the sockets it follows.
    pub fn answer(&mut self, bytes: Vec<u8>) -> Option<Vec<u8>> {
        if self.closing.is_empty() && self.queue.is_empty() {
            return Some(bytes);
        }
        self.queue
            .push_back((std::mem::take(&mut self.closing), bytes));
        None
    }

    /// Closes that no answer followed (an expiry, a stream that ended): nothing waits for them.
    pub fn settle(&mut self) {
        self.closing.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    /// The next held answer, once every task it waits for has ended. Safe to cancel: a task seen
    /// ended is dropped before the next wait.
    pub async fn next(&mut self) -> Option<Vec<u8>> {
        let (tasks, _) = self.queue.front_mut()?;
        while let Some(task) = tasks.last_mut() {
            let _ = task.await;
            tasks.pop();
        }
        self.queue.pop_front().map(|(_, bytes)| bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::sync::oneshot;

    #[tokio::test]
    async fn an_answer_after_a_close_waits_for_the_sockets_tasks_and_answers_keep_their_order() {
        let mut gate = PriorityGate::default();
        assert_eq!(gate.answer(vec![0]), Some(vec![0]), "nothing to wait for");
        let (release, held) = oneshot::channel::<()>();
        gate.closed(vec![tokio::spawn(async move {
            let _ = held.await;
        })]);
        assert_eq!(gate.answer(vec![1]), None);
        // An answer behind a held one waits too, even with no close of its own.
        assert_eq!(gate.answer(vec![2]), None);
        let early = tokio::time::timeout(Duration::from_millis(30), gate.next()).await;
        assert!(early.is_err(), "released while the socket's task still ran");
        let _ = release.send(());
        assert_eq!(gate.next().await, Some(vec![1]));
        assert_eq!(gate.next().await, Some(vec![2]));
        assert!(gate.is_empty());
        assert_eq!(gate.answer(vec![3]), Some(vec![3]));
    }

    #[tokio::test]
    async fn an_aborted_task_releases_its_answer() {
        let mut gate = PriorityGate::default();
        let task = tokio::spawn(std::future::pending::<()>());
        task.abort();
        gate.closed(vec![task]);
        assert_eq!(gate.answer(vec![7]), None);
        let next = tokio::time::timeout(Duration::from_secs(1), gate.next()).await;
        assert_eq!(next.ok().flatten(), Some(vec![7]));
    }
}
