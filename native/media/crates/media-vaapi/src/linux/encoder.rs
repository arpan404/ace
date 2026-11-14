// SPDX-License-Identifier: Apache-2.0
//! H.264 and HEVC encode on `VAEntrypointEncSliceLP`/`EncSlice`, implementing media-codec's
//! [`Encoder`]. IPPP with one reference, IDR on request, CBR/VBR or CQP, ace's packed
//! SPS/PPS/VPS where the driver takes them. Each picture is synced and read back before
//! `encode` returns, so `poll` never waits.
use super::device::{Buffer, Coded, Config, Context, Device};
use super::ffi::*;
use super::params::{self, Rate, Targets};
use super::surface::{Surface, SurfacePool};
use super::vpp::{Holder, VaScaler};
use crate::formats::{NV12, VA_RT_FORMAT_YUV420};
use crate::plan::{self, Gop, H264Plan, HevcPlan};
use crate::select::{self, Candidate, rc};
use media_bitstream::{avcc::AvcConfig, hvcc::HevcConfig, nal};
use media_codec::{
    BitstreamFormat, Codec, CodecError, EncodeSpec, EncodedUnit, Encoder, EncoderCaps, Picture,
    PixelFormat, RateControl, Size,
};
use std::collections::VecDeque;
use std::sync::Arc;

#[derive(PartialEq)]
enum Headers {
    H264(H264Plan),
    Hevc(HevcPlan),
}

impl Headers {
    /// The parameter sets as Annex B: what precedes every IDR.
    fn annex_b(&self) -> Vec<u8> {
        let units = match self {
            Self::H264(p) => vec![p.sps.to_nal(), p.pps.to_nal()],
            Self::Hevc(p) => vec![p.vps.to_nal(), p.sps.to_nal(), p.pps.to_nal()],
        };
        let mut out = Vec::new();
        for unit in units {
            out.extend_from_slice(&[0, 0, 0, 1]);
            out.extend_from_slice(&unit);
        }
        out
    }

    fn coded_size(&self) -> Size {
        match self {
            Self::H264(p) => Size {
                width: (p.sps.pic_width_in_mbs_minus1 + 1) * 16,
                height: (p.sps.pic_height_in_map_units_minus1 + 1) * 16,
            },
            Self::Hevc(p) => Size {
                width: p.sps.pic_width_in_luma_samples,
                height: p.sps.pic_height_in_luma_samples,
            },
        }
    }
}

/// What a session was opened with: for the probe and for logs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SessionInfo {
    pub candidate: Candidate,
    pub rate_control: u32,
    pub packed_headers: u32,
}

struct Session {
    spec: EncodeSpec,
    info: SessionInfo,
    headers: Headers,
    // Field order is drop order: the coded buffer, then the context, then the surfaces it
    // rendered to, then the config.
    coded: Buffer,
    coded_bytes: usize,
    context: Context,
    recon: Vec<Surface>,
    inputs: SurfacePool,
    _config: Config,
    current: usize,
    have_reference: bool,
    sequence_owed: bool,
    gop: Gop,
}

pub struct VaEncoder {
    device: Arc<Device>,
    listed: Vec<(i32, Vec<i32>)>,
    session: Option<Session>,
    scaler: Option<VaScaler>,
    output: VecDeque<EncodedUnit>,
    caps: EncoderCaps,
}

fn rt_ok(value: u32) -> bool {
    value != select::ATTRIB_NOT_SUPPORTED && value & VA_RT_FORMAT_YUV420 != 0
}

