// SPDX-License-Identifier: Apache-2.0
//! `Encoder` over an H.264/HEVC encoder MFT.
//!
//! Input: on a hardware MFT a D3D11 NV12 texture goes in through
//! `MFCreateDXGISurfaceBuffer` with no copy; a texture in another format or size is converted
//! by the video processor first, on the GPU. The software MFT takes system-memory NV12, so a
//! texture costs it one counted readback. Output: length-prefixed NAL units with an
//! `avcC`/`hvcC` record on keyframes, like the other backends.
//!
//! Replacing a session (a new codec or size, a keyframe the MFT can't force, a stalled
//! MFT) opens the new one first, drains the old one into the queue, then swaps; if the new
//! one fails to open, the old one stays.
mod input;

use super::com::{Runtime, enter};
use super::device::MfDevice;
use super::mft::Output;
use super::samples::{InFlight, sample_bytes};
use super::session::{Session, encoders, subtype};
use super::surface::{MfSurface, Ring, Staging};
use super::vp::MfScaler;
use crate::Copies;
use crate::nal::{ParameterSets, annexb_to_sample};
use media_codec::*;
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use windows::Win32::Media::MediaFoundation::{IMFSample, MFSampleExtension_CleanPoint};

/// Pictures an MFT may hold before input is refused. Decoders size their pools from it.
pub(crate) const IN_FLIGHT: usize = 8;
const DRAIN_LIMIT: Duration = Duration::from_secs(2);
/// Input held this long with no output means the MFT has stalled; it is replaced.
const STALL: Duration = Duration::from_secs(1);
/// Longest an `encode` waits for an async MFT's input request.
const CREDIT_WAIT: Duration = Duration::from_millis(50);

pub struct MfEncoder {
    // Declared first, and ended first in `Drop`: the MFT shuts down before the textures,
    // device and Media Foundation it uses.
    session: Option<Session>,
    in_flight: InFlight,
    scaler: Option<MfScaler>,
    uploads: Option<Ring>,
    staging: Staging,
    output: VecDeque<EncodedUnit>,
    error: Option<CodecError>,
    sets: ParameterSets,
    annexb: Vec<u8>,
    sample: Vec<u8>,
    copies: Copies,
    stalls: u32,
    device: Option<MfDevice>,
    _runtime: Runtime,
}

// SAFETY: Every COM member is a free-threaded Media Foundation or D3D11 object in the MTA
// (`com.rs`) on a multithread-protected device (`device.rs`); one owner drives the encoder.
unsafe impl Send for MfEncoder {}

impl Drop for MfEncoder {
    fn drop(&mut self) {
        self.session = None;
        self.in_flight.clear();
    }
}

impl MfEncoder {
    /// With a device, hardware MFTs are tried first; without one, only software MFTs.
    pub fn new(device: Option<MfDevice>) -> Result<Self, CodecError> {
        Ok(Self {
            session: None,
            in_flight: InFlight::new(IN_FLIGHT),
            scaler: None,
            uploads: None,
            staging: Staging::default(),
            output: VecDeque::new(),
            error: None,
            sets: ParameterSets::default(),
            annexb: Vec::new(),
            sample: Vec::new(),
            copies: Copies::default(),
            stalls: 0,
            device,
            _runtime: Runtime::start()?,
        })
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

    /// Between pictures: collects output an MFT finished late and runs the watchdog, which
    /// replaces an MFT that has held input for a second with no output. A caller with pictures
    /// still owed calls this on a timer of its own, since a desktop that doesn't change sends
    /// no further picture to collect them with.
    pub fn service(&mut self) -> Result<(), CodecError> {
        enter();
        self.collect()?;
        if self.stalled()? {
            let Some(spec) = self.session.as_ref().map(|s| s.spec.clone()) else {
                return Ok(());
            };
            self.replace(&spec)?;
            self.stalls += 1;
        }
        Ok(())
    }

    /// Times the watchdog replaced an MFT that held input for a second without output.
    pub fn stalls(&self) -> u32 {
        self.stalls
    }

    fn adapter_vendor(&self) -> Option<crate::Vendor> {
        self.device.as_ref().map(|d| d.adapter().vendor)
    }

    /// Opens a session for `spec`, then drains and replaces the current one. On failure the
    /// current session is untouched.
    fn replace(&mut self, spec: &EncodeSpec) -> Result<(), CodecError> {
        let listed = encoders(spec.codec, self.adapter_vendor())?;
        let fresh = Session::open(&listed, spec, self.device.as_ref())?;
        if self.session.is_some() {
            // Whatever the old MFT still had is delivered; a failing drain loses only that.
            if let Err(error) = self.drain_session() {
                self.error.get_or_insert(error);
            }
        }
        self.session = Some(fresh);
        self.in_flight.clear();
        self.sets = ParameterSets::default();
        Ok(())
    }

    /// Asks the current MFT for its delayed output and queues it.
    fn drain_session(&mut self) -> Result<(), CodecError> {
        let Some(session) = &mut self.session else {
            return Ok(());
        };
        session.transform.drain()?;
        let deadline = Instant::now() + DRAIN_LIMIT;
        loop {
            self.collect()?;
            let Some(session) = &mut self.session else {
                return Ok(());
            };
            if !session.transform.is_async() || session.transform.drained() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(CodecError::DeadlineExceeded);
            }
            session.transform.wait(Duration::from_millis(20))?;
        }
    }

