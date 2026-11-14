// SPDX-License-Identifier: Apache-2.0
//! `Encoder` over an H.264/HEVC encoder MFT.
//!
//! Input: on a hardware MFT a D3D11 NV12 texture goes in through
//! `MFCreateDXGISurfaceBuffer` with no copy; a texture in another format or size is converted
//! by the video processor first, on the GPU. The software MFT takes system-memory NV12, so a
//! texture costs it one counted readback. Output: length-prefixed NAL units with an
//! `avcC`/`hvcC` record on keyframes, like the other backends.
use super::com::{Ctx, enter};
use super::device::MfDevice;
use super::mft::{Output, memory_sample, sample_bytes, timed_sample};
use super::session::{Session, encoders, subtype};
use super::surface::{MfFormat, MfSurface, Ring, Staging, read_back_with, upload_into};
use super::vp::MfScaler;
use crate::Copies;
use crate::nal::{ParameterSets, annexb_to_sample};
use media_codec::*;
use std::collections::VecDeque;
use std::time::Duration;
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows::Win32::Media::MediaFoundation::{
    MFCreateDXGISurfaceBuffer, MFSampleExtension_CleanPoint,
};
use windows_core::Interface;

/// Frames an MFT may hold before input is refused.
const MAX_PENDING: usize = 8;
const DRAIN_LIMIT: Duration = Duration::from_secs(2);

pub struct MfEncoder {
    device: Option<MfDevice>,
    session: Option<Session>,
    output: VecDeque<EncodedUnit>,
    error: Option<CodecError>,
    sets: ParameterSets,
    annexb: Vec<u8>,
    sample: Vec<u8>,
    copies: Copies,
    scaler: Option<MfScaler>,
    uploads: Option<Ring>,
    staging: Staging,
    /// Textures an MFT may still read, with their presentation times.
    pending: VecDeque<(u64, MfSurface)>,
    in_flight: usize,
}

// SAFETY: Every COM member is a free-threaded Media Foundation or D3D11 object in the MTA
// (`com.rs`) on a multithread-protected device (`device.rs`); one owner drives the encoder.
unsafe impl Send for MfEncoder {}

impl MfEncoder {
    /// With a device, hardware MFTs are tried first; without one, only software MFTs.
    pub fn new(device: Option<MfDevice>) -> Self {
        Self {
            device,
            session: None,
            output: VecDeque::new(),
            error: None,
            sets: ParameterSets::default(),
            annexb: Vec::new(),
            sample: Vec::new(),
            copies: Copies::default(),
            scaler: None,
            uploads: None,
            staging: Staging::default(),
            pending: VecDeque::new(),
            in_flight: 0,
        }
    }

    /// What the open MFT is: `MFT_ENUM_FLAG_HARDWARE`, never inferred.
    pub fn hardware(&self) -> bool {
        self.session.as_ref().is_some_and(|s| s.transform.hardware)
    }

    /// The open MFT's friendly name.
    pub fn name(&self) -> Option<&str> {
        self.session.as_ref().map(|s| s.transform.name.as_str())
    }

    /// Picture-sized copies the last `encode` made.
    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    fn adapter_vendor(&self) -> Option<crate::Vendor> {
        self.device.as_ref().map(|d| d.adapter().vendor)
    }

