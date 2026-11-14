// SPDX-License-Identifier: Apache-2.0
//! M5's CPU path for stills: `zune-jpeg` decode, SIMD scale and the CPU JPEG encoder. It makes
//! stills of JPEG sources; video needs a hardware decoder (there is no software H.264/HEVC
//! decoder in ace-media), so a video still here fails `decode-unavailable` and the daemon's
//! legacy still maker answers instead.
//!
//! A still is one planar transcode (DCT-scaled decode, scale and encode with no colour
//! conversion). A poster, whose quality is searched, decodes and scales once and encodes as
//! often as the search needs.
use super::StillBackend;
use crate::engine::stills::StillInput;
use media_codec::{
    CpuJpegCodec, CpuPicture, CpuScaler, Picture, Scaler, Size, StillCodec, jpeg_size,
};
use media_wire::control::{Backend, SourceStep, Step};
use std::sync::Arc;

#[derive(Default)]
pub struct CpuStills {
    codec: CpuJpegCodec,
    scaler: CpuScaler,
    /// The JPEG to transcode and the size to make.
    pending: Option<(Arc<[u8]>, Size)>,
    /// The pending JPEG decoded and scaled, for a poster's quality search.
    decoded: Option<CpuPicture>,
}

pub fn cpu_step(step: Step) -> SourceStep {
    SourceStep {
        step,
        backend: Backend::Cpu,
        hardware: false,
        readbacks: 0,
        uploads: 0,
    }
}

impl CpuStills {
    /// Takes a JPEG to make at `target`; the work happens at encode.
    pub fn prepare_jpeg(
        &mut self,
        jpeg: Arc<[u8]>,
        target: Size,
    ) -> Result<Vec<SourceStep>, String> {
        self.pending = None;
        self.decoded = None;
        jpeg_size(&jpeg).map_err(|_| "decode-failed")?;
        self.pending = Some((jpeg, target));
        Ok(vec![cpu_step(Step::JpegDecode), cpu_step(Step::Scale)])
    }

    fn decode_pending(&mut self) -> Result<(), String> {
        if self.decoded.is_none() {
            let (jpeg, target) = self.pending.as_ref().ok_or("nothing-prepared")?;
            let decoded = StillCodec::decode(&mut self.codec, jpeg).map_err(|_| "decode-failed")?;
            let scaled = if decoded.size() == *target {
                decoded
            } else {
                match self
                    .scaler
                    .scale(&Picture::Cpu(decoded), target.width, target.height)
                {
                    Ok(Picture::Cpu(scaled)) => scaled,
                    _ => return Err("scale-failed".into()),
                }
            };
            self.decoded = Some(scaled);
        }
        Ok(())
    }
}

impl StillBackend for CpuStills {
    fn prepare(
        &mut self,
        _stream: u32,
        input: StillInput,
        target: Size,
    ) -> Result<Vec<SourceStep>, String> {
        match input {
            StillInput::Jpeg { data, .. } => self.prepare_jpeg(data, target),
            StillInput::Video { .. } => {
                self.pending = None;
                self.decoded = None;
                Err("decode-unavailable".into())
            }
        }
    }

    fn encode(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String> {
        let (jpeg, target) = self.pending.as_ref().ok_or("nothing-prepared")?;
        self.codec
            .transcode_into(jpeg, *target, quality, out)
            .map_err(|_| "encode-failed")?;
        Ok(cpu_step(Step::JpegEncode))
    }

    fn encode_poster(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String> {
        self.decode_pending()?;
        let picture = self.decoded.as_ref().ok_or("nothing-prepared")?;
        self.codec
            .encode_into(picture, quality, out)
            .map_err(|_| "encode-failed")?;
        Ok(cpu_step(Step::JpegEncode))
    }

    fn forget(&mut self, _stream: u32) {}
}
