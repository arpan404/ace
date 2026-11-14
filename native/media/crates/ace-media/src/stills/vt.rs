// SPDX-License-Identifier: Apache-2.0
//! Stills through VideoToolbox (B1), the macOS row of "Acceleration": VT decode with its
//! destination size set to the still's, then VT JPEG encode where its session reports hardware,
//! else one readback and the CPU encoder. A later still of the same group at a smaller size is
//! scaled with `VTPixelTransferSession`, which reports nothing and so counts as not hardware;
//! one at a larger size waits for a keyframe, so a still is never scaled up.
//! A JPEG source is decoded by VideoToolbox where the probe found hardware JPEG decode, else on
//! the CPU path end to end.
use super::cpu::CpuStills;
use super::{StillBackend, encoded_unit};
use crate::engine::stills::{NEEDS_KEYFRAME, StillInput};
use media_codec::{CpuJpegCodec, CpuPicture, Decoder, JpegCodec, Picture, Size};
use media_vt::{Copies, DecodeOutput, VtDecoder, VtFormat, VtJpeg, VtScaler, VtSurface, read_back};
use media_wire::control::{Backend, SourceStep, Step};
use std::collections::HashMap;

/// What the probe found: whether VideoToolbox's JPEG sessions are worth opening.
#[derive(Clone, Copy, Debug)]
pub struct VtOptions {
    pub jpeg_encode: bool,
    pub jpeg_decode: bool,
}

struct Stream {
    group: u64,
    decoder: VtDecoder,
    picture: Option<Picture>,
    broken: bool,
    pts_us: u64,
}

enum Prepared {
    Nothing,
    /// A video stream's latest picture, already at the still's size.
    Stream(u32),
    Owned(Picture),
    Cpu,
}

pub struct VtStills {
    options: VtOptions,
    streams: HashMap<u32, Stream>,
    jpeg: VtJpeg,
    scaler: Option<VtScaler>,
    cpu: CpuStills,
    prepared: Prepared,
    /// The prepared picture read back once for a poster's quality search.
    poster: Option<CpuPicture>,
    poster_codec: CpuJpegCodec,
    /// NV12 to BGRA on the GPU, since the CPU encoder takes packed pixels.
    to_bgra: Option<VtScaler>,
}

fn step(step: Step, backend: Backend, hardware: bool, copies: Copies) -> SourceStep {
    SourceStep {
        step,
        backend,
        hardware,
        readbacks: copies.readbacks,
        uploads: copies.uploads,
    }
}

impl VtStills {
    pub fn new(options: VtOptions) -> Self {
        let jpeg = if options.jpeg_encode {
            VtJpeg::new(VtFormat::Nv12)
        } else {
            VtJpeg::without_hardware(VtFormat::Nv12)
        };
        Self {
            options,
            streams: HashMap::new(),
            jpeg,
            scaler: None,
            cpu: CpuStills::default(),
            prepared: Prepared::Nothing,
            poster: None,
            poster_codec: CpuJpegCodec::default(),
            to_bgra: None,
        }
    }

    fn jpeg_source(
        &mut self,
        data: &[u8],
        size: Size,
        target: Size,
    ) -> Result<Vec<SourceStep>, String> {
        let on_gpu =
            self.options.jpeg_decode && self.jpeg.decode_hardware(size, target) == Ok(true);
        if !on_gpu {
            self.prepared = Prepared::Cpu;
            return self.cpu.prepare_jpeg(data, target);
        }
        let picture = JpegCodec::decode(&mut self.jpeg, data, target.width, target.height)
            .map_err(|_| "decode-failed")?;
        let path = self.jpeg.last_path();
        self.prepared = Prepared::Owned(picture);
        Ok(vec![
            step(Step::JpegDecode, Backend::Vt, path.hardware, path.copies),
            // The decoder's own destination size.
            step(Step::Scale, Backend::Vt, path.hardware, Copies::default()),
        ])
    }