    /// The input sample for `picture`, counting copies.
    fn input(
        &mut self,
        picture: Picture,
    ) -> Result<windows::Win32::Media::MediaFoundation::IMFSample, CodecError> {
        let Some(session) = &self.session else {
            return Err(CodecError::NotConfigured);
        };
        let spec = session.spec.clone();
        let d3d = session.transform.d3d;
        let pts = picture.pts_us();
        let duration = 1_000_000 / u64::from(spec.fps);
        let device = self.device.clone();
        // A texture in the wrong size or format goes through the video processor.
        let surface = match (MfSurface::of(&picture), &device) {
            (Some(s), Some(device)) if !s.device.same(device) => {
                return Err(CodecError::InvalidInput(
                    "surface from another device".into(),
                ));
            }
            (Some(s), _) if s.size == spec.size && s.format == MfFormat::Nv12 => Some(s.share()),
            (Some(s), Some(device)) => Some(self.scaler(device)?.convert(s, spec.size)?),
            (Some(_), None) => {
                return Err(CodecError::InvalidInput("surface without a device".into()));
            }
            (None, _) => None,
        };
        let cpu = match picture {
            Picture::Cpu(cpu) => Some(cpu),
            Picture::Platform(_) => None,
        };
        match (surface, cpu, d3d) {
            (Some(surface), _, true) => self.texture_sample(surface, pts, duration),
            (Some(surface), _, false) => {
                let cpu = read_back_with(&mut self.staging, &surface, pts)?;
                self.copies.readbacks += 1;
                self.cpu_sample(&cpu, duration)
            }
            (None, Some(cpu), true) => {
                let device = device.ok_or(CodecError::NotConfigured)?;
                let surface = if cpu.size() == spec.size && cpu.format() == PixelFormat::Nv12 {
                    let ring = self.uploads.get_or_insert_with(|| {
                        Ring::new(&device, spec.size, MfFormat::Nv12, MAX_PENDING)
                    });
                    if !ring.fits(spec.size, MfFormat::Nv12) {
                        *ring = Ring::new(&device, spec.size, MfFormat::Nv12, MAX_PENDING);
                    }
                    let target = ring.acquire()?;
                    upload_into(&mut self.staging, &cpu, &target)?;
                    self.copies.uploads += 1;
                    target
                } else {
                    let picture = Picture::Cpu(cpu);
                    let out =
                        self.scaler(&device)?
                            .scale(&picture, spec.size.width, spec.size.height)?;
                    self.copies.uploads += 1;
                    MfSurface::of(&out)
                        .ok_or(CodecError::NotConfigured)?
                        .share()
                };
                self.texture_sample(surface, pts, duration)
            }
            (None, Some(cpu), false) => {
                if cpu.size() != spec.size || cpu.format() != PixelFormat::Nv12 {
                    return Err(CodecError::InvalidInput(
                        "the software MFT takes NV12 at the encode size".into(),
                    ));
                }
                self.cpu_sample(&cpu, duration)
            }
            (None, None, _) => Err(CodecError::InvalidInput(
                "surface from another backend".into(),
            )),
        }
    }

    fn scaler(&mut self, device: &MfDevice) -> Result<&mut MfScaler, CodecError> {
        if self.scaler.is_none() {
            self.scaler = Some(MfScaler::new(device, MfFormat::Nv12)?);
        }
        self.scaler.as_mut().ok_or(CodecError::NotConfigured)
    }

    fn texture_sample(
        &mut self,
        surface: MfSurface,
        pts: u64,
        duration: u64,
    ) -> Result<windows::Win32::Media::MediaFoundation::IMFSample, CodecError> {
        // SAFETY: The texture is live and held in `pending` until the MFT is done with it.
        let buffer = unsafe {
            MFCreateDXGISurfaceBuffer(
                &ID3D11Texture2D::IID,
                &surface.texture,
                surface.subresource,
                false,
            )
        }
        .ctx("MFCreateDXGISurfaceBuffer")?;
        let sample = timed_sample(&buffer, pts, duration)?;
        self.pending.push_back((pts, surface));
        Ok(sample)
    }

    fn cpu_sample(
        &mut self,
        cpu: &CpuPicture,
        duration: u64,
    ) -> Result<windows::Win32::Media::MediaFoundation::IMFSample, CodecError> {
        let size = cpu.size();
        let (w, h) = (size.width as usize, size.height as usize);
        self.sample.clear();
        for (plane, rows) in cpu.planes().iter().zip([h, h / 2]) {
            for y in 0..rows {
                self.sample
                    .extend_from_slice(&plane.data[y * plane.stride..y * plane.stride + w]);
            }
        }
        memory_sample(&self.sample, cpu.pts_us, duration)
    }

    /// Moves every ready output into the queue.
    fn collect(&mut self) -> Result<(), CodecError> {
        loop {
            let Some(session) = &mut self.session else {
                return Ok(());
            };
            let capacity = session.spec.size.width * session.spec.size.height * 3 / 2;
            match session.transform.output(capacity)? {
                Output::Empty => return Ok(()),
                Output::StreamChange => session.renegotiate()?,
                Output::Sample(sample) => self.finish(&sample)?,
            }
        }
    }

    fn finish(
        &mut self,
        sample: &windows::Win32::Media::MediaFoundation::IMFSample,
    ) -> Result<(), CodecError> {
        let Some(session) = &self.session else {
            return Ok(());
        };
        let spec = session.spec.clone();
        if let Some(header) = session.sequence_header() {
            self.sets.absorb(spec.codec, &header);
        }
        sample_bytes(sample, &mut self.annexb)?;
        // SAFETY: Attribute and timing reads on a sample the MFT returned.
        let (clean, time, duration) = unsafe {
            (
                sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0,
                sample.GetSampleTime().unwrap_or(0),
                sample.GetSampleDuration().unwrap_or(0),
            )
        };
        let mut data = Vec::with_capacity(self.annexb.len());
        let found = annexb_to_sample(spec.codec, &self.annexb, &mut self.sets, &mut data);
        let key = found.key || (clean && self.sets.complete(spec.codec));
        let pts_us = (time.max(0) / 10) as u64;
        self.in_flight = self.in_flight.saturating_sub(1);
        // Encoders here never reorder (no B-frames): every texture at or before this
        // time has been read.
        while self.pending.front().is_some_and(|(p, _)| *p <= pts_us) {
            self.pending.pop_front();
        }
        if data.is_empty() {
            return Ok(());
        }
        self.output.push_back(EncodedUnit {
            codec: spec.codec,
            size: spec.size,
            format: match spec.codec {
                Codec::Hevc => BitstreamFormat::Hvcc,
                _ => BitstreamFormat::Avcc,
            },
            data,
            key,
            description: if key {
                self.sets.record(spec.codec)
            } else {
                None
            },
            pts_us,
            duration_us: if duration > 0 {
                (duration / 10) as u64
            } else {
                1_000_000 / u64::from(spec.fps)
            },
        });
        Ok(())
    }