impl VaEncoder {
    /// An encoder on `device`; `Unsupported` when its driver lists no H.264 or HEVC encoder.
    pub fn new(device: &Arc<Device>) -> Result<Self, CodecError> {
        let listed = device.profiles()?;
        let mut codecs = Vec::new();
        let mut max = Size {
            width: 0,
            height: 0,
        };
        let mut quantizer = false;
        for codec in [Codec::H264, Codec::Hevc] {
            let Some(c) = select::encode_candidates(codec, &listed).first().copied() else {
                continue;
            };
            let v = device.attributes(
                c.profile,
                c.entrypoint,
                &[
                    attrib::RT_FORMAT,
                    attrib::RATE_CONTROL,
                    attrib::MAX_PICTURE_WIDTH,
                    attrib::MAX_PICTURE_HEIGHT,
                ],
            )?;
            if !rt_ok(v[0]) {
                continue;
            }
            codecs.push(codec);
            quantizer |= v[1] != select::ATTRIB_NOT_SUPPORTED && v[1] & rc::CQP != 0;
            let limit = |a: u32| {
                if a == select::ATTRIB_NOT_SUPPORTED {
                    media_codec::MAX_DIMENSION
                } else {
                    a.min(media_codec::MAX_DIMENSION)
                }
            };
            max.width = max.width.max(limit(v[2]));
            max.height = max.height.max(limit(v[3]));
        }
        if codecs.is_empty() {
            return Err(CodecError::Unsupported("driver lists no VA encoder".into()));
        }
        Ok(Self {
            device: Arc::clone(device),
            listed,
            session: None,
            scaler: None,
            output: VecDeque::new(),
            caps: EncoderCaps {
                hardware: true,
                codecs,
                max_size: max,
                quantizer,
            },
        })
    }

    pub fn session(&self) -> Option<SessionInfo> {
        self.session.as_ref().map(|s| s.info)
    }

