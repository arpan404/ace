// SPDX-License-Identifier: Apache-2.0
//! `simulator-jpeg.rs`'s request lifetime: a picture arrives and settles the stills that asked
//! for it, and a request ends, fails or is closed.

use super::{Action, Ask, Image, Reason, SimulatorJpeg};

impl SimulatorJpeg {
    /// One whole picture from the current request.
    pub(super) fn received(
        &mut self,
        request: u64,
        bytes: Vec<u8>,
        width: u32,
        height: u32,
        frame: u32,
        now: f64,
    ) -> Vec<Action> {
        let mut actions = vec![Action::Source { width, height }];
        let image = Image {
            bytes,
            width,
            height,
        };
        let effects = if self.streaming {
            self.frames.push(now, image)
        } else {
            self.frames.hold(image);
            Vec::new()
        };
        actions.extend(self.map_frames(effects));
        let settled: Vec<Ask> = self
            .asks
            .iter()
            .filter(|waiting| waiting.request == request && frame > waiting.after)
            .copied()
            .collect();
        self.asks
            .retain(|waiting| waiting.request != request || frame <= waiting.after);
        for waiting in settled {
            actions.push(Action::CancelAsk { ask: waiting.id });
            self.begin_replay(waiting.still, &mut actions);
        }
        if !self.streaming && self.asks.is_empty() {
            actions.extend(self.close_link());
        }
        actions
    }

    /// The request failed: it is closed and the stills waiting on it are refused.
    pub(super) fn abandon(&mut self, request: u64, reason: Reason) -> Vec<Action> {
        let mut actions = self.close_link();
        let waiting: Vec<Ask> = self
            .asks
            .iter()
            .filter(|ask| ask.request == request)
            .copied()
            .collect();
        self.asks.retain(|ask| ask.request != request);
        for ask in waiting {
            actions.push(Action::CancelAsk { ask: ask.id });
            self.settle(ask.still, Err(reason.clone()), &mut actions);
        }
        if let Some(pending) = self.pending_configure.take()
            && pending.request == request
        {
            self.settle(pending.still, Err(reason.clone()), &mut actions);
        }
        actions.push(Action::RequestFailed { request, reason });
        actions
    }

    pub(super) fn ended_with(&mut self, request: u64, reason: Reason) -> Vec<Action> {
        let current = self
            .link
            .as_ref()
            .is_some_and(|link| link.request == request);
        if !current {
            return Vec::new();
        }
        let mut actions = self.abandon(request, reason.clone());
        if self.streaming && !self.stopped {
            actions.push(Action::Failure(reason));
        }
        actions
    }

    /// Aborts the current request and forgets it.
    pub(super) fn close_link(&mut self) -> Vec<Action> {
        match self.link.take() {
            Some(link) => vec![Action::AbortRequest {
                request: link.request,
            }],
            None => Vec::new(),
        }
    }
}