    /// Moves every ready output into the queue.
    fn collect(&mut self) -> Result<(), CodecError> {
        loop {
            let Some(session) = &mut self.session else {
                return Ok(());
            };
            let capacity = session.spec.size.width * session.spec.size.height * 3 / 2;
            match session.transform.output(capacity)? {
                Output::Empty => {
                    self.in_flight.sweep();
                    return Ok(());
                }
                Output::StreamChange => session.renegotiate()?,
                Output::Sample(sample) => self.finish(&sample)?,
            }
        }
    }

    fn finish(&mut self, sample: &IMFSample) -> Result<(), CodecError> {
        self.in_flight.progressed(Instant::now());
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
        if data.is_empty() {
            return Ok(());
        }
        let key = found.key || (clean && self.sets.complete(spec.codec));
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
            pts_us: (time.max(0) / 10) as u64,
            duration_us: if duration > 0 {
                (duration / 10) as u64
            } else {
                1_000_000 / u64::from(spec.fps)
            },
        });
        Ok(())
    }

    /// An async MFT that has held input for `STALL` with no output and no input request.
    /// A synchronous MFT, or an async one asking for input, is waiting on us, not stalled
    /// (an idle screen sends no pictures for seconds).
    fn stalled(&mut self) -> Result<bool, CodecError> {
        let Some(session) = &mut self.session else {
            return Ok(false);
        };
        if !session.transform.is_async() || session.transform.wants_input()? {
            return Ok(false);
        }
        Ok(self.in_flight.stalled(Instant::now(), STALL))
    }

    /// Whether the MFT will take a picture now, waiting a little for an async one.
    fn ready_for_input(&mut self) -> Result<bool, CodecError> {
        if self.in_flight.len() >= IN_FLIGHT {
            return Ok(false);
        }
        let Some(session) = &mut self.session else {
            return Err(CodecError::NotConfigured);
        };
        let frame = Duration::from_micros(1_000_000 / u64::from(session.spec.fps));
        session.transform.await_input(frame.min(CREDIT_WAIT))
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
        self.replace(spec)
    }

    fn encode(&mut self, picture: Picture, force_key: bool) -> Result<(), CodecError> {
        enter();
        self.copies = Copies::default();
        let Some(session) = &self.session else {
            return Err(CodecError::NotConfigured);
        };
        let spec = session.spec.clone();
        if picture.size() != spec.size && MfSurface::of(&picture).is_none() {
            return Err(CodecError::InvalidInput(
                "picture size differs from encode size".into(),
            ));
        }
        self.collect()?;
        if self.stalled()? {
            // The MFT holds input, gives nothing back and asks for nothing: start over.
            self.replace(&spec)?;
            self.stalls += 1;
        }
        if force_key
            && !self
                .session
                .as_ref()
                .is_some_and(|s| s.settings.force_key())
        {
            // An MFT that can't force a keyframe gets a new session, which opens on one.
            self.replace(&spec)?;
        }
        if !self.ready_for_input()? {
            return Err(CodecError::Backpressure);
        }
        let input = self.input(picture)?;
        self.in_flight
            .push(input.buffer.clone(), input.surface, Instant::now());
        let Some(session) = &mut self.session else {
            return Err(CodecError::NotConfigured);
        };
        if !session.transform.input(&input.sample)? {
            // A synchronous MFT that is full: take its output, then try once more.
            self.collect()?;
            let Some(session) = &mut self.session else {
                return Err(CodecError::NotConfigured);
            };
            if !session.transform.input(&input.sample)? {
                self.in_flight.cancel_last();
                return Err(CodecError::Backpressure);
            }
        }
        drop(input.sample);
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
        self.drain_session()
    }
}
