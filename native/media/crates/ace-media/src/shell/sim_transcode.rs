// SPDX-License-Identifier: Apache-2.0
//! A Simulator's stream re-encoded for a viewer that can't carry serve-sim's own (E3b, replacing
//! the screen helper's `--transcode`): VideoToolbox decodes at the target size and the picture
//! goes to the encoder in its IOSurface, with no CPU copy (`media_vt::VtTranscoder`). The
//! encoder's units become the same Annex B frames the reader passes through, under the encode's
//! id.
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
}

fn spec(wire: &EncodeSpec) -> Spec {
    let even = |value: u32| (value & !1).max(2);
    Spec {
        codec: Codec::H264,
        size: Size {
            width: even(wire.width),
            height: even(wire.height),
        },
        fps: wire.fps.clamp(1, 240),
        rate: match wire.quantizer {
            Some(q) => RateControl::Quantizer(q.clamp(18, 51) as u8),
            None => RateControl::Bitrate(wire.bitrate.max(1)),
        },
    }
}

impl Transcode {
    pub fn new(wire: &EncodeSpec) -> Result<Self, CodecError> {
        Ok(Self {
            inner: VtTranscoder::new(&spec(wire))?,
            out: Translator::default(),
            id: wire.id,
            force_key: true,
        })
    }

    /// New settings: a new size starts the encoder's stream again at a keyframe.
    pub fn configure(&mut self, wire: &EncodeSpec) -> Result<(), CodecError> {
        self.inner.configure(&spec(wire))?;
        self.id = wire.id;
        self.force_key = true;
        Ok(())
    }

    pub fn key(&mut self) {
        self.force_key = true;
    }

    /// One unit of serve-sim's stream in; whatever the encoder has finished out, as frames.
    pub fn push(
        &mut self,
        unit: &EncodedUnit,
        frames: &mut Vec<MediaFrame>,
    ) -> Result<(), CodecError> {
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
        self.poll(frames)
    }

    /// Units the encoder finished on its own threads.
    pub fn poll(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        while let Some(unit) = self.inner.encoder().poll_result()? {
            if let Some(description) = unit.description.clone() {
                let _ = self.out.frame(Record::Description(description));
            }
            let record = if unit.key {
                Record::Key(unit.data)
            } else {
                Record::Delta(unit.data)
            };
            if let Ok(Some(mut frame)) = self.out.frame(record) {
                frame.encode = self.id;
                frames.push(frame);
            }
        }
        Ok(())
    }

    /// Finishes what the encoder holds (the stream is ending).
    pub fn flush(&mut self, frames: &mut Vec<MediaFrame>) -> Result<(), CodecError> {
        self.inner.encoder().flush()?;
        self.poll(frames)
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
        Acceleration {
            steps: vec![step(Step::Decode), step(Step::Scale), encode],
            degraded: !hardware,
            reason: (!hardware)
                .then(|| "The Simulator is re-encoded on the processor here.".into()),
        }
    }
}

#[cfg(test)]
#[path = "sim_transcode_tests.rs"]
mod tests;