    fn open(&self, spec: &EncodeSpec) -> Result<Session, CodecError> {
        let candidates = select::encode_candidates(spec.codec, &self.listed);
        if candidates.is_empty() {
            return Err(CodecError::Unsupported(format!(
                "no VA encoder for {:?}",
                spec.codec
            )));
        }
        let mut last = CodecError::Unsupported("no VA encoder accepted the stream".into());
        for candidate in candidates {
            match self.open_with(spec, candidate) {
                Ok(session) => return Ok(session),
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    fn open_with(&self, spec: &EncodeSpec, candidate: Candidate) -> Result<Session, CodecError> {
        let v = self.device.attributes(
            candidate.profile,
            candidate.entrypoint,
            &[
                attrib::RT_FORMAT,
                attrib::RATE_CONTROL,
                attrib::ENC_PACKED_HEADERS,
                attrib::MAX_PICTURE_WIDTH,
                attrib::MAX_PICTURE_HEIGHT,
            ],
        )?;
        if !rt_ok(v[0]) {
            return Err(CodecError::Unsupported(
                "encoder without 4:2:0 input".into(),
            ));
        }
        let rate_control = select::rate_control(spec.rate, v[1]).ok_or_else(|| {
            CodecError::Unsupported("the driver offers no matching rate control".into())
        })?;
        let packed_headers = select::packed_headers(v[2]);
        let fits = |limit: u32, side: u32| limit == select::ATTRIB_NOT_SUPPORTED || side <= limit;
        if !fits(v[3], spec.size.width) || !fits(v[4], spec.size.height) {
            return Err(CodecError::Unsupported(
                "larger than the VA encoder allows".into(),
            ));
        }
        let headers = match spec.codec {
            Codec::H264 => Headers::H264(plan::h264_plan(spec, candidate.profile)?),
            _ => Headers::Hevc(plan::hevc_plan(spec)?),
        };
        let mut attribs = vec![
            (attrib::RT_FORMAT, VA_RT_FORMAT_YUV420),
            (attrib::RATE_CONTROL, rate_control),
        ];
        if packed_headers != 0 {
            attribs.push((attrib::ENC_PACKED_HEADERS, packed_headers));
        }
        let config =
            self.device
                .create_config(candidate.profile, candidate.entrypoint, &attribs)?;
        let coded_size = headers.coded_size();
        let recon = Surface::create(&self.device, NV12, coded_size, 2)?;
        let mut targets: Vec<VASurfaceID> = recon.iter().map(Surface::id).collect();
        let context = self
            .device
            .create_context(&config, coded_size, &mut targets)?;
        let coded_bytes = coded_capacity(coded_size, false);
        let coded = self
            .device
            .empty(&context, buffer::ENC_CODED, coded_bytes)?;
        let log2_max_frame_num = match &headers {
            Headers::H264(p) => p.sps.log2_max_frame_num(),
            Headers::Hevc(_) => 8,
        };
        Ok(Session {
            spec: spec.clone(),
            info: SessionInfo {
                candidate,
                rate_control,
                packed_headers,
            },
            headers,
            coded,
            coded_bytes,
            context,
            recon,
            inputs: SurfacePool::new(&self.device, NV12, spec.size)?,
            _config: config,
            current: 0,
            have_reference: false,
            sequence_owed: true,
            gop: Gop::new(plan::intra_period(spec), log2_max_frame_num),
        })
    }

    fn scaler(&mut self) -> Result<&mut VaScaler, CodecError> {
        if self.scaler.is_none() {
            self.scaler = Some(VaScaler::new(&self.device)?);
        }
        self.scaler
            .as_mut()
            .ok_or_else(|| CodecError::Backend("VA video processing unavailable".into()))
    }

    /// The NV12 surface at the session's size that holds `picture`.
    fn input<'p>(&mut self, picture: &'p Picture) -> Result<InputSurface<'p>, CodecError> {
        let size = self
            .session
            .as_ref()
            .map(|s| s.spec.size)
            .ok_or(CodecError::NotConfigured)?;
        if let Picture::Platform(p) = picture
            && let Some(surface) = Surface::of(p)
            && Arc::ptr_eq(surface.device(), &self.device)
            && surface.format().pixel == PixelFormat::Nv12
            && surface.size() == size
        {
            return Ok(InputSurface::Picture(surface.id()));
        }
        if let Picture::Cpu(cpu) = picture
            && cpu.format() == PixelFormat::Nv12
            && cpu.size() == size
        {
            let surface = self
                .session
                .as_ref()
                .ok_or(CodecError::NotConfigured)?
                .inputs
                .take()?;
            surface.upload(cpu)?;
            return Ok(InputSurface::Pooled(surface));
        }
        let output = self
            .session
            .as_ref()
            .ok_or(CodecError::NotConfigured)?
            .inputs
            .take()?;
        let scaler = self.scaler()?;
        let source = scaler.surface_for(picture)?;
        scaler.process(&source, &output)?;
        Ok(InputSurface::Converted {
            output,
            _source: source,
        })
    }

    fn encode_input(
        &mut self,
        input: VASurfaceID,
        force_key: bool,
        pts_us: u64,
    ) -> Result<EncodedUnit, CodecError> {
        let device = Arc::clone(&self.device);
        let s = self.session.as_mut().ok_or(CodecError::NotConfigured)?;
        let frame = s.gop.next(force_key || !s.have_reference);
        let targets = Targets {
            reconstructed: s.recon[s.current].id(),
            reference: s.have_reference.then(|| s.recon[1 - s.current].id()),
            coded: s.coded.id,
        };
        let rate = Rate {
            bits_per_second: plan::bits_per_second(&s.spec),
            intra_period: plan::intra_period(&s.spec),
        };
        let qp = plan::initial_qp(&s.spec);
        let mut buffers: Vec<Buffer> = Vec::with_capacity(10);
        let ctx = &s.context;
        if frame.idr || s.sequence_owed {
            match &s.headers {
                Headers::H264(p) => buffers.push(device.param(
                    ctx,
                    buffer::ENC_SEQUENCE_PARAMETER,
                    &params::h264_sequence(p, rate),
                )?),
                Headers::Hevc(p) => buffers.push(device.param(
                    ctx,
                    buffer::ENC_SEQUENCE_PARAMETER,
                    &params::hevc_sequence(p, rate),
                )?),
            }
            if let RateControl::Bitrate(bps) = s.spec.rate {
                let control = VAEncMiscParameterRateControl {
                    bits_per_second: bps,
                    target_percentage: if s.info.rate_control == rc::CBR {
                        100
                    } else {
                        90
                    },
                    window_size: 1000,
                    min_qp: 18,
                    max_qp: 51,
                    ..Default::default()
                };
                buffers.push(device.misc(ctx, misc::RATE_CONTROL, &control)?);
                let hrd = VAEncMiscParameterHRD {
                    initial_buffer_fullness: bps / 2,
                    buffer_size: bps,
                    ..Default::default()
                };
                buffers.push(device.misc(ctx, misc::HRD, &hrd)?);
            }
            let rate = VAEncMiscParameterFrameRate {
                framerate: s.spec.fps,
                ..Default::default()
            };
            buffers.push(device.misc(ctx, misc::FRAME_RATE, &rate)?);
        }
        match &s.headers {
            Headers::H264(p) => buffers.push(device.param(
                ctx,
                buffer::ENC_PICTURE_PARAMETER,
                &params::h264_picture_params(p, frame, targets, 1 << p.sps.log2_max_frame_num()),
            )?),
            Headers::Hevc(p) => buffers.push(device.param(
                ctx,
                buffer::ENC_PICTURE_PARAMETER,
                &params::hevc_picture_params(p, frame, targets),
            )?),
        }
        if frame.idr && s.info.packed_headers != 0 {
            for (kind, unit) in packed_units(&s.headers, s.info.packed_headers) {
                let mut data = vec![0, 0, 0, 1];
                data.extend_from_slice(&unit);
                let header = VAEncPackedHeaderParameterBuffer {
                    type_: kind,
                    bit_length: (data.len() * 8) as u32,
                    has_emulation_bytes: 1,
                    ..Default::default()
                };
                buffers.push(device.param(ctx, buffer::ENC_PACKED_HEADER_PARAMETER, &header)?);
                buffers.push(device.data(ctx, buffer::ENC_PACKED_HEADER_DATA, &data)?);
            }
        }
        match &s.headers {
            Headers::H264(p) => buffers.push(device.param(
                ctx,
                buffer::ENC_SLICE_PARAMETER,
                &params::h264_slice(p, frame, targets, 1 << p.sps.log2_max_frame_num(), qp),
            )?),
            Headers::Hevc(p) => buffers.push(device.param(
                ctx,
                buffer::ENC_SLICE_PARAMETER,
                &params::hevc_slice(p, frame, targets, qp),
            )?),
        }
        let refs: Vec<&Buffer> = buffers.iter().collect();
        device.submit(ctx, input, &refs)?;
        device.sync(input)?;
        let mut data = Vec::new();
        if device.read_coded(&s.coded, &mut data)? == Coded::Overflow {
            // Never hand on a cut picture: grow the buffer, and the error makes the next
            // picture an IDR.
            let size = s.headers.coded_size();
            let grown = (s.coded_bytes * 2).min(coded_capacity(size, true));
            if grown > s.coded_bytes {
                s.coded = device.empty(&s.context, buffer::ENC_CODED, grown)?;
                s.coded_bytes = grown;
            }
            return Err(CodecError::Backend(
                "the picture overflowed the coded buffer".into(),
            ));
        }
        if data.is_empty() {
            return Err(CodecError::Backend(
                "the VA encoder produced no data".into(),
            ));
        }
        s.sequence_owed = false;
        s.have_reference = true;
        s.current = 1 - s.current;
        let mut description = None;
        if frame.idr {
            if !has_parameter_sets(s.spec.codec, &data) {
                let mut with = s.headers.annex_b();
                with.extend_from_slice(&data);
                data = with;
            }
            description = Some(describe(s.spec.codec, &data)?);
        }
        Ok(EncodedUnit {
            codec: s.spec.codec,
            size: s.spec.size,
            format: BitstreamFormat::AnnexB,
            data,
            key: frame.idr,
            description,
            pts_us,
            duration_us: 1_000_000 / u64::from(s.spec.fps.max(1)),
        })
    }
}

/// Coded buffer bytes for a picture of `size`: 1.5 bytes per pixel to start (an intra
/// picture rarely needs more), up to 4 after overflows, plus room for headers.
fn coded_capacity(size: Size, most: bool) -> usize {
    let pixels = size.width as usize * size.height as usize;
    let per_pixel_halves = if most { 8 } else { 3 };
    (pixels * per_pixel_halves / 2).max(1 << 16) + 4096
}

/// The encoder's input for one picture. A converted picture keeps its upload surface until
/// the encode has synced, so the pool can't hand it out while VPP may still read it.
enum InputSurface<'p> {
    Picture(VASurfaceID),
    Pooled(Surface),
    Converted {
        output: Surface,
        _source: Holder<'p>,
    },
}

