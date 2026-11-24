// SPDX-License-Identifier: Apache-2.0
//! A Simulator's stream re-encoded for a viewer that can't carry serve-sim's own (E3b, replacing
//! the screen helper's `--transcode`): VideoToolbox decodes at the target size and the picture
//! goes to the encoder in its IOSurface, with no CPU copy (`media_vt::VtTranscoder`). The
//! encoder's units become the same Annex B frames the reader passes through, under the encode's
//! id.
//!
//! Rate control is the browser encoder's (ADR 0088): the transcode opens its session in
//! quantizer mode and, once the source has been still ~300 ms, encodes the last decoded
//! picture again as a sharp keyframe at `settled()`'s quantizer (`sim_still`). A
//! VideoToolbox session has no per-frame QP, and an in-place Min/Max-QP reconfigure with
//! frames flowing hangs the next encode inside VideoToolbox's synchronous XPC property
//! confirmation (sampled: mach_msg trap in
//! `RemoteVideoEncoder_CopySupportedPropertyDictionary`, 0% CPU, never returns) — so the
//! session keeps one quantizer for the whole stream and only the settle refresh
//! reconfigures, once per still spell when the encoder has drained. A size change opens
//! a new stream.
use super::sim_still::StillControl;
use crate::serve_sim::{Record, Translator};
use media_codec::{Codec, CodecError, EncodeSpec as Spec, EncodedUnit, Encoder, RateControl, Size};
use media_vt::VtTranscoder;
use media_wire::capability::{Acceleration, Backend, SourceStep, Step};
use media_wire::control::EncodeSpec;
use media_wire::frame::MediaFrame;

pub struct Transcode {
    inner: VtTranscoder,
    out: Translator,
    id: u32,
    force_key: bool,
    /// The decoder has had a keyframe: it can't start from a delta.
    primed: bool,
    /// Fixed quantizer when the wire spec names one; otherwise `still` drives the session.
    fixed_qp: Option<u8>,
    still: Option<StillControl>,
    /// The quantizer the encoder session currently runs at.
    applied_qp: u8,
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

fn spec_for(size: Size, fps: u32, qp: u8) -> Spec {
    Spec {
        codec: Codec::H264,
        size,
        fps,
        rate: RateControl::Quantizer(qp),
    }
}

fn spec(wire: &EncodeSpec) -> Spec {
    let size = even_size(wire);
    let fps = wire.fps.clamp(1, 240);
    match wire.quantizer {
        Some(q) => Spec {
            codec: Codec::H264,
            size,
            fps,
            rate: RateControl::Quantizer(q.clamp(18, 51) as u8),
        },
        None => Spec {
            codec: Codec::H264,
            size,
            fps,
            rate: RateControl::Bitrate(wire.bitrate.max(1)),
        },
    }
}

impl Transcode {
    pub fn new(wire: &EncodeSpec) -> Result<Self, CodecError> {
        let size = even_size(wire);
        let fps = wire.fps.clamp(1, 240);
        if let Some(q) = wire.quantizer {
            let qp = q.clamp(18, 51) as u8;
            return Ok(Self {
                inner: VtTranscoder::new(&spec(wire))?,
                out: Translator::default(),
                id: wire.id,
                force_key: true,
                primed: false,
                fixed_qp: Some(qp),
                still: None,
                applied_qp: qp,
                size,
                fps,
            });
        }
        let mut still = StillControl::new(f64::from(wire.bitrate.max(1)), f64::from(fps));
        let qp = still.next_qp(true);
        Ok(Self {
            inner: VtTranscoder::new(&spec_for(size, fps, qp))?,
            out: Translator::default(),
            id: wire.id,
            force_key: true,
            primed: false,
            fixed_qp: None,
            still: Some(still),
            applied_qp: qp,
            size,
            fps,
        })
    }

    /// New settings: a new size starts the encoder's stream again at a keyframe.
    pub fn configure(&mut self, wire: &EncodeSpec) -> Result<(), CodecError> {
        let size = even_size(wire);
        let fps = wire.fps.clamp(1, 240);
        if let Some(q) = wire.quantizer {
            let qp = q.clamp(18, 51) as u8;
            self.inner.configure(&spec(wire))?;
            self.id = wire.id;
            self.force_key = true;
            self.fixed_qp = Some(qp);
            self.still = None;
            self.applied_qp = qp;
            self.size = size;
            self.fps = fps;
            return Ok(());
        }
        let bitrate = f64::from(wire.bitrate.max(1));
        if size != self.size {
            // A new size is a new stream: fresh rate control starting at a keyframe.
            let mut still = StillControl::new(bitrate, f64::from(fps));
            let qp = still.next_qp(true);
            self.inner.configure(&spec_for(size, fps, qp))?;
            self.still = Some(still);
            self.applied_qp = qp;
        } else if let Some(still) = self.still.as_mut() {
            still.retarget(bitrate, f64::from(fps));
        }
        self.id = wire.id;
        self.force_key = true;
        self.size = size;
        self.fps = fps;
        Ok(())
    }

