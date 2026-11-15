// SPDX-License-Identifier: Apache-2.0
//! `Decoder` over an H.264/HEVC decoder MFT. Given a device, a D3D11-aware decoder (DXVA)
//! writes textures; `hardware` is true only when it did, on an adapter that isn't software.
//!
//! With a device, every picture lands in a pooled texture. A slot is reserved before the
//! unit goes to the MFT, so a full pool is backpressure with the unit not consumed, and a
//! decoded picture is never dropped: extra output waits in a queue for the next call.
//! Live decoding never blocks waiting for an async MFT; `drain` does, up to two seconds.
mod picture;

use super::com::{Runtime, enter};
use super::device::MfDevice;
use super::encoder::IN_FLIGHT;
use super::mft::{Output, Transform, list};
use super::samples::memory_sample;
use super::session::subtype;
use super::surface::{MfFormat, MfSurface, Ring, Staging};
use crate::Copies;
use crate::nal::{ParameterSets, annexb_with_sets, sample_to_annexb, sets_from_record};
use media_codec::*;
use picture::{choose_nv12, open_one};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use windows::Win32::Media::MediaFoundation::*;

/// Textures per stream: what a caller may hold (the encoder's in-flight depth), the
/// reserved slot, and room for output that arrives several at once.
const POOL: usize = IN_FLIGHT + 4;
const DRAIN_LIMIT: Duration = Duration::from_secs(2);

/// Where decoded pictures go.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DecodeOutput {
    /// CPU NV12; a texture from DXVA costs one counted readback.
    Cpu,
    /// D3D11 NV12 textures; system-memory output costs one counted upload.
    #[default]
    Surface,
}

struct Open {
    transform: Transform,
    codec: Codec,
    size: Size,
    /// The output type's frame size (it may be padded, e.g. 1088 rows for 1080).
    coded: Size,
    stride: usize,
}

pub struct MfDecoder {
    // Declared first, and ended first in `Drop`: the MFT shuts down before the textures,
    // device and Media Foundation it uses.
    open: Option<Open>,
    ready: VecDeque<Picture>,
    reserved: Option<MfSurface>,
    ring: Option<Ring>,
    staging: Staging,
    error: Option<CodecError>,
    sets: ParameterSets,
    input: Vec<u8>,
    copies: Copies,
    hardware: bool,
    name: Option<String>,
    output: DecodeOutput,
    device: Option<MfDevice>,
    _runtime: Runtime,
}

// SAFETY: As for `MfEncoder`: free-threaded MF and D3D11 objects, one owner.
unsafe impl Send for MfDecoder {}

impl Drop for MfDecoder {
    fn drop(&mut self) {
        self.open = None;
    }
}

impl MfDecoder {
    pub fn new(device: Option<MfDevice>, output: DecodeOutput) -> Result<Self, CodecError> {
        Ok(Self {
            open: None,
            ready: VecDeque::new(),
            reserved: None,
            ring: None,
            staging: Staging::default(),
            error: None,
            sets: ParameterSets::default(),
            input: Vec::new(),
            copies: Copies::default(),
            hardware: false,
            name: None,
            output,
            device,
            _runtime: Runtime::start()?,
        })
    }

    /// The last picture came from a hardware decoder: an MFT listed as hardware, or DXVA
    /// output on an adapter that is not software.
    pub fn hardware(&self) -> bool {
        self.hardware
    }

    /// The MFT that decoded the last stream.
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn last_copies(&self) -> Copies {
        self.copies
    }

    fn open(&mut self, codec: Codec, size: Size) -> Result<(), CodecError> {
        let listed = list(
            MFT_CATEGORY_VIDEO_DECODER,
            subtype(codec)?,
            MFVideoFormat_NV12,
        );
        let mut last = CodecError::Unsupported(format!("no {codec:?} decoder MFT"));
        for candidate in &listed {
            match open_one(candidate, codec, size, self.device.as_ref()) {
                Ok(open) => {
                    self.name = Some(open.transform.name.clone());
                    self.open = Some(open);
                    return Ok(());
                }
                Err(e) => last = e,
            }
        }
        Err(last)
    }

