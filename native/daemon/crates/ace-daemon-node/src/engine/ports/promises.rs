// SPDX-License-Identifier: Apache-2.0
//! The promises the engine awaits: a port registers one by id and the shell settles it through
//! `settlePromise(id, ok)`.

use ace_engine::futures::channel::oneshot;
use ace_engine::ports::PortError;

use super::JsPorts;

pub(super) struct Pending {
    sender: Option<oneshot::Sender<Result<(), PortError>>>,
    /// Reported once through `onError` if close finds it still pending.
    message: Option<String>,
}

impl JsPorts {
    /// A promise to await: the shell settles it through `settlePromise(id, ok)`.
    pub fn arm_promise(
        &self,
        message: Option<String>,
    ) -> (u64, oneshot::Receiver<Result<(), PortError>>) {
        let id = self.next_promise.get();
        self.next_promise.set(id + 1);
        let (sender, receiver) = oneshot::channel();
        self.promises.borrow_mut().insert(
            id,
            Pending {
                sender: Some(sender),
                message,
            },
        );
        (id, receiver)
    }
    /// A promise settled: `false` rejects it with the JavaScript error's message.
    pub fn settle_promise(&self, id: u64, ok: bool, message: Option<String>) {
        let sender = self
            .promises
            .borrow_mut()
            .get_mut(&id)
            .and_then(|entry| entry.sender.take());
        if let Some(sender) = sender {
            let _ = sender.send(if ok {
                Ok(())
            } else {
                Err(PortError::Threw(
                    message.unwrap_or_else(|| "engine promise rejected".into()),
                ))
            });
        }
    }

    /// Close's step 5: report every abandoned promise once, then drop them all.
    pub fn abandon_promises(&self) {
        let pending: Vec<Pending> = self.promises.borrow_mut().drain().map(|(_, p)| p).collect();
        for mut entry in pending {
            if let Some(message) = entry.message.take() {
                self.report_now(&message);
            }
            entry.sender.take();
        }
    }

    pub(super) fn report_now(&self, message: &str) {
        let _ = self.call(&self.report, message.to_string());
    }
}
