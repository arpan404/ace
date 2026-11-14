// SPDX-License-Identifier: Apache-2.0
//! JPEG through VideoToolbox (`kCMVideoCodecType_JPEG`), used only where its
//! sessions count as hardware. Otherwise, including when no VideoToolbox JPEG
//! session opens at all, the step runs on media-codec's cached CPU codec with
//! one upload (decode) or one readback (encode), and the path says so. The CPU
//! path never needs another VideoToolbox session.
#![allow(unsafe_code)]
use crate::Copies;
use crate::cf::{flag_dictionary, float};
use crate::decoder::{DecompressionSession, compressed_sample, format_description};
use crate::encoder::CompressionSession;
use crate::output::Shared;
use crate::surface::{PixelPool, VtFormat, VtSurface, read_back_rgb};
use media_codec::*;
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMFormatDescription, kCMVideoCodecType_JPEG};
use objc2_video_toolbox::*;
use std::sync::Arc;

/// How the last call ran: whether it used a hardware VideoToolbox session,
/// and its picture copies.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JpegPath {
    pub hardware: bool,
    pub copies: Copies,
}

struct DecodeStream {
    format: CFRetained<CMFormatDescription>,
    session: DecompressionSession,
}

struct EncodeStream {
    quality: u8,
    session: CompressionSession,
    shared: Arc<Shared>,
}

/// The session for one geometry, or `None` once it is known to be the CPU's.
type Cached<K, T> = Option<(K, Option<T>)>;