    /// Holds a pool slot for the next picture. False when every slot is in use.
    fn reserve(&mut self, size: Size) -> Result<bool, CodecError> {
        let Some(device) = &self.device else {
            return Ok(true);
        };
        if self.reserved.as_ref().is_some_and(|r| r.size() == size) {
            return Ok(true);
        }
        self.reserved = None;
        let ring = self
            .ring
            .get_or_insert_with(|| Ring::new(device, size, MfFormat::Nv12, POOL));
        if !ring.fits(size, MfFormat::Nv12) {
            *ring = Ring::new(device, size, MfFormat::Nv12, POOL);
        }
        match ring.acquire() {
            Ok(slot) => {
                self.reserved = Some(slot);
                Ok(true)
            }
            Err(CodecError::Backpressure) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Takes output the MFT has ready, without waiting, into the queue. Stops when a pool
    /// slot can't be held, leaving the rest in the MFT for the next call.
    fn collect(&mut self) -> Result<(), CodecError> {
        loop {
            let Some(size) = self.open.as_ref().map(|o| o.size) else {
                return Ok(());
            };
            if !self.reserve(size)? {
                return Ok(());
            }
            let Some(open) = &mut self.open else {
                return Ok(());
            };
            let capacity = open.coded.width * open.coded.height * 3 / 2;
            match open.transform.output(capacity)? {
                Output::Empty => return Ok(()),
                Output::StreamChange => {
                    let (coded, stride) = choose_nv12(&open.transform, open.size)?;
                    open.coded = coded;
                    open.stride = stride;
                }
                Output::Sample(sample) => {
                    let picture = self.picture(&sample)?;
                    self.ready.push_back(picture);
                }
            }
        }
    }

    /// The unit as Annex B in `self.input`, with parameter sets before a keyframe.
    fn prepare(&mut self, unit: &EncodedUnit) -> Result<(), CodecError> {
        let codec = unit.codec;
        if let Some(record) = &unit.description {
            self.sets = sets_from_record(codec, record)
                .ok_or_else(|| CodecError::InvalidInput("malformed codec record".into()))?;
        }
        match unit.format {
            BitstreamFormat::Avcc | BitstreamFormat::Hvcc => {
                let sets = unit.key.then_some(&self.sets);
                sample_to_annexb(&unit.data, sets, &mut self.input).ok_or_else(|| {
                    CodecError::InvalidInput("malformed length-prefixed unit".into())
                })
            }
            BitstreamFormat::AnnexB => {
                self.sets.absorb(codec, &unit.data);
                annexb_with_sets(codec, &unit.data, &self.sets, unit.key, &mut self.input);
                Ok(())
            }
            BitstreamFormat::Elementary => Err(CodecError::Unsupported("elementary units".into())),
        }
    }

    /// Ends the stream and returns every picture not yet handed out (some decoders keep
    /// one back even in low-latency mode). The next unit must be a keyframe. An error
    /// partway keeps what was collected; the error comes back from the next `decode`.
    pub fn drain(&mut self) -> Result<Vec<Picture>, CodecError> {
        enter();
        if let Err(error) = self.drain_open() {
            self.error.get_or_insert(error);
        }
        self.open = None;
        self.reserved = None;
        Ok(self.ready.drain(..).collect())
    }

    fn drain_open(&mut self) -> Result<(), CodecError> {
        let Some(open) = &mut self.open else {
            return Ok(());
        };
        open.transform.drain()?;
        let until = Instant::now() + DRAIN_LIMIT;
        loop {
            let before = self.ready.len();
            self.collect()?;
            let Some(open) = &mut self.open else {
                return Ok(());
            };
            let finished = if open.transform.is_async() {
                open.transform.drained()
            } else {
                // A synchronous MFT has run dry when a pass found nothing.
                self.ready.len() == before
            };
            if finished {
                return Ok(());
            }
            if Instant::now() >= until {
                return Err(CodecError::DeadlineExceeded);
            }
            if self.ready.len() == before {
                open.transform.wait(Duration::from_millis(20))?;
            }
        }
    }
}

impl Decoder for MfDecoder {
    fn decode(&mut self, unit: &EncodedUnit) -> Result<Option<Picture>, CodecError> {
        enter();
        self.copies = Copies::default();
        if let Some(error) = self.error.take() {
            return Err(error);
        }
        unit.size.validate()?;
        self.prepare(unit)?;
        let new_stream = self
            .open
            .as_ref()
            .is_none_or(|o| o.codec != unit.codec || o.size != unit.size);
        if new_stream {
            if !unit.key {
                return Err(CodecError::InvalidInput(
                    "a new stream must start at a keyframe".into(),
                ));
            }
            // The old stream's last pictures stay queued, ahead of the new stream's.
            if self.open.is_some() {
                self.drain_open()?;
                self.open = None;
            }
            self.open(unit.codec, unit.size)?;
        }
        if !self.reserve(unit.size)? {
            return Err(CodecError::Backpressure);
        }
        let sample = memory_sample(&self.input, unit.pts_us, unit.duration_us)?;
        if unit.key {
            // SAFETY: Attribute write on a sample we made.
            let _ = unsafe { sample.SetUINT32(&MFSampleExtension_CleanPoint, 1) };
        }
        let Some(open) = &mut self.open else {
            return Err(CodecError::NotConfigured);
        };
        if !open.transform.input(&sample)? {
            // A full decoder: take its output, then feed again. The unit is consumed only
            // if the second try takes it.
            self.collect()?;
            let Some(open) = &mut self.open else {
                return Err(CodecError::NotConfigured);
            };
            if !open.transform.input(&sample)? {
                return Err(CodecError::Backpressure);
            }
        }
        self.collect()?;
        Ok(self.ready.pop_front())
    }
}
