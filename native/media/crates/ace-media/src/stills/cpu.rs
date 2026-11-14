// SPDX-License-Identifier: Apache-2.0
//! M5's CPU path for stills: `zune-jpeg` decode, SIMD scale and the CPU JPEG encoder. It makes
//! stills of JPEG sources; video needs a hardware decoder (there is no software H.264/HEVC
//! decoder in ace-media), so a video still here fails `decode-unavailable` and the daemon's
//! legacy still maker answers instead.
use super::StillBackend;
use crate::engine::stills::StillInput;
use media_codec::{CpuJpegCodec, CpuPicture, CpuScaler, Picture, Scaler, Size, StillCodec};
use media_wire::control::{Backend, SourceStep, Step};

#[derive(Default)]
pub struct CpuStills {
    codec: CpuJpegCodec,
    scaler: CpuScaler,
    prepared: Option<CpuPicture>,
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
    /// Decodes and scales a JPEG on the CPU; the picture stays here for `encode`.
    pub fn prepare_jpeg(&mut self, jpeg: &[u8], target: Size) -> Result<Vec<SourceStep>, String> {
        self.prepared = None;
        let decoded = StillCodec::decode(&mut self.codec, jpeg).map_err(|_| "decode-failed")?;
        let scaled = if decoded.size() == target {
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
        self.prepared = Some(scaled);
        Ok(vec![cpu_step(Step::JpegDecode), cpu_step(Step::Scale)])
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
            StillInput::Jpeg { data, .. } => self.prepare_jpeg(&data, target),
            StillInput::Video { .. } => {
                self.prepared = None;
                Err("decode-unavailable".into())
            }
        }
    }

    fn encode(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String> {
        let picture = self.prepared.as_ref().ok_or("nothing-prepared")?;
        self.codec
            .encode_into(picture, quality, out)
            .map_err(|_| "encode-failed")?;
        Ok(cpu_step(Step::JpegEncode))
    }

    fn forget(&mut self, _stream: u32) {}
}
