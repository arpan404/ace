// SPDX-License-Identifier: Apache-2.0
//! Decode at the target size, then encode: the picture stays in one
//! IOSurface between the two sessions, so there is no CPU copy.
use crate::Copies;
use crate::decoder::{DecodeOutput, VtDecoder};
use crate::encoder::VtEncoder;
use crate::surface::{VtFormat, VtSurface};
use media_codec::*;

pub struct VtTranscoder {
    decoder: VtDecoder,
    encoder: VtEncoder,
    /// The last decoded picture, retained (a retain, not a copy) so a still source can be
    /// encoded again as a sharp keyframe without re-decoding.
    last: Option<VtSurface>,
}
impl VtTranscoder {
    pub fn new(spec: &EncodeSpec) -> Result<Self, CodecError> {
        let mut encoder = VtEncoder::new();
        encoder.configure(spec)?;
        let decoder = VtDecoder::new(DecodeOutput {
            size: Some(spec.size),
            format: VtFormat::Nv12,
        });
        Ok(Self {
            decoder,
            encoder,
            last: None,
        })
    }
    /// A new encode size also becomes the decoder's destination size.
    pub fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        self.encoder.configure(spec)?;
        self.decoder.set_output(DecodeOutput {
            size: Some(spec.size),
            format: VtFormat::Nv12,
        });
        self.last = None;
        Ok(())
    }
    /// Returns whether a picture reached the encoder (the decoder may buffer).
    /// Backpressure is reported before decoding, so the unit can be retried.
    pub fn push(&mut self, unit: &EncodedUnit, force_key: bool) -> Result<bool, CodecError> {
        if !self.encoder.has_room() {
            return Err(CodecError::Backpressure);
        }
        let Some(picture) = self.decoder.decode(unit)? else {
            return Ok(false);
        };
        if let Some(surface) = VtSurface::of(&picture) {
            self.last = Some(surface.share());
        }
        self.encoder.encode(picture, force_key)?;
        Ok(true)
    }
    /// The last decoded picture, retained without a copy; `None` before the first one.
    pub fn last_surface(&self) -> Option<VtSurface> {
        self.last.as_ref().map(VtSurface::share)
    }
    pub fn encoder(&mut self) -> &mut VtEncoder {
        &mut self.encoder
    }
    /// Both sessions report hardware.
    pub fn hardware(&self) -> bool {
        self.decoder.hardware() && self.encoder.hardware()
    }
    /// Copies per frame: the decoded IOSurface goes straight to the encoder.
    pub fn last_copies(&self) -> Copies {
        self.encoder.last_copies()
    }
}