    fn reset(&mut self) {
        self.session = None;
        self.pending.clear();
        self.in_flight = 0;
        self.sets = ParameterSets::default();
    }
}

impl Encoder for MfEncoder {
    fn configure(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        enter();
        spec.validate()?;
        subtype(spec.codec)?;
        if let Some(session) = &mut self.session {
            let old = &session.spec;
            let same_stream =
                old.codec == spec.codec && old.size == spec.size && old.fps == spec.fps;
            let same_mode = std::mem::discriminant(&old.rate) == std::mem::discriminant(&spec.rate);
            if same_stream
                && same_mode
                && (old.rate == spec.rate || session.settings.rate(spec.rate))
            {
                session.spec = spec.clone();
                return Ok(());
            }
        }
        let listed = encoders(spec.codec, self.adapter_vendor())?;
        let session = Session::open(&listed, spec, self.device.as_ref())?;
        self.reset();
        self.session = Some(session);
        Ok(())
    }

    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        enter();
        self.copies = Copies::default();
        let Some(session) = &mut self.session else {
            return Err(CodecError::NotConfigured);
        };
        if picture.size() != session.spec.size && MfSurface::of(&picture).is_none() {
            return Err(CodecError::InvalidInput(
                "picture size differs from encode size".into(),
            ));
        }
        session.transform.pump()?;
        self.collect()?;
        let Some(session) = &mut self.session else {
            return Err(CodecError::NotConfigured);
        };
        if self.in_flight >= MAX_PENDING || !session.transform.wants_input()? {
            return Err(CodecError::Backpressure);
        }
        if force_key && !session.settings.force_key() {
            // An MFT that can't force one starts a new stream instead, which opens on a key.
            let spec = session.spec.clone();
            self.session = None;
            self.configure(&spec)?;
        }
        let sample = self.input(picture)?;
        let Some(session) = &mut self.session else {
            return Err(CodecError::NotConfigured);
        };
        if !session.transform.input(&sample)? {
            // A synchronous MFT that is full: drain, then try once more.
            self.collect()?;
            let Some(session) = &mut self.session else {
                return Err(CodecError::NotConfigured);
            };
            if !session.transform.input(&sample)? {
                self.pending.pop_back();
                return Err(CodecError::Backpressure);
            }
        }
        self.in_flight += 1;
        self.collect()
    }

    fn poll(&mut self) -> Option<EncodedUnit> {
        match self.poll_result() {
            Ok(unit) => unit,
            Err(error) => {
                self.error = Some(error);
                None
            }
        }
    }

    fn poll_result(&mut self) -> Result<Option<EncodedUnit>, CodecError> {
        enter();
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        if self.output.is_empty() {
            self.collect()?;
        }
        Ok(self.output.pop_front())
    }

    fn caps(&self) -> EncoderCaps {
        let codecs = [Codec::H264, Codec::Hevc]
            .into_iter()
            .filter(|c| encoders(*c, None).is_ok_and(|l| !l.is_empty()))
            .collect();
        EncoderCaps {
            hardware: self.hardware(),
            codecs,
            max_size: Size {
                width: MAX_DIMENSION,
                height: MAX_DIMENSION,
            },
            quantizer: self.session.as_ref().is_some_and(|s| s.quantizer),
        }
    }

    fn flush(&mut self) -> Result<(), CodecError> {
        enter();
        let Some(session) = &mut self.session else {
            return Ok(());
        };
        session.transform.drain()?;
        let deadline = std::time::Instant::now() + DRAIN_LIMIT;
        loop {
            self.collect()?;
            let Some(session) = &mut self.session else {
                return Ok(());
            };
            if !session.transform.is_async() || session.transform.drained() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err(CodecError::DeadlineExceeded);
            }
            session.transform.wait(Duration::from_millis(20))?;
        }
        Ok(())
    }
}