    pub fn key(&mut self) {
        self.force_key = true;
    }

    fn drain(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        while let Some(unit) = self.inner.encoder().poll_result()? {
            let key = unit.key;
            let bytes = unit.data.len();
            if let Some(description) = unit.description.clone() {
                let _ = self.out.frame(Record::Description(description));
            }
            let record = if key {
                Record::Key(unit.data)
            } else {
                Record::Delta(unit.data)
            };
            if let Ok(Some(mut frame)) = self.out.frame(record) {
                frame.encode = self.id;
                frames.push(frame);
            }
            if let Some(still) = self.still.as_mut() {
                still.observe(bytes, key);
            }
        }
        Ok(())
    }

    /// One unit of serve-sim's stream in; whatever the encoder has finished out, as frames.
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
                return self.drain(frames);
            }
            self.primed = true;
        }
        if self.fixed_qp.is_some() {
            let force = self.force_key;
            match self.inner.push(unit, force) {
                Ok(reached) => {
                    if reached {
                        self.force_key = false;
                    }
                }
                // The encoder is behind: this picture is skipped; the stream stays decodable
                // because the decoder still took every unit before it.
                Err(CodecError::Backpressure) => {}
                Err(error) => return Err(error),
            }
            return self.drain(frames);
        }
        let now = now_ms as f64;
        if let Some(still) = self.still.as_mut() {
            still.note_input(unit.data.len(), unit.key, now);
        }
        let force = self.force_key;
        // The session keeps one quantizer for the whole stream: an in-place Min/Max-QP
        // reconfigure with frames flowing hangs the next encode inside VideoToolbox's
        // synchronous XPC property confirmation (sampled: mach_msg trap in
        // RemoteVideoEncoder_CopySupportedPropertyDictionary, 0% CPU, never returns).
        // `still` still tracks every input and output so `settled()` can name the sharp
        // refresh quantizer; only the refresh reconfigures, once per still spell when the
        // encoder has drained.
        match self.inner.push(unit, force) {
            Ok(reached) => {
                if reached {
                    self.force_key = false;
                }
            }
            // The encoder is behind: this picture is skipped; the stream stays decodable
            // because the decoder still took every unit before it.
            Err(CodecError::Backpressure) => {}
            Err(error) => return Err(error),
        }
        self.drain(frames)?;
        self.refresh_if_still(now_ms, frames)?;
        Ok(())
    }

    /// Units the encoder finished on its own threads, plus a still refresh when due.
    /// The shell calls this on its idle path too, with no new input.
    pub fn poll(&mut self, now_ms: u64, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        self.drain(frames)?;
        self.refresh_if_still(now_ms, frames)?;
        Ok(())
    }

    fn refresh_if_still(
        &mut self,
        now_ms: u64,
        frames: &mut Vec<MediaFrame>,
    ) -> Result<(), CodecError> {
        if self.fixed_qp.is_some() || !self.inner.encoder().has_room() {
            return Ok(());
        }
        let qp = match self.still.as_mut() {
            Some(still) => match still.should_refresh(now_ms as f64) {
                Some(qp) => qp,
                None => return Ok(()),
            },
            None => return Ok(()),
        };
        if qp != self.applied_qp {
            self.inner
                .encoder()
                .configure(&spec_for(self.size, self.fps, qp))?;
            self.applied_qp = qp;
        }
        let Some(surface) = self.inner.last_surface() else {
            return Ok(());
        };
        // Our own clock: a still frame encoded again needs a later timestamp than last time.
        let pts_us = now_ms.saturating_mul(1_000).max(1);
        let picture = surface.into_picture(pts_us)?;
        match self.inner.encoder().encode(picture, true) {
            Ok(()) => {
                // The refresh is the owed keyframe when one was asked for.
                self.force_key = false;
            }
            Err(CodecError::Backpressure) => return Ok(()),
            Err(error) => return Err(error),
        }
        self.drain(frames)?;
        Ok(())
    }

    /// Finishes what the encoder holds (the stream is ending).
    pub fn flush(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        self.inner.encoder().flush()?;
        self.drain(frames)
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
