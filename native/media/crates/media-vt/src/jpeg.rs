// SPDX-License-Identifier: Apache-2.0
//! JPEG through VideoToolbox (`kCMVideoCodecType_JPEG`), used only where its
//! sessions report hardware. Otherwise the step runs on media-codec's CPU codec
//! with one upload (decode) or one readback (encode), and the path says so.
#![allow(unsafe_code)]
use crate::Copies;
use crate::cf::{boolean, dictionary, float};
use crate::decoder::{DecompressionSession, compressed_sample, format_description};
use crate::encoder::CompressionSession;
use crate::output::Shared;
use crate::surface::{PixelPool, VtFormat, VtSurface, read_back_into};
use crate::transfer::VtScaler;
use media_codec::*;
use objc2_core_foundation::{CFDictionary, CFRetained};
use objc2_core_media::{CMFormatDescription, kCMVideoCodecType_JPEG};
use objc2_video_toolbox::*;
use std::sync::Arc;

/// How the last call ran: whether each VideoToolbox session reported hardware,
/// whether the call used it, and its picture copies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JpegPath {
    pub hardware: bool,
    pub copies: Copies,
}

struct DecodeStream {
    source: Size,
    target: Size,
    format: CFRetained<CMFormatDescription>,
    session: DecompressionSession,
    hardware: bool,
}

struct EncodeStream {
    size: Size,
    quality: u8,
    session: CompressionSession,
    shared: Arc<Shared>,
    hardware: bool,
}

