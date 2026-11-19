// SPDX-License-Identifier: Apache-2.0
//! `VTCompressionSession` behind media-codec's `Encoder`: hardware required,
//! low-latency rate control, no frame reordering, keyframes on request.
#![allow(unsafe_code)]
use crate::Copies;
use crate::cf::{self, boolean, dictionary, number};
use crate::output::{Shared, StreamMeta};
use crate::settings::{self, Setting, Sink};
use crate::surface::{PixelPool, VtFormat, VtSurface, buffer_attributes};
use media_codec::*;
use objc2_core_foundation::{CFDictionary, CFRetained, CFString, CFType};
use objc2_core_media::{
    CMSampleBuffer, CMVideoCodecType, kCMVideoCodecType_H264, kCMVideoCodecType_HEVC,
};
use objc2_video_toolbox::*;
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::Arc;

/// Pictures accepted but not yet polled before `encode` reports backpressure.
const MAX_PENDING: usize = 8;

pub(crate) struct CompressionSession {
    raw: CFRetained<VTCompressionSession>,
    refcon: *const Shared,
    required_hardware: bool,
}
// SAFETY: VTCompressionSession may be used from any thread, one call at a time;
// the owner only reaches it through &mut. `refcon` is an Arc reference this
// value owns and releases after the session is invalidated.
unsafe impl Send for CompressionSession {}
impl CompressionSession {
    /// Opens a session whose output lands in `shared`.
    pub(crate) fn open(
        codec_type: CMVideoCodecType,
        size: Size,
        specification: &CFDictionary,
        source_format: Option<VtFormat>,
        shared: &Arc<Shared>,
    ) -> Result<Self, CodecError> {
        let attributes = source_format.map(|format| buffer_attributes(Some(size), format));
        let refcon = Arc::into_raw(Arc::clone(shared));
        let mut raw: *mut VTCompressionSession = std::ptr::null_mut();
        // SAFETY: Dictionaries hold the documented key types. `refcon` stays
        // valid until Drop, which invalidates the session before releasing it.
        let status = unsafe {
            VTCompressionSession::create(
                None,
                size.width as i32,
                size.height as i32,
                codec_type,
                Some(specification),
                attributes.as_deref(),
                None,
                Some(on_encoded),
                refcon.cast_mut().cast(),
                NonNull::from(&mut raw),
            )
        };
        let Some(raw) = NonNull::new(raw).filter(|_| status == 0) else {
            // SAFETY: The session never started, so no callback holds `refcon`.
            drop(unsafe { Arc::from_raw(refcon) });
            return Err(cf::check(status, "open compression session")
                .err()
                .unwrap_or_else(|| CodecError::Backend("no compression session".into())));
        };
        // SAFETY: Reading an immutable framework key constant.
        let required_hardware = cf::flag(specification, unsafe {
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder
        });
        Ok(Self {
            // SAFETY: Create rule: we own the returned reference.
            raw: unsafe { CFRetained::from_raw(raw) },
            refcon,
            required_hardware,
        })
    }
    pub(crate) fn session(&self) -> &VTSession {
        &self.raw
    }
    pub(crate) fn set(&self, key: &CFString, value: &CFType, what: &str) -> Result<(), CodecError> {
        cf::set(self.session(), key, value, what)
    }
    /// The session's `UsingHardwareAcceleratedVideoEncoder`. Low-latency and
    /// JPEG sessions don't report it (`kVTPropertyNotSupportedErr`); for those,
    /// a session that opened with hardware *required* is the session's answer.
    pub(crate) fn hardware(&self) -> bool {
        // SAFETY: Reading an immutable framework key constant.
        cf::copy_bool(self.session(), unsafe {
            kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder
        })
        .unwrap_or(self.required_hardware)
    }
    pub(crate) fn prepare(&self) -> Result<(), CodecError> {
        // SAFETY: Valid session.
        cf::check(
            unsafe { self.raw.prepare_to_encode_frames() },
            "prepare encoder",
        )
    }
    pub(crate) fn encode(
        &self,
        buffer: &VtSurface,
        pts_us: u64,
        duration_us: u64,
        properties: Option<&CFDictionary>,
    ) -> Result<(), CodecError> {
        // SAFETY: The session retains the pixel buffer until it is encoded.
        let status = unsafe {
            self.raw.encode_frame(
                buffer.buffer(),
                cf::time_us(pts_us),
                cf::time_us(duration_us),
                properties,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        cf::check(status, "encode frame")
    }
    /// Blocks until every submitted frame has been delivered to the callback.
    pub(crate) fn complete(&self) -> Result<(), CodecError> {
        // SAFETY: Valid session; an invalid time means "all frames".
        cf::check(
            unsafe { self.raw.complete_frames(cf::invalid_time()) },
            "complete frames",
        )
    }
}
impl Drop for CompressionSession {
    fn drop(&mut self) {
        // SAFETY: After complete + invalidate no callback runs, so the callback's
        // Arc reference can be released.
        unsafe {
            self.raw.complete_frames(cf::invalid_time());
            self.raw.invalidate();
            drop(Arc::from_raw(self.refcon));
        }
    }
}

unsafe extern "C-unwind" fn on_encoded(
    refcon: *mut c_void,
    _frame: *mut c_void,
    status: i32,
    flags: VTEncodeInfoFlags,
    sample: *mut CMSampleBuffer,
) {
    // SAFETY: `refcon` is the Arc<Shared> the session owns until invalidated;
    // `sample` is valid for the callback or null.
    let shared = unsafe { &*refcon.cast_const().cast::<Shared>() };
    let sample = unsafe { sample.as_ref() };
    shared.complete(
        status,
        flags.contains(VTEncodeInfoFlags::FrameDropped),
        sample,
    );
}

fn codec_type(codec: Codec) -> Result<(CMVideoCodecType, &'static str), CodecError> {
    match codec {
        Codec::H264 => Ok((kCMVideoCodecType_H264, "avcC")),
        Codec::Hevc => Ok((kCMVideoCodecType_HEVC, "hvcC")),
        _ => Err(CodecError::Unsupported(
            "VideoToolbox encodes H.264 and HEVC".into(),
        )),
    }
}

fn hardware_specification(low_latency: bool) -> CFRetained<CFDictionary> {
    // SAFETY: Reading immutable framework key constants.
    unsafe {
        let mut entries: Vec<(&CFString, &CFType)> = vec![(
            kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder,
            boolean(true).as_ref(),
        )];
        if low_latency {
            entries.push((
                kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
                boolean(true).as_ref(),
            ));
        }
        dictionary(&entries)
    }
}

/// An immutable frame-options dictionary built once per encoder.
struct FrameOptions(CFRetained<CFDictionary>);
// SAFETY: The dictionary is immutable after creation; immutable CF collections
// are safe to share and move between threads.
unsafe impl Send for FrameOptions {}

/// Hardware required, default rate control (capacity searches and stills).
pub(crate) fn hardware_only() -> CFRetained<CFDictionary> {
    hardware_specification(false)
}

pub struct VtEncoder {
    session: Option<CompressionSession>,
    spec: Option<EncodeSpec>,
    shared: Arc<Shared>,
    uploads: Option<PixelPool>,
    force_key: FrameOptions,
    key_owed: bool,
    hardware: bool,
    copies: Copies,
}
impl Default for VtEncoder {
    fn default() -> Self {
        Self::new()
    }
}
impl VtEncoder {
    pub fn new() -> Self {
        // SAFETY: Reading an immutable framework key constant.
        let force_key = dictionary(&[(
            unsafe { kVTEncodeFrameOptionKey_ForceKeyFrame },
            boolean(true).as_ref(),
        )]);
        Self {
            session: None,
            spec: None,
            shared: Arc::default(),
            uploads: None,
            force_key: FrameOptions(force_key),
            key_owed: true,
            hardware: false,
            copies: Copies::default(),
        }
    }
    /// What the open session reports, not what the chip is assumed to have.
    pub fn hardware(&self) -> bool {
        self.hardware
    }
    /// Copies the last accepted picture cost: 0/0 for a `VtSurface`, one upload
    /// for a CPU picture.
    pub fn last_copies(&self) -> Copies {
        self.copies
    }
    /// Whether `encode` would accept a picture now rather than report backpressure.
    pub fn has_room(&self) -> bool {
        let queue = self.shared.lock();
        queue.in_flight + queue.ready.len() < MAX_PENDING
    }
    /// Frames VideoToolbox dropped since the encoder was created.
    pub fn dropped(&self) -> u64 {
        self.shared.lock().dropped
    }
    /// The allocation-free poll: swaps the next unit's bytes into `unit`, whose
    /// previous buffer is recycled for a later frame.
    pub fn poll_into(&mut self, unit: &mut EncodedUnit) -> Result<bool, CodecError> {
        let mut queue = self.shared.lock();
        if let Some(error) = queue.error.take() {
            return Err(error);
        }
        let Some(mut slot) = queue.ready.pop_front() else {
            return Ok(false);
        };
        // Each unit carries the stream that produced it, not the current one.
        if let Some(stream) = slot.stream {
            unit.codec = stream.codec;
            unit.size = stream.size;
            unit.format = stream.format;
        }
        std::mem::swap(&mut unit.data, &mut slot.data);
        unit.key = slot.key;
        unit.pts_us = slot.pts_us;
        unit.duration_us = slot.duration_us;
        unit.description = slot.description.take();
        queue.free.push(slot);
        Ok(true)
    }
    fn open(&mut self, spec: &EncodeSpec) -> Result<CompressionSession, CodecError> {
        let (codec_type, _) = codec_type(spec.codec)?;
        // Low-latency rate control is preferred; an OS without it for this codec
        // still gets a hardware real-time session.
        let session = CompressionSession::open(
            codec_type,
            spec.size,
            &hardware_specification(true),
            Some(VtFormat::Nv12),
            &self.shared,
        )
        .or_else(|_| {
            CompressionSession::open(
                codec_type,
                spec.size,
                &hardware_specification(false),
                Some(VtFormat::Nv12),
                &self.shared,
            )
        })?;
        // SAFETY: Reading immutable framework key constants; each value has the
        // documented type.
        unsafe {
            session.set(
                kVTCompressionPropertyKey_RealTime,
                boolean(true).as_ref(),
                "real time",
            )?;
            session.set(
                kVTCompressionPropertyKey_AllowFrameReordering,
                boolean(false).as_ref(),
                "frame reordering",
            )?;
            let profile = match spec.codec {
                Codec::Hevc => kVTProfileLevel_HEVC_Main_AutoLevel,
                _ => kVTProfileLevel_H264_High_AutoLevel,
            };
            session.set(
                kVTCompressionPropertyKey_ProfileLevel,
                profile.as_ref(),
                "profile",
            )?;
        }
        apply_settings(&session, None, spec)?;
        session.prepare()?;
        Ok(session)
    }
}

impl Sink for &CompressionSession {
    fn apply(&mut self, setting: Setting) -> Result<(), CodecError> {
        // SAFETY: Reading immutable framework key constants; each value is the
        // CFNumber the key documents.
        unsafe {
            let (key, value, what) = match setting {
                Setting::FrameRate(fps) => (
                    kVTCompressionPropertyKey_ExpectedFrameRate,
                    i64::from(fps),
                    "frame rate",
                ),
                Setting::Bitrate(bits) => (
                    kVTCompressionPropertyKey_AverageBitRate,
                    i64::from(bits),
                    "bitrate",
                ),
                Setting::MinQp(qp) => (
                    kVTCompressionPropertyKey_MinAllowedFrameQP,
                    i64::from(qp),
                    "minimum QP",
                ),
                Setting::MaxQp(qp) => (
                    kVTCompressionPropertyKey_MaxAllowedFrameQP,
                    i64::from(qp),
                    "maximum QP",
                ),
            };
            let result = self.set(key, number(value).as_ref(), what);
            match setting {
                Setting::MinQp(_) | Setting::MaxQp(_) => result
                    .map_err(|_| CodecError::Unsupported("this encoder has no QP control".into())),
                _ => result,
            }
        }
    }
}

/// Applies `spec` over `previous`, all or nothing (see `settings`).
fn apply_settings(
    session: &CompressionSession,
    previous: Option<&EncodeSpec>,
    spec: &EncodeSpec,
) -> Result<(), CodecError> {
    let mut sink = session;
    settings::apply(&mut sink, previous, spec)
}

fn meta(spec: &EncodeSpec) -> Result<StreamMeta, CodecError> {
    let (_, atom) = codec_type(spec.codec)?;
    Ok(StreamMeta {
        codec: spec.codec,
        size: spec.size,
        format: format_of(spec.codec),
        atom,
    })
}

fn format_of(codec: Codec) -> BitstreamFormat {
    match codec {
        Codec::Hevc => BitstreamFormat::Hvcc,
        _ => BitstreamFormat::Avcc,
    }
}

/// Slot capacity: four average frames, at least 64 KiB, so keyframes rarely grow a slot.
fn slot_capacity(spec: &EncodeSpec) -> usize {
    let average = match spec.rate {
        RateControl::Bitrate(bits) => u64::from(bits) / 8 / u64::from(spec.fps.max(1)),
        RateControl::Quantizer(_) => u64::from(spec.size.width) * u64::from(spec.size.height) / 8,
    };
    (average * 4).clamp(64 * 1024, 8 * 1024 * 1024) as usize
}

impl Encoder for VtEncoder {
    /// Transactional: on any error the previous configuration stays in force.
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        spec.validate()?;
        let meta = meta(spec)?;
        let same_stream = self
            .spec
            .as_ref()
            .is_some_and(|old| old.codec == spec.codec && old.size == spec.size);
        if let (true, Some(session), Some(old)) =
            (same_stream, self.session.as_ref(), self.spec.as_ref())
        {
            apply_settings(session, Some(old), spec)?;
            self.spec = Some(spec.clone());
            self.shared.reserve(MAX_PENDING + 2, slot_capacity(spec));
            return Ok(());
        }
        // A new stream opens first, so a refusal leaves the old one running.
        // The old session then drains, its frames stamped with its own stream.
        let session = self.open(spec)?;
        if let Some(old) = self.session.as_ref() {
            old.complete()?;
        }
        self.shared.lock().stream = Some(meta);
        self.hardware = session.hardware();
        self.session = Some(session);
        self.spec = Some(spec.clone());
        self.key_owed = true;
        self.uploads = None;
        self.shared.reserve(MAX_PENDING + 2, slot_capacity(spec));
        Ok(())
    }
    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        let (Some(session), Some(spec)) = (self.session.as_ref(), self.spec.as_ref()) else {
            return Err(CodecError::NotConfigured);
        };
        if picture.size() != spec.size {
            return Err(CodecError::InvalidInput(
                "picture size differs from encode size".into(),
            ));
        }
        if !self.has_room() {
            return Err(CodecError::Backpressure);
        }
        let (picture, copies) = match picture {
            Picture::Cpu(cpu) => {
                let format = match cpu.format() {
                    PixelFormat::Nv12 => VtFormat::Nv12,
                    _ => VtFormat::Bgra,
                };
                if self
                    .uploads
                    .as_ref()
                    .is_none_or(|pool| pool.format() != format)
                {
                    self.uploads = Some(PixelPool::new(spec.size, format, MAX_PENDING)?);
                }
                let pool = self.uploads.as_ref().ok_or(CodecError::NotConfigured)?;
                (
                    pool.upload(&cpu)?,
                    Copies {
                        readbacks: 0,
                        uploads: 1,
                    },
                )
            }
            platform => (platform, Copies::default()),
        };
        let surface = VtSurface::of(&picture)
            .ok_or_else(|| CodecError::InvalidInput("not a CVPixelBuffer picture".into()))?;
        let key = force_key || self.key_owed;
        let duration = 1_000_000 / u64::from(spec.fps);
        // Reserved only now: a picture refused above never holds a slot.
        self.shared.lock().in_flight += 1;
        let result = session.encode(
            surface,
            picture.pts_us(),
            duration,
            key.then_some(&*self.force_key.0),
        );
        if let Err(error) = result {
            let mut queue = self.shared.lock();
            queue.in_flight = queue.in_flight.saturating_sub(1);
            return Err(error);
        }
        self.key_owed = false;
        self.copies = copies;
        Ok(())
    }
    /// Allocates the returned unit; [`VtEncoder::poll_into`] is the pooled path.
    fn poll(&mut self) -> Option<EncodedUnit> {
        self.poll_result().ok().flatten()
    }
    fn poll_result(&mut self) -> Result<Option<EncodedUnit>, CodecError> {
        let mut unit = EncodedUnit {
            codec: Codec::H264,
            size: Size {
                width: 0,
                height: 0,
            },
            format: BitstreamFormat::Avcc,
            data: Vec::new(),
            key: false,
            description: None,
            pts_us: 0,
            duration_us: 0,
        };
        Ok(self.poll_into(&mut unit)?.then_some(unit))
    }
    fn caps(&self) -> EncoderCaps {
        EncoderCaps {
            hardware: self.hardware,
            codecs: vec![Codec::H264, Codec::Hevc],
            max_size: crate::trials::largest_encode(
                self.spec.as_ref().map_or(Codec::H264, |s| s.codec),
            ),
            quantizer: true,
        }
    }
    fn flush(&mut self) -> Result<(), CodecError> {
        match self.session.as_ref() {
            Some(session) => session.complete(),
            None => Ok(()),
        }
    }
}
