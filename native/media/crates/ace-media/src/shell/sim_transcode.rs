// SPDX-License-Identifier: Apache-2.0
//! A Simulator's stream re-encoded for a viewer that can't carry serve-sim's own (E3b, replacing
//! the screen helper's `--transcode`): VideoToolbox decodes at the target size and the picture
//! goes to the encoder in its IOSurface, with no CPU copy (`media_vt::VtTranscoder`). The
//! encoder's units become the same Annex B frames the reader passes through, under the encode's
//! id.
//!
//! Rate control follows the browser encoder's settle (ADR 0088) with two sessions, because a
//! VideoToolbox session has no per-frame QP and mutating a live session's Min/Max-QP hangs
//! the next encode inside its synchronous XPC property confirmation (sampled: mach_msg trap
//! in `RemoteVideoEncoder_CopySupportedPropertyDictionary`, 0% CPU, never returns):
//! - motion runs the decode + encode session in plain bitrate mode at the planned bitrate,
//!   so link adaptation and in-place bitrate retargeting keep working;
//! - the still refresh uses a separate encode session in quantizer mode at `settled()`'s
//!   quantizer, opened lazily and kept while its size and QP stay the same (a QP change
//!   opens a new session rather than reconfiguring). Its IDR carries its own parameter sets,
//!   and motion re-keys with its own parameter sets before any delta goes out after one, so
//!   the two sessions' deltas never interleave.
use super::sim_split::{Session, Split};
use crate::serve_sim::{Record, Translator};
use media_codec::{Codec, CodecError, EncodeSpec as Spec, EncodedUnit, Encoder, RateControl, Size};
use media_vt::{VtEncoder, VtTranscoder};
use media_wire::capability::{Acceleration, Backend, SourceStep, Step};
use media_wire::control::EncodeSpec;
use media_wire::frame::MediaFrame;

/// The still-refresh encode session: one quantizer, one size, never reconfigured.
struct Refresh {
    encoder: VtEncoder,
    size: Size,
    qp: u8,
}

pub struct Transcode {
    inner: VtTranscoder,
    refresh: Option<Refresh>,
    out: Translator,
    id: u32,
    /// The decoder has had a keyframe: it can't start from a delta.
    primed: bool,
    split: Split,
    /// The last spec applied to the motion session (wired for tests: the refresh path must
    /// never touch it).
    motion_spec: Spec,
    /// The last avcC each session's keyframes carried (wired for tests: the refresh IDR is
    /// published with its own parameter sets).
    motion_avcc: Option<Vec<u8>>,
    refresh_avcc: Option<Vec<u8>>,
    size: Size,
    fps: u32,
}

fn even_size(wire: &EncodeSpec) -> Size {
    let even = |value: u32| (value & !1).max(2);
    Size {
        width: even(wire.width),
        height: even(wire.height),
    }
}

fn motion_spec_for(size: Size, fps: u32, bitrate: u32) -> Spec {
    Spec {
        codec: Codec::H264,
        size,
        fps,
        rate: RateControl::Bitrate(bitrate.max(1)),
    }
}

fn refresh_spec_for(size: Size, fps: u32, qp: u8) -> Spec {
    Spec {
        codec: Codec::H264,
        size,
        fps,
        rate: RateControl::Quantizer(qp),
    }
}

impl Transcode {
    pub fn new(wire: &EncodeSpec) -> Result<Self, CodecError> {
        let size = even_size(wire);
        let fps = wire.fps.clamp(1, 240);
        let motion_spec = motion_spec_for(size, fps, wire.bitrate);
        let bitrate = f64::from(wire.bitrate.max(1));
        Ok(Self {
            inner: VtTranscoder::new(&motion_spec)?,
            refresh: None,
            out: Translator::default(),
            id: wire.id,
            primed: false,
            split: Split::new(bitrate, f64::from(fps)),
            motion_spec,
            motion_avcc: None,
            refresh_avcc: None,
            size,
            fps,
        })
    }

