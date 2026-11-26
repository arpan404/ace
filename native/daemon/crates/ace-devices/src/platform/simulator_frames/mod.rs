// SPDX-License-Identifier: Apache-2.0
//! `simulator-frames.ts`: serve-sim's pictures as a capture's stills, published as they came.
//! One inside the stream's box (and the frame packet's 2160-pixel height) goes out at once; a
//! larger one is never re-encoded here, and a still waiting for it is refused as too large.
//! Only the latest picture is kept while one is being handed on.
//!
//! The decisions are here; the clock, the timer, the microtask that starts a drain and the
//! promises a still waits on are the shell's. Every method returns the [`Effect`]s to run, in
//! order, so nothing in this module reads a clock it was not passed or blocks on I/O.

use crate::platform::{Error, Refusal};

use super::jpeg::jpeg_complete;

/// The frame packet's tallest picture, a portrait phone's included.
pub const FRAME_HEIGHT_LIMIT: u32 = 2160;
/// The most stills that may wait at once.
pub const WAITER_LIMIT: usize = 64;

/// One picture from serve-sim, at the size its sender named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// The part of a stream's settings stills are sized by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameSettings {
    pub fps: u32,
    pub max_width: u32,
    pub max_height: u32,
}

/// The picture a waiting still could not have: over the stream's box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StillTooLarge {
    pub width: u32,
    pub height: u32,
}

/// What the shell must do next, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect {
    /// Run one drain on the microtask queue (`step`).
    Drain,
    /// Hand this picture on as it came, at scale 1.
    Publish(Image),
    /// Arm the rate timer; the shell calls `timer` when it fires.
    Schedule { after_ms: f64 },
    /// Drop the armed rate timer, if any.
    CancelTimer,
    /// The still `waiter` got its picture.
    Resolve { waiter: u64 },
    /// The still `waiter` cannot have it.
    RefuseStill {
        waiter: u64,
        too_large: StillTooLarge,
    },
    /// The capture stopped: the still `waiter` will get no picture.
    RefuseStopped { waiter: u64 },
    /// Handing frames on failed: every listed still is refused with the same failure and the
    /// capture reports it, as the TypeScript rejects them and calls `failure`.
    Fail { failure: Refusal, waiters: Vec<u64> },
}

/// What a still asked for with `replay` waits on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replay {
    /// Nothing to wait for: there is no latest picture, or the capture stopped.
    Ready,
    /// The still waits for `waiter` to be resolved or refused.
    Waiting { waiter: u64 },
}

#[derive(Debug, Clone, Copy)]
struct Waiter {
    id: u64,
    revision: u64,
}

/// serve-sim's pictures as a capture's stills. See the module docs.
#[derive(Debug, Clone)]
pub struct SimulatorFrames {
    settings: FrameSettings,
    revision: u64,
    stopped: bool,
    latest: Option<Image>,
    pending: Option<Image>,
    running: bool,
    last: f64,
    scheduled: bool,
    waiters: Vec<Waiter>,
    next_waiter: u64,
}

impl SimulatorFrames {
    pub fn new(settings: FrameSettings) -> Self {
        Self {
            settings,
            revision: 0,
            stopped: false,
            latest: None,
            pending: None,
            running: false,
            last: f64::NEG_INFINITY,
            scheduled: false,
            waiters: Vec::new(),
            next_waiter: 0,
        }
    }

    /// One picture arrived. Publishes now, or schedules the next publish at the stream's rate.
    pub fn push(&mut self, now: f64, image: Image) -> Vec<Effect> {
        if self.stopped {
            return Vec::new();
        }
        self.latest = Some(image);
        let remaining = 1000.0 / f64::from(self.settings.fps) - (now - self.last);
        if remaining > 0.0 {
            if self.scheduled {
                return Vec::new();
            }
            self.scheduled = true;
            return vec![Effect::Schedule {
                after_ms: remaining,
            }];
        }
        self.publish_latest(now)
    }

    /// The rate timer fired: the latest picture may go out.
    pub fn timer(&mut self, now: f64) -> Vec<Effect> {
        self.scheduled = false;
        self.publish_latest(now)
    }

    /// Keeps a picture as the latest without publishing it: a still waits for `replay`.
    pub fn hold(&mut self, image: Image) {
        if !self.stopped {
            self.latest = Some(image);
        }
    }

    /// New settings for stills on demand: nothing is published until `replay` asks, and a still
    /// already asked for still gets its frame, made at the new settings.
    pub fn idle(&mut self, settings: FrameSettings) -> Vec<Effect> {
        self.settings = settings;
        self.revision += 1;
        let mut effects = self.cancel();
        if !self.waiters.is_empty() {
            self.pending = self.latest.clone();
            effects.extend(self.start());
        }
        effects
    }