impl InputSurface<'_> {
    fn id(&self) -> VASurfaceID {
        match self {
            Self::Picture(id) => *id,
            Self::Pooled(s) | Self::Converted { output: s, .. } => s.id(),
        }
    }
}

/// The packed headers to send: `(VAEncPackedHeaderType, NAL unit)`.
fn packed_units(headers: &Headers, packed: u32) -> Vec<(u32, Vec<u8>)> {
    let mut out = Vec::new();
    let seq = packed & select::packed::SEQUENCE != 0;
    let pic = packed & select::packed::PICTURE != 0;
    match headers {
        Headers::H264(p) => {
            if seq {
                out.push((packed_type::SEQUENCE, p.sps.to_nal()));
            }
            if pic {
                out.push((packed_type::PICTURE, p.pps.to_nal()));
            }
        }
        Headers::Hevc(p) => {
            if seq {
                out.push((packed_type::SEQUENCE, p.vps.to_nal()));
                out.push((packed_type::SEQUENCE, p.sps.to_nal()));
            }
            if pic {
                out.push((packed_type::PICTURE, p.pps.to_nal()));
            }
        }
    }
    out
}

fn has_parameter_sets(codec: Codec, data: &[u8]) -> bool {
    nal::annex_b_units(data).any(|u| match codec {
        Codec::H264 => nal::h264::unit_type(u) == Some(nal::h264::SPS),
        _ => nal::hevc::unit_type(u) == Some(nal::hevc::SPS),
    })
}

