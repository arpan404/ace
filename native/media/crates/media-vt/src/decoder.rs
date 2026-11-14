// SPDX-License-Identifier: Apache-2.0
//! `VTDecompressionSession` behind media-codec's `Decoder`. The output size is
//! the session's destination size, so the decoder scales on the GPU.
#![allow(unsafe_code)]
use crate::cf::{self, boolean, dictionary};
use crate::surface::{VtFormat, VtSurface, buffer_attributes};
use crate::transfer::VtScaler;
use media_codec::*;
use objc2_core_foundation::{CFData, CFDictionary, CFRetained, CFString, CFType};
use objc2_core_media::*;
use objc2_core_video::CVImageBuffer;
use objc2_video_toolbox::*;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Arc, Mutex, PoisonError};

type Decoded = Result<(CFRetained<CVImageBuffer>, u64), CodecError>;

#[derive(Default)]
pub(crate) struct DecodeSlot {
    out: Mutex<Option<Decoded>>,
}
// SAFETY: The slot is reached from the session's callback thread and its owner;
// the Mutex serialises access, and CVPixelBuffer retain/release is thread-safe.
unsafe impl Send for DecodeSlot {}
// SAFETY: As above: all access goes through the Mutex.
unsafe impl Sync for DecodeSlot {}

pub(crate) struct DecompressionSession {
    raw: CFRetained<VTDecompressionSession>,
    refcon: *const DecodeSlot,
    slot: Arc<DecodeSlot>,
}
// SAFETY: The session is used one call at a time through &mut owners; the
// callback only touches the Mutex-guarded slot. `refcon` is an owned Arc
// reference released after invalidation.
unsafe impl Send for DecompressionSession {}
impl DecompressionSession {
    pub(crate) fn open(
        format: &CMFormatDescription,
        specification: Option<&CFDictionary>,
        size: Option<Size>,
        pixels: VtFormat,
    ) -> Result<Self, CodecError> {
        let slot = Arc::new(DecodeSlot::default());
        let refcon = Arc::into_raw(Arc::clone(&slot));
        let record = VTDecompressionOutputCallbackRecord {
            decompressionOutputCallback: Some(on_decoded),
            decompressionOutputRefCon: refcon.cast_mut().cast(),
        };
        let attributes = buffer_attributes(size, pixels);
        let mut raw: *mut VTDecompressionSession = std::ptr::null_mut();
        // SAFETY: The record and dictionaries are valid for the call (VT copies
        // the record). `refcon` outlives the session; see Drop.
        let status = unsafe {
            VTDecompressionSession::create(
                None,
                format,
                specification,
                Some(&attributes),
                &record,
                NonNull::from(&mut raw),
            )
        };
        let Some(raw) = NonNull::new(raw).filter(|_| status == 0) else {
            // SAFETY: No session exists, so nothing else holds `refcon`.
            drop(unsafe { Arc::from_raw(refcon) });
            return Err(cf::check(status, "open decompression session")
                .err()
                .unwrap_or_else(|| CodecError::Backend("no decompression session".into())));
        };
        Ok(Self {
            // SAFETY: Create rule.
            raw: unsafe { CFRetained::from_raw(raw) },
            refcon,
            slot,
        })
    }
    pub(crate) fn hardware(&self) -> bool {
        // SAFETY: Reading an immutable framework key constant.
        cf::copy_bool(&self.raw, unsafe {
            kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder
        })
        .unwrap_or(false)
    }
    /// Decodes one sample synchronously; `None` when the decoder held it back.
    pub(crate) fn decode(
        &self,
        sample: &CMSampleBuffer,
    ) -> Result<Option<(VtSurface, u64)>, CodecError> {
        // SAFETY: Synchronous decode (no flags): the callback has run, or the
        // frame is delayed, when this returns.
        let status = unsafe {
            self.raw.decode_frame(
                sample,
                VTDecodeFrameFlags::empty(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        let out = self
            .slot
            .out
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        cf::check(status, "decode frame")?;
        match out {
            Some(Ok((buffer, pts))) => Ok(Some((VtSurface::new(buffer), pts))),
            Some(Err(error)) => Err(error),
            None => Ok(None),
        }
    }
}
impl Drop for DecompressionSession {
    fn drop(&mut self) {
        // SAFETY: After wait + invalidate no callback runs.
        unsafe {
            self.raw.wait_for_asynchronous_frames();
            self.raw.invalidate();
            drop(Arc::from_raw(self.refcon));
        }
    }
}

unsafe extern "C-unwind" fn on_decoded(
    refcon: *mut c_void,
    _frame: *mut c_void,
    status: i32,
    flags: VTDecodeInfoFlags,
    image: *mut CVImageBuffer,
    pts: CMTime,
    _duration: CMTime,
) {
    // SAFETY: `refcon` is the session's owned Arc<DecodeSlot>; `image` is a
    // borrowed buffer we retain.
    let slot = unsafe { &*refcon.cast_const().cast::<DecodeSlot>() };
    let result = match NonNull::new(image) {
        _ if status != 0 => Err(CodecError::Backend(format!(
            "VideoToolbox decode failed ({status})"
        ))),
        _ if flags.contains(VTDecodeInfoFlags::FrameDropped) => return,
        Some(image) => Ok((unsafe { CFRetained::retain(image) }, cf::us_from_time(pts))),
        None => return,
    };
    *slot.out.lock().unwrap_or_else(PoisonError::into_inner) = Some(result);
}

/// A ready sample holding a copy of `bytes` (compressed data, not a picture).
pub(crate) fn compressed_sample(
    bytes: &[u8],
    format: &CMFormatDescription,
    pts_us: u64,
    duration_us: u64,
) -> Result<CFRetained<CMSampleBuffer>, CodecError> {
    let source = NonNull::new(bytes.as_ptr().cast_mut())
        .filter(|_| !bytes.is_empty())
        .ok_or_else(|| CodecError::InvalidInput("empty unit".into()))?;
    let mut block: *mut CMBlockBuffer = std::ptr::null_mut();
    // SAFETY: NULL memory with AssureMemoryNow allocates `len` bytes CoreMedia
    // owns; the bytes are then copied in, so the sample never borrows `bytes`.
    let block = unsafe {
        let status = CMBlockBuffer::create_with_memory_block(
            None,
            std::ptr::null_mut(),
            bytes.len(),
            None,
            std::ptr::null(),
            0,
            bytes.len(),
            kCMBlockBufferAssureMemoryNowFlag,
            NonNull::from(&mut block),
        );
        cf::check(status, "block buffer")?;
        let block = CFRetained::from_raw(
            NonNull::new(block).ok_or_else(|| CodecError::Backend("no block buffer".into()))?,
        );
        cf::check(
            CMBlockBuffer::replace_data_bytes(source.cast(), &block, 0, bytes.len()),
            "fill block buffer",
        )?;
        block
    };
    let timing = CMSampleTimingInfo {
        duration: cf::time_us(duration_us),
        presentationTimeStamp: cf::time_us(pts_us),
        decodeTimeStamp: cf::invalid_time(),
    };
    let size = bytes.len();
    let mut sample: *mut CMSampleBuffer = std::ptr::null_mut();
    // SAFETY: One sample with one timing entry and one size entry.
    unsafe {
        cf::check(
            CMSampleBuffer::create_ready(
                None,
                Some(&block),
                Some(format),
                1,
                1,
                &timing,
                1,
                &size,
                NonNull::from(&mut sample),
            ),
            "sample buffer",
        )?;
        Ok(CFRetained::from_raw(NonNull::new(sample).ok_or_else(
            || CodecError::Backend("no sample buffer".into()),
        )?))
    }
}

/// A video format description for `codec`, optionally carrying a configuration atom.
pub(crate) fn format_description(
    codec_type: CMVideoCodecType,
    size: Size,
    atom: Option<(&str, &[u8])>,
) -> Result<CFRetained<CMFormatDescription>, CodecError> {
    let extensions = atom.map(|(name, bytes)| {
        let key = CFString::from_str(name);
        let data = CFData::from_bytes(bytes);
        let atoms = dictionary(&[(&key, data.as_ref())]);
        // SAFETY: Reading an immutable framework key constant.
        dictionary(&[(
            unsafe { kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms },
            atoms.as_ref(),
        )])
    });
    let mut out: *const CMFormatDescription = std::ptr::null();
    // SAFETY: Extensions are deep-copied by CoreMedia; the out pointer gets +1.
    unsafe {
        cf::check(
            CMVideoFormatDescriptionCreate(
                None,
                codec_type,
                size.width as i32,
                size.height as i32,
                extensions.as_deref(),
                NonNull::from(&mut out),
            ),
            "format description",
        )?;
        Ok(CFRetained::from_raw(
            NonNull::new(out.cast_mut()).ok_or_else(|| CodecError::Backend("no format".into()))?,
        ))
    }
}

/// The decoder's output: its destination size (`None` keeps the coded size)
/// and pixel layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeOutput {
    pub size: Option<Size>,
    pub format: VtFormat,
}
impl Default for DecodeOutput {
    fn default() -> Self {
        Self {
            size: None,
            format: VtFormat::Nv12,
        }
    }
}

struct Stream {
    codec: Codec,
    format_kind: BitstreamFormat,
    size: Size,
    output: DecodeOutput,
    description: Vec<u8>,
    format: CFRetained<CMFormatDescription>,
    session: DecompressionSession,
}

pub struct VtDecoder {
    output: DecodeOutput,
    stream: Option<Stream>,
    hardware: bool,
    bridge: Option<(VtFormat, VtScaler)>,
}
impl VtDecoder {
    pub fn new(output: DecodeOutput) -> Self {
        Self {
            output,
            stream: None,
            hardware: false,
            bridge: None,
        }
    }
    /// What the open session reports.
    pub fn hardware(&self) -> bool {
        self.hardware
    }
    /// A new destination size or layout applies from the next unit: the session
    /// is reopened at the next keyframe, and until then pictures are scaled on
    /// the GPU, so no keyframe is needed.
    pub fn set_output(&mut self, output: DecodeOutput) {
        self.output = output;
    }
    fn open(&mut self, unit: &EncodedUnit, description: &[u8]) -> Result<(), CodecError> {
        let (codec_type, atom) = match (unit.codec, unit.format) {
            (Codec::H264, BitstreamFormat::Avcc) => (kCMVideoCodecType_H264, "avcC"),
            (Codec::Hevc, BitstreamFormat::Hvcc) => (kCMVideoCodecType_HEVC, "hvcC"),
            _ => {
                return Err(CodecError::Unsupported(
                    "VideoToolbox decodes length-prefixed H.264 (avcC) or HEVC (hvcC)".into(),
                ));
            }
        };
        let format = format_description(codec_type, unit.size, Some((atom, description)))?;
        // SAFETY: Reading an immutable framework key constant.
        let specification = dictionary(&[(
            unsafe { kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder },
            boolean(true).as_ref() as &CFType,
        )]);
        let session = DecompressionSession::open(
            &format,
            Some(&specification),
            self.output.size,
            self.output.format,
        )?;
        self.hardware = session.hardware();
        self.stream = Some(Stream {
            codec: unit.codec,
            format_kind: unit.format,
            size: unit.size,
            output: self.output,
            description: description.to_vec(),
            format,
            session,
        });
        Ok(())
    }
}
impl Decoder for VtDecoder {
    fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError> {
        if let Some(description) = unit.description.as_deref()
            && self
                .stream
                .as_ref()
                .is_none_or(|s| s.description != description)
        {
            self.open(unit, description)?;
        } else if unit.key
            && let Some(stream) = self.stream.take_if(|s| s.output != self.output)
        {
            let config = EncodedUnit {
                codec: stream.codec,
                format: stream.format_kind,
                size: stream.size,
                data: Vec::new(),
                key: true,
                description: None,
                pts_us: 0,
                duration_us: 0,
            };
            drop(stream.session);
            self.open(&config, &stream.description)?;
        }
        let stream = self
            .stream
            .as_ref()
            .ok_or_else(|| CodecError::InvalidInput("no configuration record yet".into()))?;
        let sample = compressed_sample(&unit.data, &stream.format, unit.pts_us, unit.duration_us)?;
        let Some((surface, pts)) = stream.session.decode(&sample)? else {
            return Ok(None);
        };
        if stream.output == self.output {
            return surface.into_picture(pts).map(Some);
        }
        // Until the next keyframe reopens the session at the new output, the
        // picture is converted on the GPU into the new size and layout.
        let size = self.output.size.unwrap_or(stream.size);
        if self
            .bridge
            .as_ref()
            .is_none_or(|(format, _)| *format != self.output.format)
        {
            self.bridge = Some((self.output.format, VtScaler::new(self.output.format)?));
        }
        let (_, scaler) = self.bridge.as_mut().ok_or(CodecError::NotConfigured)?;
        scaler.transfer(&surface, size, pts).map(Some)
    }
}