    /// Drops the latest frame: the stream it came from closed, so it may no longer be current.
    pub fn forget(&mut self) {
        self.latest = None;
    }

    /// New settings for a streaming capture: a picture over the new box is not published, and
    /// is not the stream's failure either. A still asked for before the change gets the frame
    /// at the new settings.
    pub fn configure(&mut self, settings: FrameSettings) -> Result<(Replay, Vec<Effect>), Error> {
        self.settings = settings;
        self.revision += 1;
        let mut effects = self.cancel();
        let (replay, asked) = self.replay()?;
        effects.extend(asked);
        Ok((replay, effects))
    }

    /// A still, resolved by the first picture that begins arriving after the call.
    pub fn replay(&mut self) -> Result<(Replay, Vec<Effect>), Error> {
        if self.latest.is_none() || self.stopped {
            return Ok((Replay::Ready, Vec::new()));
        }
        if self.waiters.len() >= WAITER_LIMIT {
            return Err(Error::Invalid("Simulator frame request limit".to_string()));
        }
        let waiter = self.next_waiter;
        self.next_waiter += 1;
        self.waiters.push(Waiter {
            id: waiter,
            revision: self.revision,
        });
        self.pending = self.latest.clone();
        let effects = self.start();
        Ok((Replay::Waiting { waiter }, effects))
    }

    /// Runs one drain, the microtask `Effect::Drain` names: publishes the pending picture and
    /// settles the stills waiting on it. Nothing is published when the capture stopped or the
    /// settings changed while it waited.
    pub fn step(&mut self) -> Vec<Effect> {
        if !self.running {
            return Vec::new();
        }
        if self.stopped {
            self.running = false;
            return Vec::new();
        }
        let mut effects = Vec::new();
        while let Some(source) = self.pending.take() {
            let revision = self.revision;
            let settings = self.settings;
            // A cut-short frame would show an agent a screen that isn't there: refused.
            if !jpeg_complete(&source.bytes) {
                let waiters = self.waiters.iter().map(|waiter| waiter.id).collect();
                self.waiters.clear();
                self.running = false;
                effects.push(Effect::Fail {
                    failure: Refusal::word("simulatorIncompletePicture"),
                    waiters,
                });
                return effects;
            }
            if self.stopped || revision != self.revision {
                continue;
            }
            let fits = source.width <= settings.max_width
                && source.height <= FRAME_HEIGHT_LIMIT.min(settings.max_height);
            if fits {
                effects.push(Effect::Publish(source.clone()));
            }
            let settled: Vec<Waiter> = self
                .waiters
                .iter()
                .copied()
                .filter(|waiter| waiter.revision <= revision)
                .collect();
            self.waiters.retain(|waiter| waiter.revision > revision);
            for waiter in settled {
                if fits {
                    effects.push(Effect::Resolve { waiter: waiter.id });
                } else {
                    effects.push(Effect::RefuseStill {
                        waiter: waiter.id,
                        too_large: StillTooLarge {
                            width: source.width,
                            height: source.height,
                        },
                    });
                }
            }
        }
        self.running = false;
        effects
    }

    /// Stops the capture: every waiting still is told, and a scheduled publish is dropped.
    pub fn stop(&mut self) -> Vec<Effect> {
        let mut effects = self
            .waiters
            .iter()
            .map(|waiter| Effect::RefuseStopped { waiter: waiter.id })
            .collect::<Vec<_>>();
        self.waiters.clear();
        effects.extend(self.cancel());
        self.stopped = true;
        self.revision += 1;
        self.pending = None;
        self.latest = None;
        effects
    }

    /// The number of stills waiting, for the shell's cap and tests.
    pub fn waiting(&self) -> usize {
        self.waiters.len()
    }

    /// The latest picture as the capture keeps it, if any.
    pub fn latest(&self) -> Option<&Image> {
        self.latest.as_ref()
    }

    fn publish_latest(&mut self, now: f64) -> Vec<Effect> {
        if self.stopped {
            return Vec::new();
        }
        let mut effects = self.cancel();
        self.last = now;
        self.pending = self.latest.clone();
        effects.extend(self.start());
        effects
    }

    fn start(&mut self) -> Vec<Effect> {
        if self.running || self.stopped || self.pending.is_none() {
            return Vec::new();
        }
        self.running = true;
        vec![Effect::Drain]
    }

    fn cancel(&mut self) -> Vec<Effect> {
        if self.scheduled {
            self.scheduled = false;
            return vec![Effect::CancelTimer];
        }
        Vec::new()
    }
}

#[cfg(test)]
#[cfg(test)]
mod tests;
