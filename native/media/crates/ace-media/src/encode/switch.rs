// SPDX-License-Identifier: Apache-2.0
//! Moving an encode from its fallback onto a hardware encoder that a late probe result
//! brought, make-before-break (ADR 0148: hardware whenever it is available).
//!
//! 1. The hardware encoder starts beside the running fallback (a shadow) and takes the same
//!    pictures; the fallback keeps delivering. If the hardware encoder fails before its first
//!    keyframe (configuring, its first picture or its first result), or has none within
//!    [`START_LIMIT_US`], it is dropped and the source stays on the fallback, still degraded.
//!    It isn't tried again until the next `capabilities.changed`. The source never ends for it.
//! 2. Its first keyframe starts the handover: the fallback takes no new pictures and is
//!    flushed, and every unit it makes for a picture before the keyframe goes out, while the
//!    hardware's units wait. A flush that fails loses nothing by itself: the fallback's units
//!    are still taken as they come, up to the same bound.
//! 3. The switch commits once no earlier picture is outstanding (or at the bound): the fallback
//!    is dropped and the hardware's units go out, its keyframe first. So the output is fallback
//!    units, then the hardware keyframe, then hardware units; the fallback's units for the
//!    keyframe's picture and later are never sent. Sequence numbers are the egress's, per
//!    source, so they run on unbroken.
use super::{Backends, Fed, Output, Running, Worker, feed, frame, spec_of};
use media_codec::EncodedUnit;
use std::collections::VecDeque;

/// How long a hardware encoder may take to its first keyframe, and how long the fallback then
/// has to deliver what it still holds.
pub const START_LIMIT_US: u64 = 2_000_000;

pub struct Shadow {
    pub(super) running: Running,
    started_us: u64,
    /// Its first keyframe's picture, and when it came: the handover is under way.
    keyed: Option<(u64, u64)>,
    /// The hardware's units from its keyframe on, out once the switch commits.
    held: VecDeque<EncodedUnit>,
    flushed: bool,
}

impl Shadow {
    pub fn keyed(&self) -> bool {
        self.keyed.is_some()
    }
}

enum Next {
    Keep,
    Drop,
    Commit,
}

impl<B: Backends> Worker<B> {
    /// Starts a hardware encoder beside each fallback encode one now improves.
    pub(super) fn start_shadows(&mut self, now_us: u64) {
        let ids: Vec<u32> = self.encodes.keys().copied().collect();
        for id in ids {
            let Some(running) = self.encodes.get(&id) else {
                continue;
            };
            let improves = !running.chosen.hardware
                && !self.shadows.contains_key(&id)
                && matches!(self.backends.choice(running.codec), Some((_, true)));
            if !improves {
                continue;
            }
            let (wire, codec, size) = (running.wire.clone(), running.codec, running.size);
            let mut chosen = match self.backends.encoder(codec) {
                Ok(chosen) if chosen.hardware => chosen,
                // It didn't open after all: the source keeps the encoder it has.
                Ok(_) | Err(_) => continue,
            };
            if chosen.encoder.configure(&spec_of(&wire, codec)).is_err() {
                continue;
            }
            let shadow = Running {
                codec_string: wire.codec.clone(),
                wire,
                codec,
                size,
                chosen,
                key_owed: true,
                description: None,
                pending: VecDeque::new(),
                steps: Vec::new(),
            };
            self.shadows.insert(
                id,
                Shadow {
                    running: shadow,
                    started_us: now_us,
                    keyed: None,
                    held: VecDeque::new(),
                    flushed: false,
                },
            );
        }
    }

    /// Each starting hardware encoder takes the picture too; one that fails is dropped.
    pub(super) fn feed_shadows(&mut self, fed: &Fed) {
        let ids: Vec<u32> = self.shadows.keys().copied().collect();
        for id in ids {
            let Some(shadow) = self.shadows.get_mut(&id) else {
                continue;
            };
            if feed(&mut self.backends, &mut shadow.running, fed).is_err() {
                self.shadows.remove(&id);
            }
        }
    }

    /// Advances every switch: takes the hardware's output, finishes the fallback's handover,
    /// and commits or gives up.
    pub(super) fn poll_shadows(&mut self, now_us: u64, out: &mut Vec<Output>) {
        let ids: Vec<u32> = self.shadows.keys().copied().collect();
        for id in ids {
            let Some(mut shadow) = self.shadows.remove(&id) else {
                continue;
            };
            match self.advance(id, &mut shadow, now_us, out) {
                Next::Keep => {
                    self.shadows.insert(id, shadow);
                }
                Next::Drop => {}
                Next::Commit => {
                    let Some(running) = self.encodes.get_mut(&id) else {
                        continue;
                    };
                    // The fallback goes; the hardware encoder delivers from its keyframe.
                    *running = shadow.running;
                    for unit in shadow.held {
                        out.push(Output::Unit(frame(running, unit, self.epoch, now_us)));
                    }
                }
            }
        }
    }

    fn advance(
        &mut self,
        id: u32,
        shadow: &mut Shadow,
        now_us: u64,
        out: &mut Vec<Output>,
    ) -> Next {
        loop {
            match shadow.running.chosen.encoder.poll_result() {
                Ok(Some(unit)) if shadow.keyed.is_some() => shadow.held.push_back(unit),
                Ok(Some(unit)) if unit.key => {
                    shadow.keyed = Some((unit.pts_us, now_us));
                    shadow.held.push_back(unit);
                }
                // Nothing before its first keyframe can start a stream.
                Ok(Some(_)) => {}
                Ok(None) => break,
                // Its first result failed, or it broke during the handover: the fallback,
                // still running, carries on.
                Err(_) => return Next::Drop,
            }
        }
        let Some((key_pts, keyed_us)) = shadow.keyed else {
            let late = now_us.saturating_sub(shadow.started_us) >= START_LIMIT_US;
            return if late { Next::Drop } else { Next::Keep };
        };
        let Some(fallback) = self.encodes.get_mut(&id) else {
            return Next::Drop;
        };
        if !shadow.flushed {
            shadow.flushed = true;
            // A flush that fails loses nothing by itself: its units are still taken below.
            if let Err(error) = fallback.chosen.encoder.flush() {
                eprintln!(
                    "ace-media: the fallback encoder's flush failed while moving to hardware \
                     ({error}); its units are taken as they come"
                );
            }
        }
        let mut broken = false;
        loop {
            match fallback.chosen.encoder.poll_result() {
                Ok(Some(unit)) if unit.pts_us < key_pts => {
                    out.push(Output::Unit(frame(fallback, unit, self.epoch, now_us)));
                }
                // The keyframe's picture and later: the hardware encoder sends those.
                Ok(Some(_)) => {}
                Ok(None) => break,
                Err(_) => {
                    broken = true;
                    break;
                }
            }
        }
        let outstanding = fallback.pending.iter().any(|p| p.pts < key_pts);
        let waited = now_us.saturating_sub(keyed_us) >= START_LIMIT_US;
        if outstanding && !broken && !waited {
            Next::Keep
        } else {
            Next::Commit
        }
    }
}