    /// New settings: a new size starts the encoder's stream again at a keyframe.
    pub fn configure(&mut self, wire: &EncodeSpec) -> Result<(), CodecError> {
        let size = even_size(wire);
        let fps = wire.fps.clamp(1, 240);
        let bitrate = wire.bitrate.max(1);
        self.split.retarget(f64::from(bitrate), f64::from(fps));
        if size != self.size {
            // A new size is a new stream on the motion session; the still clock and any
            // refresh session for the old size go with it.
            self.inner.configure(&motion_spec_for(size, fps, bitrate))?;
            self.split = Split::new(f64::from(bitrate), f64::from(fps));
            self.refresh = None;
        } else {
            // Same size: the stream continues, the bitrate takes effect in place.
            self.inner.configure(&motion_spec_for(size, fps, bitrate))?;
        }
        self.motion_spec = motion_spec_for(size, fps, bitrate);
        self.id = wire.id;
        self.split.request_key();
        self.size = size;
        self.fps = fps;
        Ok(())
    }

    pub fn key(&mut self) {
        self.split.request_key();
    }

    /// One unit of serve-sim's stream in; whatever the encoders have finished out, as frames.
    /// `now_ms` is the shell's monotonic clock, for the still refresh only.
    pub fn push(
        &mut self,
        unit: &EncodedUnit,
        now_ms: u64,
        frames: &mut Vec<MediaFrame>,
    ) -> Result<(), CodecError> {
        // Asked for between serve-sim's keyframes: the decoder starts at the next one (the
        // reader opens a fresh subscription, whose first unit is one).
        if !self.primed {
            if !unit.key {
                return Ok(());
            }
            self.primed = true;
        }
        let (session, force) = self.split.input(unit.data.len(), unit.key, now_ms as f64);
        debug_assert_eq!(session, Session::Motion);
        match self.inner.push(unit, force) {
            Ok(reached) => {
                if reached {
                    self.split.motion_reached();
                }
            }
            // The encoder is behind: this picture is skipped; the stream stays decodable
            // because the decoder still took every unit before it.
            Err(CodecError::Backpressure) => {}
            Err(error) => return Err(error),
        }
        self.drain_motion(frames)?;
        self.drain_refresh(frames)?;
        self.refresh_if_still(now_ms, frames)?;
        Ok(())
    }

    /// Units the encoders finished on their own threads, plus a still refresh when due.
    pub fn poll(&mut self, now_ms: u64, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        self.drain_motion(frames)?;
        self.drain_refresh(frames)?;
        self.refresh_if_still(now_ms, frames)?;
        Ok(())
    }

    /// The motion session's finished units out, as frames. While waiting for the post-refresh
    /// IDR, deltas are dropped so the two sessions' deltas never interleave; every published
    /// keyframe carries that session's own parameter sets.
    fn drain_motion(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        while let Some(unit) = self.inner.encoder().poll_result()? {
            let key = unit.key;
            let bytes = unit.data.len();
            if !self.split.motion_out(key) {
                continue;
            }
            if key {
                if let Some(description) = unit.description.clone() {
                    self.motion_avcc = Some(description.clone());
                    let _ = self.out.frame(Record::Description(description));
                }
                let record = Record::Key(unit.data);
                if let Ok(Some(mut frame)) = self.out.frame(record) {
                    frame.encode = self.id;
                    frames.push(frame);
                }
            } else {
                let record = Record::Delta(unit.data);
                if let Ok(Some(mut frame)) = self.out.frame(record) {
                    frame.encode = self.id;
                    frames.push(frame);
                }
            }
            self.split.observe(bytes, key);
        }
        Ok(())
    }