pub struct VtJpeg {
    output: VtFormat,
    decode: Option<DecodeStream>,
    encode: Option<EncodeStream>,
    cpu: CpuJpegCodec,
    uploads: Option<PixelPool>,
    to_bgra: Option<VtScaler>,
    scratch: Vec<u8>,
    path: JpegPath,
}
impl Default for VtJpeg {
    fn default() -> Self {
        Self::new(VtFormat::Nv12)
    }
}
impl VtJpeg {
    /// Decoded pictures use `output` when VideoToolbox decodes them.
    pub fn new(output: VtFormat) -> Self {
        Self {
            output,
            decode: None,
            encode: None,
            cpu: CpuJpegCodec::default(),
            uploads: None,
            to_bgra: None,
            scratch: Vec::new(),
            path: JpegPath::default(),
        }
    }
    pub fn last_path(&self) -> JpegPath {
        self.path
    }
    /// Whether a JPEG decode session from `source` to `target` reports hardware.
    pub fn decode_hardware(&mut self, source: Size, target: Size) -> Result<bool, CodecError> {
        Ok(self.decode_stream(source, target)?.hardware)
    }
    /// Whether a JPEG encode session at `size` reports hardware.
    pub fn encode_hardware(&mut self, size: Size) -> Result<bool, CodecError> {
        Ok(self.encode_stream(size, 80)?.hardware)
    }
    fn decode_stream(&mut self, source: Size, target: Size) -> Result<&DecodeStream, CodecError> {
        let stale = self
            .decode
            .as_ref()
            .is_none_or(|s| s.source != source || s.target != target);
        if stale {
            self.decode = None;
            let format = format_description(kCMVideoCodecType_JPEG, source, None)?;
            // SAFETY: Reading an immutable framework key constant.
            let specification = dictionary(&[(
                unsafe { kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder },
                boolean(true).as_ref(),
            )]);
            let session = DecompressionSession::open(
                &format,
                Some(&specification),
                Some(target),
                self.output,
            )?;
            let hardware = session.hardware();
            self.decode = Some(DecodeStream {
                source,
                target,
                format,
                session,
                hardware,
            });
        }
        self.decode.as_ref().ok_or(CodecError::NotConfigured)
    }
    fn encode_stream(&mut self, size: Size, quality: u8) -> Result<&EncodeStream, CodecError> {
        if self.encode.as_ref().is_none_or(|s| s.size != size) {
            self.encode = None;
            let shared = Arc::new(Shared::default());
            // SAFETY: Reading an immutable framework key constant.
            let specification: CFRetained<CFDictionary> = dictionary(&[(
                unsafe { kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder },
                boolean(true).as_ref(),
            )]);
            let session = CompressionSession::open(
                kCMVideoCodecType_JPEG,
                size,
                &specification,
                None,
                &shared,
            )?;
            let hardware = session.hardware();
            shared.reserve(2, jpeg_capacity(size));
            self.encode = Some(EncodeStream {
                size,
                quality: 0,
                session,
                shared,
                hardware,
            });
        }
        let stream = self.encode.as_mut().ok_or(CodecError::NotConfigured)?;
        if stream.quality != quality {
            // SAFETY: Reading an immutable key constant; Quality is a CFNumber 0…1.
            unsafe {
                stream.session.set(
                    kVTCompressionPropertyKey_Quality,
                    float(f64::from(quality) / 100.0).as_ref(),
                    "JPEG quality",
                )?;
            }
            stream.quality = quality;
        }
        Ok(stream)
    }
    /// Encodes into `out`, reusing its capacity on the hardware path.
    pub fn encode_into(
        &mut self,
        picture: &Picture,
        quality: u8,
        out: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        if !(1..=100).contains(&quality) {
            return Err(CodecError::InvalidInput(
                "JPEG quality outside 1..100".into(),
            ));
        }
        let surface = match picture {
            Picture::Cpu(cpu) => {
                self.path = JpegPath::default();
                *out = StillCodec::encode(&mut self.cpu, cpu, quality)?;
                return Ok(());
            }
            Picture::Platform(_) => VtSurface::of(picture)
                .ok_or_else(|| CodecError::InvalidInput("not a CVPixelBuffer picture".into()))?,
        };
        let stream = self.encode_stream(surface.size(), quality)?;
        if !stream.hardware {
            return self.encode_on_cpu(picture, surface, quality, out);
        }
        stream.shared.lock().in_flight += 1;
        stream.session.encode(surface, picture.pts_us(), 0, None)?;
        stream.session.complete()?;
        {
            let mut queue = stream.shared.lock();
            if let Some(error) = queue.error.take() {
                return Err(error);
            }
            let mut slot = queue
                .ready
                .pop_front()
                .ok_or_else(|| CodecError::Backend("VideoToolbox produced no JPEG".into()))?;
            std::mem::swap(out, &mut slot.data);
            queue.free.push(slot);
        }
        self.path = JpegPath {
            hardware: true,
            copies: Copies::default(),
        };
        Ok(())
    }
    /// The no-hardware path: one readback (after a GPU conversion to BGRA), then CPU JPEG.
    fn encode_on_cpu(
        &mut self,
        picture: &Picture,
        surface: &VtSurface,
        quality: u8,
        out: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        let converted;
        let source = if surface.format() == Some(VtFormat::Bgra) {
            picture
        } else {
            if self.to_bgra.is_none() {
                self.to_bgra = Some(VtScaler::new(VtFormat::Bgra)?);
            }
            let scaler = self.to_bgra.as_mut().ok_or(CodecError::NotConfigured)?;
            converted = scaler.transfer(surface, surface.size(), picture.pts_us())?;
            &converted
        };
        let cpu = read_back_into(source, std::mem::take(&mut self.scratch))?;
        let result = StillCodec::encode(&mut self.cpu, &cpu, quality);
        if let Ok(plane) = cpu.into_packed_plane() {
            self.scratch = plane.data;
        }
        *out = result?;
        self.path = JpegPath {
            hardware: false,
            copies: Copies {
                readbacks: 1,
                uploads: 0,
            },
        };
        Ok(())
    }
}
impl JpegCodec for VtJpeg {
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError> {
        let target = Size { width, height };
        target.validate()?;
        let source = jpeg_size(jpeg)?;
        let stream = self.decode_stream(source, target)?;
        if stream.hardware {
            let sample = compressed_sample(jpeg, &stream.format, 0, 0)?;
            let (surface, _) = stream
                .session
                .decode(&sample)?
                .ok_or_else(|| CodecError::Backend("VideoToolbox decoded no JPEG".into()))?;
            self.path = JpegPath {
                hardware: true,
                copies: Copies::default(),
            };
            return surface.into_picture(0);
        }
        // CPU decode and scale, then one upload so later steps stay on the GPU.
        let Picture::Cpu(cpu) = JpegCodec::decode(&mut self.cpu, jpeg, width, height)? else {
            return Err(CodecError::Backend("CPU decoder returned a surface".into()));
        };
        if self
            .uploads
            .as_ref()
            .is_none_or(|pool| pool.size() != target)
        {
            self.uploads = Some(PixelPool::new(target, VtFormat::Bgra, 2)?);
        }
        let pool = self.uploads.as_ref().ok_or(CodecError::NotConfigured)?;
        let picture = pool.upload(&cpu)?;
        self.path = JpegPath {
            hardware: false,
            copies: Copies {
                readbacks: 0,
                uploads: 1,
            },
        };
        Ok(picture)
    }
    fn encode(&mut self, picture: &Picture, quality: u8) -> Result<Vec<u8>, CodecError> {
        let mut out = Vec::new();
        self.encode_into(picture, quality, &mut out)?;
        Ok(out)
    }
}