pub struct VtJpeg {
    output: VtFormat,
    use_hardware: bool,
    decode: Cached<(Size, Size), DecodeStream>,
    encode: Cached<Size, EncodeStream>,
    cpu: CpuJpegCodec,
    uploads: Option<PixelPool>,
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
            use_hardware: true,
            decode: None,
            encode: None,
            cpu: CpuJpegCodec::default(),
            uploads: None,
            scratch: Vec::new(),
            path: JpegPath::default(),
        }
    }
    /// Never opens a VideoToolbox JPEG session: for machines whose probe found
    /// no hardware JPEG, and the path a failed session open falls back to.
    pub fn without_hardware(output: VtFormat) -> Self {
        Self {
            use_hardware: false,
            ..Self::new(output)
        }
    }
    pub fn last_path(&self) -> JpegPath {
        self.path
    }
    /// Whether decoding from `source` to `target` runs on a hardware session.
    pub fn decode_hardware(&mut self, source: Size, target: Size) -> Result<bool, CodecError> {
        target.validate()?;
        Ok(self.decode_stream(source, target).is_some())
    }
    /// Whether encoding at `size` runs on a hardware session.
    pub fn encode_hardware(&mut self, size: Size) -> Result<bool, CodecError> {
        size.validate()?;
        Ok(self.encode_stream(size).is_some())
    }
    fn decode_stream(&mut self, source: Size, target: Size) -> Option<&DecodeStream> {
        if self
            .decode
            .as_ref()
            .is_none_or(|(key, _)| *key != (source, target))
        {
            self.decode = None;
            let stream = self
                .use_hardware
                .then(|| self.open_decode(source, target))
                .flatten();
            self.decode = Some(((source, target), stream));
        }
        self.decode.as_ref().and_then(|(_, stream)| stream.as_ref())
    }
    /// Hardware required first: JPEG sessions don't report the hardware
    /// property, so one that opens under the requirement is the answer. A
    /// session opened without it is kept only if it reports hardware.
    fn open_decode(&self, source: Size, target: Size) -> Option<DecodeStream> {
        let format = format_description(kCMVideoCodecType_JPEG, source, None).ok()?;
        // SAFETY: Reading immutable framework key constants.
        let (require, enable) = unsafe {
            (
                kVTVideoDecoderSpecification_RequireHardwareAcceleratedVideoDecoder,
                kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder,
            )
        };
        let open = |key| {
            DecompressionSession::open(
                &format,
                Some(&flag_dictionary(key)),
                Some(target),
                self.output,
            )
        };
        let session = open(require).or_else(|_| open(enable)).ok()?;
        session
            .hardware()
            .then_some(DecodeStream { format, session })
    }
    fn encode_stream(&mut self, size: Size) -> Option<&mut EncodeStream> {
        if self.encode.as_ref().is_none_or(|(key, _)| *key != size) {
            self.encode = None;
            let stream = self.use_hardware.then(|| open_encode(size)).flatten();
            self.encode = Some((size, stream));
        }
        self.encode.as_mut().and_then(|(_, stream)| stream.as_mut())
    }
    /// Encodes into `out`, reusing its capacity.
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
                return self.cpu.encode_into(cpu, quality, out);
            }
            Picture::Platform(_) => VtSurface::of(picture)
                .ok_or_else(|| CodecError::InvalidInput("not a CVPixelBuffer picture".into()))?,
        };
        let Some(stream) = self.encode_stream(surface.size()) else {
            return self.encode_on_cpu(surface, picture.pts_us(), quality, out);
        };
        stream.encode(surface, picture.pts_us(), quality, out)?;
        self.path = JpegPath {
            hardware: true,
            copies: Copies::default(),
        };
        Ok(())
    }
    /// One readback (converted to RGB while copying), then the CPU encoder.
    fn encode_on_cpu(
        &mut self,
        surface: &VtSurface,
        pts_us: u64,
        quality: u8,
        out: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        let mut rgb = std::mem::take(&mut self.scratch);
        let size = read_back_rgb(surface, &mut rgb)?;
        let stride = size.width as usize * 3;
        let cpu = CpuPicture::new(
            size,
            PixelFormat::Rgb8,
            [Plane { data: rgb, stride }],
            pts_us,
        )?;
        let result = self.cpu.encode_into(&cpu, quality, out);
        if let Ok(plane) = cpu.into_packed_plane() {
            self.scratch = plane.data;
        }
        result?;
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

fn open_encode(size: Size) -> Option<EncodeStream> {
    let shared = Arc::new(Shared::default());
    // SAFETY: Reading immutable framework key constants.
    let (require, enable) = unsafe {
        (
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder,
            kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder,
        )
    };
    let open = |key| {
        CompressionSession::open(
            kCMVideoCodecType_JPEG,
            size,
            &flag_dictionary(key),
            None,
            &shared,
        )
    };
    let session = open(require).or_else(|_| open(enable)).ok()?;
    if !session.hardware() {
        return None;
    }
    shared.reserve(2, jpeg_capacity(size));
    Some(EncodeStream {
        quality: 0,
        session,
        shared,
    })
}

impl EncodeStream {
    fn encode(
        &mut self,
        surface: &VtSurface,
        pts_us: u64,
        quality: u8,
        out: &mut Vec<u8>,
    ) -> Result<(), CodecError> {
        if self.quality != quality {
            // SAFETY: Reading an immutable key constant; Quality is a CFNumber 0…1.
            unsafe {
                self.session.set(
                    kVTCompressionPropertyKey_Quality,
                    float(f64::from(quality) / 100.0).as_ref(),
                    "JPEG quality",
                )?;
            }
            self.quality = quality;
        }
        self.shared.lock().in_flight += 1;
        if let Err(error) = self.session.encode(surface, pts_us, 0, None) {
            let mut queue = self.shared.lock();
            queue.in_flight = queue.in_flight.saturating_sub(1);
            return Err(error);
        }
        self.session.complete()?;
        let mut queue = self.shared.lock();
        if let Some(error) = queue.error.take() {
            return Err(error);
        }
        let mut slot = queue
            .ready
            .pop_front()
            .ok_or_else(|| CodecError::Backend("VideoToolbox produced no JPEG".into()))?;
        std::mem::swap(out, &mut slot.data);
        queue.free.push(slot);
        Ok(())
    }
}

impl JpegCodec for VtJpeg {
    fn decode(&mut self, jpeg: &[u8], width: u32, height: u32) -> Result<Picture, CodecError> {
        let target = Size { width, height };
        target.validate()?;
        let source = jpeg_size(jpeg)?;
        if let Some(stream) = self.decode_stream(source, target) {
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