    fn video(
        &mut self,
        stream: u32,
        group: u64,
        units: Vec<crate::engine::stills::StillUnit>,
        target: Size,
    ) -> Result<Vec<SourceStep>, String> {
        let current = self.streams.get(&stream).is_some_and(|s| s.group == group);
        if !current {
            if units.first().is_none_or(|u| !u.key) {
                return Err("decode-failed".into());
            }
            let decoder = VtDecoder::new(DecodeOutput {
                size: Some(target),
                format: VtFormat::Nv12,
            });
            let fresh = Stream {
                group,
                decoder,
                picture: None,
                broken: false,
                pts_us: 0,
            };
            self.streams.insert(stream, fresh);
        }
        let state = self.streams.get_mut(&stream).ok_or("decode-failed")?;
        if state.broken {
            return Err("decode-failed".into());
        }
        for unit in &units {
            let decoded = encoded_unit(unit, state.pts_us)
                .and_then(|u| state.decoder.decode(&u).map_err(|_| "decode-failed".into()));
            state.pts_us += 16_667;
            match decoded {
                Ok(Some(picture)) => state.picture = Some(picture),
                Ok(None) => {}
                Err(reason) => {
                    state.broken = true;
                    state.picture = None;
                    return Err(reason);
                }
            }
        }
        let picture = state.picture.as_ref().ok_or("no-picture")?;
        let decoded = picture.size();
        // Scaling up would blur the still: a group decoded smaller starts over at a keyframe.
        if target.width > decoded.width || target.height > decoded.height {
            return Err(NEEDS_KEYFRAME.into());
        }
        let hardware = state.decoder.hardware();
        let decode = step(Step::Decode, Backend::Vt, hardware, Copies::default());
        if picture.size() == target {
            self.prepared = Prepared::Stream(stream);
            let scale = step(Step::Scale, Backend::Vt, hardware, Copies::default());
            return Ok(vec![decode, scale]);
        }
        let surface = VtSurface::of(picture).ok_or("scale-failed")?;
        if self.scaler.is_none() {
            self.scaler = Some(VtScaler::new(VtFormat::Nv12).map_err(|_| "scale-failed")?);
        }
        let scaler = self.scaler.as_mut().ok_or("scale-failed")?;
        let scaled = scaler
            .transfer(surface, target, picture.pts_us())
            .map_err(|_| "scale-failed")?;
        let copies = scaler.last_copies();
        self.prepared = Prepared::Owned(scaled);
        Ok(vec![decode, step(Step::Scale, Backend::Vt, false, copies)])
    }
}

impl StillBackend for VtStills {
    fn prepare(
        &mut self,
        stream: u32,
        input: StillInput,
        target: Size,
    ) -> Result<Vec<SourceStep>, String> {
        self.prepared = Prepared::Nothing;
        self.poster = None;
        match input {
            StillInput::Jpeg { data, size } => self.jpeg_source(&data, size, target),
            StillInput::Video { group, units, .. } => self.video(stream, group, units, target),
        }
    }

    fn encode(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String> {
        let Some(picture) = prepared_picture(&self.prepared, &self.streams)? else {
            return self.cpu.encode(quality, out);
        };
        self.jpeg
            .encode_into(picture, quality, out)
            .map_err(|_| "encode-failed")?;
        let path = self.jpeg.last_path();
        let backend = if path.hardware {
            Backend::Vt
        } else {
            Backend::Cpu
        };
        Ok(step(Step::JpegEncode, backend, path.hardware, path.copies))
    }

    /// VideoToolbox's JPEG quality has a floor (about 46 KB for a 388 × 844 screen whatever
    /// the quality asked), so a poster is converted to BGRA on the GPU, read back once, and
    /// searched on the CPU encoder.
    fn encode_poster(&mut self, quality: u8, out: &mut Vec<u8>) -> Result<SourceStep, String> {
        if self.poster.is_none() {
            let Some(picture) = prepared_picture(&self.prepared, &self.streams)? else {
                return self.cpu.encode(quality, out);
            };
            let surface = VtSurface::of(picture).ok_or("encode-failed")?;
            if self.to_bgra.is_none() {
                self.to_bgra = Some(VtScaler::new(VtFormat::Bgra).map_err(|_| "encode-failed")?);
            }
            let to_bgra = self.to_bgra.as_mut().ok_or("encode-failed")?;
            let bgra = to_bgra
                .transfer(surface, picture.size(), picture.pts_us())
                .map_err(|_| "encode-failed")?;
            self.poster = Some(read_back(&bgra).map_err(|_| "encode-failed")?);
        }
        let picture = self.poster.as_ref().ok_or("nothing-prepared")?;
        self.poster_codec
            .encode_into(picture, quality, out)
            .map_err(|_| "encode-failed")?;
        let copies = Copies {
            readbacks: 1,
            uploads: 0,
        };
        Ok(step(Step::JpegEncode, Backend::Cpu, false, copies))
    }

    fn forget(&mut self, stream: u32) {
        self.streams.remove(&stream);
        if matches!(self.prepared, Prepared::Stream(s) if s == stream) {
            self.prepared = Prepared::Nothing;
            self.poster = None;
        }
    }
}

/// The prepared GPU picture; `None` when it was prepared on the CPU path.
fn prepared_picture<'a>(
    prepared: &'a Prepared,
    streams: &'a HashMap<u32, Stream>,
) -> Result<Option<&'a Picture>, String> {
    {
        let picture = match prepared {
            Prepared::Nothing => return Err("nothing-prepared".into()),
            Prepared::Cpu => return Ok(None),
            Prepared::Owned(picture) => picture,
            Prepared::Stream(stream) => streams
                .get(stream)
                .and_then(|s| s.picture.as_ref())
                .ok_or("nothing-prepared")?,
        };
        Ok(Some(picture))
    }
}
