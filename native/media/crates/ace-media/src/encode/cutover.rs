// SPDX-License-Identifier: Apache-2.0
//! Moving an encode from its fallback onto a hardware encoder that a late probe result
//! brought (ADR 0148: hardware whenever it is available): one cut-over, at one picture.
//!
//! On the `capabilities.changed` that brings it, the fallback is flushed and everything it
//! made goes out; that is every picture before the cut. The flush runs on this thread, so no
//! picture is taken meanwhile. The hardware encoder then takes the next picture as a keyframe.
//! A flush that fails drops what the fallback still held, and that fallback is never used again.
//!
//! Until its first keyframe is out, the hardware encoder is on probation, with the flushed
//! fallback kept beside it, idle. If the hardware encoder fails before then (configure, its
//! first picture, its first result, or no keyframe within [`PROBATION_US`]), or at any time
//! after, the source goes back to the fallback (the kept one, else a new one) at a keyframe,
//! and is degraded again. It isn't tried again until the next `capabilities.changed`. The
//! source never ends for this, unless no fallback can be made at all.
use super::{Backends, Chosen, Output, Worker, frame, spec_of};

/// How long a new hardware encoder has to its first keyframe.
pub const PROBATION_US: u64 = 2_000_000;

pub struct Probation {
    since_us: u64,
    /// The flushed fallback, idle, to go back to; none when its flush failed.
    fallback: Option<Chosen>,
}

impl Probation {
    pub fn expired(&self, now_us: u64) -> bool {
        now_us.saturating_sub(self.since_us) >= PROBATION_US
    }
}

impl<B: Backends> Worker<B> {
    /// The probe's findings changed: each encode on its fallback whose codec a hardware
    /// encoder now covers is cut over. Never moves off hardware.
    pub(super) fn upgrade(&mut self, now_us: u64, out: &mut Vec<Output>) {
        self.backends.refresh();
        let ids: Vec<u32> = self.encodes.keys().copied().collect();
        for id in ids {
            let Some(running) = self.encodes.get_mut(&id) else {
                continue;
            };
            if running.chosen.hardware
                || running.probation.is_some()
                || !matches!(self.backends.choice(running.codec), Some((_, true)))
            {
                continue;
            }
            // Every picture before the cut: what the fallback made goes out now.
            let flushed = running.chosen.encoder.flush().is_ok();
            while let Ok(Some(unit)) = running.chosen.encoder.poll_result() {
                out.push(Output::Unit(frame(running, unit, self.epoch, now_us)));
            }
            running.pending.clear();
            // The next picture is a keyframe whichever encoder takes it.
            running.key_owed = true;
            let spec = spec_of(&running.wire, running.codec);
            let hardware = self
                .backends
                .encoder(running.codec)
                .ok()
                .filter(|chosen| chosen.hardware)
                .and_then(|mut chosen| chosen.encoder.configure(&spec).ok().map(|()| chosen));
            match hardware {
                Some(hardware) => {
                    let fallback = std::mem::replace(&mut running.chosen, hardware);
                    running.description = None;
                    running.moved = true;
                    running.probation = Some(Probation {
                        since_us: now_us,
                        fallback: flushed.then_some(fallback),
                    });
                }
                // It didn't open: the fallback carries on from a keyframe.
                None if flushed => {}
                // A fallback whose flush failed is never used again: what it still held must
                // never come out after the cut. A new one replaces it, or the source ends.
                None => {
                    let fresh = self
                        .backends
                        .fallback(running.codec)
                        .and_then(|mut chosen| {
                            chosen.encoder.configure(&spec)?;
                            Ok(chosen)
                        });
                    match fresh {
                        Ok(fresh) => {
                            running.chosen = fresh;
                            running.description = None;
                        }
                        Err(error) => return self.fail(&error, out),
                    }
                }
            }
        }
    }

    /// The hardware encoder an encode was cut over to failed: back to the fallback, at a
    /// keyframe. False when no fallback could be made, and the source has ended.
    pub(super) fn back_to_fallback(&mut self, id: u32, out: &mut Vec<Output>) -> bool {
        let Some(running) = self.encodes.get_mut(&id) else {
            return true;
        };
        let spec = spec_of(&running.wire, running.codec);
        let kept = running.probation.take().and_then(|p| p.fallback);
        let fallback = match kept {
            Some(kept) => Ok(kept),
            None => self.backends.fallback(running.codec),
        };
        let configured = fallback.and_then(|mut chosen| {
            chosen.encoder.configure(&spec)?;
            Ok(chosen)
        });
        match configured {
            Ok(chosen) => {
                running.chosen = chosen;
                running.key_owed = true;
                running.description = None;
                running.pending.clear();
                running.moved = false;
                true
            }
            Err(error) => {
                self.fail(&error, out);
                false
            }
        }
    }
}
