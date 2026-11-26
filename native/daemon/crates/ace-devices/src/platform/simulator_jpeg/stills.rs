// SPDX-License-Identifier: Apache-2.0
//! `simulator-jpeg.rs`'s still bookkeeping: which stills wait, which frame-gate waiter answers
//! one, and which effects settle them.

use crate::platform::simulator_frames::{Effect as FrameEffect, Replay};

use super::{Action, FrameSettings, Reason, SimulatorJpeg};

impl SimulatorJpeg {
    /// How many stills wait on a fresh picture.
    pub fn waiting(&self) -> (usize, usize) {
        (self.asks.len(), self.stills.len())
    }

    pub(super) fn new_still(&mut self, configure: bool) -> u64 {
        let still = self.next_still;
        self.next_still += 1;
        self.stills.insert(still, configure);
        still
    }

    pub(super) fn settle(
        &mut self,
        still: u64,
        outcome: Result<(), Reason>,
        actions: &mut Vec<Action>,
    ) {
        let Some(configure) = self.stills.remove(&still) else {
            return;
        };
        let outcome = match (configure, outcome) {
            // A picture over the new box is not the stream's failure either.
            (true, Err(Reason::TooLarge(_))) => Ok(()),
            (_, outcome) => outcome,
        };
        actions.push(Action::SettleStill { still, outcome });
    }

    /// A frame-gate replay for `still`: a ready frame settles it, a waiter is answered later.
    pub(super) fn map_replay(&mut self, still: u64, replay: Replay) -> Vec<Action> {
        match replay {
            Replay::Ready => {
                let mut actions = Vec::new();
                self.settle(still, Ok(()), &mut actions);
                actions
            }
            Replay::Waiting { waiter } => {
                self.waiters.insert(waiter, still);
                Vec::new()
            }
        }
    }

    /// Settles the stills whose frame gate published or refused, and passes the rest on.
    pub(super) fn map_frames(&mut self, effects: Vec<FrameEffect>) -> Vec<Action> {
        let mut actions = Vec::new();
        for effect in effects {
            match effect {
                FrameEffect::Resolve { waiter } => {
                    if let Some(still) = self.waiters.remove(&waiter) {
                        self.settle(still, Ok(()), &mut actions);
                    }
                }
                FrameEffect::RefuseStill { waiter, too_large } => {
                    if let Some(still) = self.waiters.remove(&waiter) {
                        self.settle(still, Err(Reason::TooLarge(too_large)), &mut actions);
                    }
                }
                FrameEffect::RefuseStopped { waiter } => {
                    if let Some(still) = self.waiters.remove(&waiter) {
                        self.settle(
                            still,
                            Err(Reason::text("Simulator frames stopped")),
                            &mut actions,
                        );
                    }
                }
                FrameEffect::Fail { failure, waiters } => {
                    for waiter in waiters {
                        if let Some(still) = self.waiters.remove(&waiter) {
                            self.settle(still, Err(Reason::Refused(failure)), &mut actions);
                        }
                    }
                    actions.push(Action::Failure(Reason::Refused(failure)));
                }
                other => actions.push(Action::Frames(other)),
            }
        }
        actions
    }

    /// A still's fresh picture began arriving: ask the frame gate for the publish.
    pub(super) fn begin_replay(&mut self, still: u64, actions: &mut Vec<Action>) {
        match self.frames.replay() {
            Ok((replay, effects)) => {
                actions.extend(self.map_replay(still, replay));
                actions.extend(self.map_frames(effects));
            }
            Err(error) => {
                self.settle(still, Err(Reason::text(&error.to_string())), actions);
            }
        }
    }

    pub(super) fn start_configure(
        &mut self,
        still: u64,
        settings: FrameSettings,
        actions: &mut Vec<Action>,
    ) {
        match self.frames.configure(settings) {
            Ok((replay, effects)) => {
                actions.extend(self.map_replay(still, replay));
                actions.extend(self.map_frames(effects));
            }
            Err(error) => {
                self.settle(still, Err(Reason::text(&error.to_string())), actions);
            }
        }
    }
}