    /// A pending refresh IDR out, as a frame with its own parameter sets.
    fn drain_refresh(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        let Some(refresh) = self.refresh.as_mut() else {
            return Ok(());
        };
        while let Some(unit) = refresh.encoder.poll_result()? {
            if !unit.key {
                continue;
            }
            let bytes = unit.data.len();
            if let Some(description) = unit.description.clone() {
                self.refresh_avcc = Some(description.clone());
                let _ = self.out.frame(Record::Description(description));
            }
            let record = Record::Key(unit.data);
            if let Ok(Some(mut frame)) = self.out.frame(record) {
                frame.encode = self.id;
                frames.push(frame);
            }
            self.split.observe(bytes, true);
            // The refresh IDR is out: motion must re-key before any delta goes out.
            self.split.did_refresh();
            break;
        }
        Ok(())
    }

    fn refresh_if_still(
        &mut self,
        now_ms: u64,
        frames: &mut Vec<MediaFrame>,
    ) -> Result<(), CodecError> {
        let Some((Session::Refresh, qp)) = self.split.tick(now_ms as f64) else {
            return Ok(());
        };
        if self.refresh.as_ref().is_some_and(|r| !r.encoder.has_room()) {
            return Ok(());
        }
        let reuse = self
            .refresh
            .as_ref()
            .is_some_and(|r| r.size == self.size && r.qp == qp);
        if !reuse {
            // A QP change opens a new session rather than reconfiguring: mutating a live
            // session's QP hangs the next encode (see the module docs).
            let mut encoder = VtEncoder::new();
            encoder.configure(&refresh_spec_for(self.size, self.fps, qp))?;
            self.refresh = Some(Refresh {
                encoder,
                size: self.size,
                qp,
            });
        }
        let Some(refresh) = self.refresh.as_mut() else {
            return Ok(());
        };
        let Some(surface) = self.inner.last_surface() else {
            return Ok(());
        };
        // Our own clock: a still frame encoded again needs a later timestamp than last time.
        let pts_us = now_ms.saturating_mul(1_000).max(1);
        let picture = surface.into_picture(pts_us)?;
        match refresh.encoder.encode(picture, true) {
            Ok(()) => {}
            Err(CodecError::Backpressure) => return Ok(()),
            Err(error) => return Err(error),
        }
        self.drain_refresh(frames)?;
        Ok(())
    }

    /// Finishes what the encoders hold (the stream is ending).
    pub fn flush(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        self.inner.encoder().flush()?;
        self.drain_motion(frames)?;
        if let Some(refresh) = self.refresh.as_mut() {
            refresh.encoder.flush()?;
        }
        self.drain_refresh(frames)?;
        Ok(())
    }

    /// The last spec applied to the motion session (wired for tests).
    #[cfg(test)]
    pub(crate) fn motion_spec(&self) -> Spec {
        self.motion_spec.clone()
    }

    /// The last avcC each session's keyframes carried (wired for tests).
    #[cfg(test)]
    pub(crate) fn motion_avcc(&self) -> Option<Vec<u8>> {
        self.motion_avcc.clone()
    }

    #[cfg(test)]
    pub(crate) fn refresh_avcc(&self) -> Option<Vec<u8>> {
        self.refresh_avcc.clone()
    }

    /// The steps it runs, as the source reports them: decode, scale and encode in hardware when
    /// VideoToolbox says so, and no picture-sized copy on the way.
    pub fn acceleration(&self) -> Acceleration {
        let hardware = self.inner.hardware();
        let copies = self.inner.last_copies();
        let step = |step| SourceStep {
            step,
            backend: Backend::Vt,
            hardware,
            readbacks: 0,
            uploads: 0,
        };
        let mut encode = step(Step::Encode);
        encode.readbacks = copies.readbacks;
        encode.uploads = copies.uploads;
        crate::acceleration::assess(&[], vec![step(Step::Decode), step(Step::Scale), encode])
    }
}

#[cfg(test)]
#[path = "sim_transcode_tests.rs"]
mod tests;