/// The `avcC`/`hvcC` record from the parameter sets at the start of a keyframe.
pub(crate) fn describe(codec: Codec, data: &[u8]) -> Result<Vec<u8>, CodecError> {
    let find = |t: u8, hevc: bool| {
        nal::annex_b_units(data).find(|u| {
            if hevc {
                nal::hevc::unit_type(u) == Some(t)
            } else {
                nal::h264::unit_type(u) == Some(t)
            }
        })
    };
    let missing = || CodecError::Backend("keyframe without parameter sets".into());
    let bad =
        |e: media_bitstream::BitstreamError| CodecError::Backend(format!("parameter sets: {e}"));
    match codec {
        Codec::H264 => {
            let sps = find(nal::h264::SPS, false).ok_or_else(missing)?;
            let pps = find(nal::h264::PPS, false).ok_or_else(missing)?;
            AvcConfig::from_parameter_sets(sps, pps)
                .and_then(|c| c.to_bytes())
                .map_err(bad)
        }
        _ => {
            let vps = find(nal::hevc::VPS, true).ok_or_else(missing)?;
            let sps = find(nal::hevc::SPS, true).ok_or_else(missing)?;
            let pps = find(nal::hevc::PPS, true).ok_or_else(missing)?;
            HevcConfig::from_parameter_sets(vps, sps, pps)
                .and_then(|c| c.to_bytes())
                .map_err(bad)
        }
    }
}

impl Encoder for VaEncoder {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        spec.validate()?;
        if let Some(s) = &mut self.session {
            let same_mode = matches!(
                (s.spec.rate, spec.rate),
                (RateControl::Bitrate(_), RateControl::Bitrate(_))
                    | (RateControl::Quantizer(_), RateControl::Quantizer(_))
            );
            if s.spec.codec == spec.codec
                && s.spec.size == spec.size
                && s.spec.fps == spec.fps
                && same_mode
            {
                // Only the rate: the stream continues and the next picture carries it. A new
                // rate can need a higher level; then the headers change and the next picture
                // is an IDR that carries them.
                let headers = match &s.headers {
                    Headers::H264(_) => {
                        Headers::H264(plan::h264_plan(spec, s.info.candidate.profile)?)
                    }
                    Headers::Hevc(_) => Headers::Hevc(plan::hevc_plan(spec)?),
                };
                if headers != s.headers {
                    s.headers = headers;
                    s.gop.restart();
                    s.have_reference = false;
                }
                if let RateControl::Bitrate(_) = spec.rate {
                    s.sequence_owed = true;
                }
                s.spec.rate = spec.rate;
                return Ok(());
            }
        }
        let session = self.open(spec)?;
        self.session = Some(session);
        Ok(())
    }

    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        if self.session.is_none() {
            return Err(CodecError::NotConfigured);
        }
        let pts = picture.pts_us();
        let input = self.input(&picture)?;
        match self.encode_input(input.id(), force_key, pts) {
            Ok(unit) => {
                self.output.push_back(unit);
                Ok(())
            }
            Err(e) => {
                if let Some(s) = &mut self.session {
                    // Whatever the driver did, the next picture starts over at an IDR.
                    s.have_reference = false;
                    s.gop.restart();
                }
                Err(e)
            }
        }
    }

    fn poll(&mut self) -> Option<EncodedUnit> {
        self.output.pop_front()
    }

    fn caps(&self) -> EncoderCaps {
        self.caps.clone()
    }
}
