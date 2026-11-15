// SPDX-License-Identifier: Apache-2.0
//! One JPEG source's encodes (E4): the screencast pictures of a private-context tab or a
//! "Use my Chrome" tab, decoded on the GPU where the probe observed a hardware JPEG decoder
//! and encoded on the platform's hardware encoder, or by the last-resort Chrome encoder where
//! the machine has none. Runs on a thread of its own, never on the engine's; `now_us` is the
//! caller's monotonic clock.
use super::select::family;
use media_codec::{
    BitstreamFormat, Codec, CodecError, EncodeSpec as Spec, EncodedUnit, Encoder, Picture,
    RateControl, Size, jpeg_size,
};
use media_wire::capability::{Acceleration, Backend, Capability, SourceStep, Step};
use media_wire::control::EncodeSpec;
use media_wire::frame::MediaFrame;
use std::collections::{BTreeMap, VecDeque};

const KIND_VIDEO: u8 = 1;
const FLAG_KEYFRAME: u32 = 1;
const FLAG_DESCRIPTION: u32 = 4;
/// Pictures handed to an encoder whose units haven't come back yet, remembered for their
/// epochs; past this the oldest are forgotten (the encoder dropped them).
const PENDING_MAX: usize = 16;

pub enum Command {
    /// The encodes to run, replacing the previous list.
    Configure(Vec<EncodeSpec>),
    /// One picture: the base64 JPEG text as received, the epoch it was stamped with, and how
    /// long ago it was captured.
    Picture {
        text: Vec<u8>,
        epoch: u32,
        age_us: u32,
    },
    /// The encode's next picture is a keyframe.
    Key(u32),
    /// The source closed: hand over every unit still pending, then `Output::Drained`.
    Drain,
    /// The probe's findings changed (`capabilities.changed`): an encode or JPEG decode that a
    /// newly found hardware path improves moves onto it, the encode at a keyframe.
    Capabilities,
}

#[derive(Debug, PartialEq)]
pub enum Output {
    Unit(MediaFrame),
    /// The source's steps, sent when they change.
    Report(Acceleration),
    /// No encoder could run; the source ends and the daemon takes it back.
    Failed(String),
    /// Every unit of every picture handed over before `Command::Drain` has gone out.
    Drained,
}

/// A picture of the right size for one encode, and how its JPEG step ran.
pub struct Decoded {
    pub picture: Picture,
    pub backend: Backend,
    pub hardware: bool,
    pub uploads: u32,
}

/// Hands a JPEG to an encoder that decodes it itself, as one of its pictures.
pub type JpegPicture = fn(Vec<u8>, u64) -> Result<Picture, CodecError>;

/// The encoder chosen for a codec.
pub struct Chosen {
    pub encoder: Box<dyn Encoder>,
    pub backend: Backend,
    pub hardware: bool,
    /// The encoder decodes JPEG itself (Chrome): a picture of the encode's own size is handed
    /// over as it is.
    pub takes_jpeg: Option<JpegPicture>,
}

/// The platform's codecs, as the probe found them.
pub trait Backends: Send {
    fn encoder(&mut self, codec: Codec) -> Result<Chosen, CodecError>;
    /// `jpeg` at `size`, in the memory the encoder on `encoder` takes.
    fn decode(&mut self, jpeg: &[u8], size: Size, encoder: Backend) -> Result<Decoded, CodecError>;
    /// What the probe found, which decides whether a step on the CPU is degraded.
    fn probed(&self) -> Vec<Capability>;
    /// The encoder `encoder` would choose for `codec` now, `(backend, hardware)`. None: never
    /// moves a running encode.
    fn choice(&self, _codec: Codec) -> Option<(Backend, bool)> {
        None
    }
    /// The probe's findings changed: drop any decoder built for a path since improved, so the
    /// next picture builds it again.
    fn refresh(&mut self) {}
    /// A fallback (non-hardware) encoder for `codec`, to go back to when a hardware encoder an
    /// encode was cut over to fails.
    fn fallback(&mut self, _codec: Codec) -> Result<Chosen, CodecError> {
        Err(CodecError::Unsupported("no fallback encoder".into()))
    }
}

/// A boxed backend is one: the shell picks the codecs per thread.
impl Backends for Box<dyn Backends> {
    fn encoder(&mut self, codec: Codec) -> Result<Chosen, CodecError> {
        (**self).encoder(codec)
    }
    fn decode(&mut self, jpeg: &[u8], size: Size, encoder: Backend) -> Result<Decoded, CodecError> {
        (**self).decode(jpeg, size, encoder)
    }
    fn probed(&self) -> Vec<Capability> {
        (**self).probed()
    }
    fn choice(&self, codec: Codec) -> Option<(Backend, bool)> {
        (**self).choice(codec)
    }
    fn refresh(&mut self) {
        (**self).refresh();
    }
    fn fallback(&mut self, codec: Codec) -> Result<Chosen, CodecError> {
        (**self).fallback(codec)
    }
}

struct Pending {
    pts: u64,
    epoch: u32,
    captured_us: u64,
}

struct Running {
    wire: EncodeSpec,
    codec: Codec,
    size: Size,
    chosen: Chosen,
    key_owed: bool,
    description: Option<Vec<u8>>,
    codec_string: String,
    pending: VecDeque<Pending>,
    steps: Vec<SourceStep>,
    /// Cut over to hardware in this source's life (`cutover`): its failure goes back to the
    /// fallback rather than ending the source.
    moved: bool,
    /// Cut over, and its first keyframe not out yet.
    probation: Option<cutover::Probation>,
}

pub struct Worker<B: Backends> {
    backends: B,
    encodes: BTreeMap<u32, Running>,
    last_pts: u64,
    epoch: u32,
    reported: Option<Acceleration>,
    failed: bool,
}

/// The encode size: even sides, as every hardware encoder takes.
fn even(value: u32) -> u32 {
    (value & !1).max(2)
}

fn spec_of(wire: &EncodeSpec, codec: Codec) -> Spec {
    Spec {
        codec,
        size: Size {
            width: even(wire.width),
            height: even(wire.height),
        },
        fps: wire.fps.clamp(1, 240),
        rate: match wire.quantizer {
            Some(q) => RateControl::Quantizer(q.clamp(18, 51) as u8),
            None => RateControl::Bitrate(wire.bitrate.max(1)),
        },
    }
}

/// The `MediaFrame` codec number of a unit.
fn wire_codec(codec: Codec, format: BitstreamFormat) -> u8 {
    match (codec, format) {
        (Codec::H264, BitstreamFormat::AnnexB) => 1,
        (Codec::H264, _) => 2,
        (Codec::Hevc, BitstreamFormat::AnnexB) => 3,
        (Codec::Hevc, _) => 4,
        (Codec::Vp8, _) => 5,
        (Codec::Vp9, _) => 6,
    }
}

/// The WebCodecs codec string of what the encoder actually wrote: H.264's profile, constraints
/// and level come from its `avcC`; otherwise the string the encode asked for.
fn codec_string(codec: Codec, description: Option<&[u8]>, asked: &str) -> String {
    match (codec, description) {
        (Codec::H264, Some(d)) if d.len() >= 4 && d[0] == 1 => {
            format!("avc1.{:02X}{:02X}{:02X}", d[1], d[2], d[3])
        }
        _ => asked.to_owned(),
    }
}

fn reason_of(error: &CodecError) -> String {
    match error {
        CodecError::Unsupported(_) => "encoder-unavailable".into(),
        _ => "encoder-failed".into(),
    }
}

/// One picture, as every encode of the source takes it.
struct Fed<'a> {
    jpeg: &'a [u8],
    source_size: Size,
    pts: u64,
    epoch: u32,
    captured_us: u64,
}

/// Decodes the picture for `running`'s encoder and hands it over. A picture that won't decode,
/// or that a busy encoder can't take, is skipped; any other error is the encoder's.
fn feed<B: Backends>(backends: &mut B, running: &mut Running, fed: &Fed) -> Result<(), CodecError> {
    let prepared = match running.chosen.takes_jpeg {
        Some(direct) if fed.source_size == running.size => {
            direct(fed.jpeg.to_vec(), fed.pts).map(|picture| Decoded {
                picture,
                backend: running.chosen.backend,
                hardware: false,
                uploads: 0,
            })
        }
        _ => backends.decode(fed.jpeg, running.size, running.chosen.backend),
    };
    let mut decoded = match prepared {
        Ok(decoded) => decoded,
        Err(CodecError::InvalidInput(_)) => return Ok(()),
        Err(error) => return Err(error),
    };
    set_pts(&mut decoded.picture, fed.pts);
    let encode_uploads = u32::from(matches!(decoded.picture, Picture::Cpu(_)));
    let steps = vec![
        SourceStep {
            step: Step::JpegDecode,
            backend: decoded.backend,
            hardware: decoded.hardware,
            readbacks: 0,
            uploads: decoded.uploads,
        },
        SourceStep {
            step: Step::Encode,
            backend: running.chosen.backend,
            hardware: running.chosen.hardware,
            readbacks: 0,
            uploads: encode_uploads,
        },
    ];
    match running
        .chosen
        .encoder
        .encode(decoded.picture, running.key_owed)
    {
        Ok(()) => {
            running.key_owed = false;
            running.steps = steps;
            if running.pending.len() >= PENDING_MAX {
                running.pending.pop_front();
            }
            running.pending.push_back(Pending {
                pts: fed.pts,
                epoch: fed.epoch,
                captured_us: fed.captured_us,
            });
            Ok(())
        }
        // The encoder is behind: this picture is skipped, the next one taken.
        Err(CodecError::Backpressure) => Ok(()),
        Err(error) => Err(error),
    }
}

impl<B: Backends> Worker<B> {
    pub fn new(backends: B) -> Self {
        Self {
            backends,
            encodes: BTreeMap::new(),
            last_pts: 0,
            epoch: 0,
            reported: None,
            failed: false,
        }
    }

    pub fn command(&mut self, command: Command, now_us: u64, out: &mut Vec<Output>) {
        if self.failed {
            return;
        }
        match command {
            Command::Configure(specs) => self.configure(specs, out),
            Command::Picture {
                text,
                epoch,
                age_us,
            } => self.picture(&text, epoch, now_us.saturating_sub(u64::from(age_us)), out),
            Command::Key(id) => {
                if let Some(running) = self.encodes.get_mut(&id) {
                    running.key_owed = true;
                }
            }
            Command::Drain => return self.drain(now_us, out),
            Command::Capabilities => self.upgrade(now_us, out),
        }
        self.poll(now_us, out);
        // After the units, so a source reports its steps once it plays.
        if !self.failed {
            self.report(out);
        }
    }

    /// Flushes every encoder and takes what it still held. One that can't flush ends the
    /// source as undrainable, so its end is never reported clean.
    ///
    /// Mid cut-over the current (hardware) encoder finishes, and its output must still begin
    /// at a keyframe: what doesn't can't be decoded and is dropped. No picture follows a drain,
    /// so nothing is recovered onto another encoder: an error, or dropped output, makes it an
    /// unclean end, never `Drained`.
    fn drain(&mut self, now_us: u64, out: &mut Vec<Output>) {
        let mut clean = true;
        for running in self.encodes.values_mut() {
            if running.chosen.encoder.flush().is_err() {
                clean = false;
                break;
            }
            loop {
                match running.chosen.encoder.poll_result() {
                    Ok(Some(unit)) => {
                        if running.probation.is_some() {
                            if !unit.key {
                                clean = false;
                                continue;
                            }
                            running.probation = None;
                        }
                        out.push(Output::Unit(frame(running, unit, self.epoch, now_us)));
                    }
                    Ok(None) => break,
                    Err(_) => {
                        clean = false;
                        break;
                    }
                }
            }
            running.probation = None;
            if !clean {
                break;
            }
        }
        if clean {
            out.push(Output::Drained);
        } else {
            self.failed = true;
            self.encodes.clear();
            out.push(Output::Failed("encoder-undrainable".into()));
        }
    }

    fn fail(&mut self, error: &CodecError, out: &mut Vec<Output>) {
        self.failed = true;
        self.encodes.clear();
        out.push(Output::Failed(reason_of(error)));
    }

    fn configure(&mut self, specs: Vec<EncodeSpec>, out: &mut Vec<Output>) {
        let wanted: Vec<u32> = specs.iter().map(|s| s.id).collect();
        self.encodes.retain(|id, _| wanted.contains(id));
        for wire in specs {
            let id = wire.id;
            let Some(codec) = family(&wire.codec) else {
                return self.fail(&CodecError::Unsupported(wire.codec), out);
            };
            let spec = spec_of(&wire, codec);
            if let Some(running) = self.encodes.get_mut(&wire.id)
                && running.codec == codec
                && running.size == spec.size
            {
                // Only the rate or frame rate changed: the stream goes on without a keyframe.
                // It reaches whichever encoder is current.
                let applied = running.chosen.encoder.configure(&spec);
                let moved = running.moved;
                running.wire = wire;
                match applied {
                    Ok(()) => continue,
                    // A hardware encoder cut over to that can't take it: back to the fallback,
                    // which is configured with the new rate.
                    Err(_) if moved => {
                        if !self.back_to_fallback(id, out) {
                            return;
                        }
                        continue;
                    }
                    Err(error) => return self.fail(&error, out),
                }
            }
            let chosen = match self.backends.encoder(codec) {
                Ok(chosen) => chosen,
                Err(error) => return self.fail(&error, out),
            };
            let mut chosen = chosen;
            if let Err(error) = chosen.encoder.configure(&spec) {
                return self.fail(&error, out);
            }
            self.encodes.insert(
                wire.id,
                Running {
                    codec_string: wire.codec.clone(),
                    wire,
                    codec,
                    size: spec.size,
                    chosen,
                    key_owed: true,
                    description: None,
                    pending: VecDeque::new(),
                    steps: Vec::new(),
                    moved: false,
                    probation: None,
                },
            );
        }
    }

    fn picture(&mut self, text: &[u8], epoch: u32, captured_us: u64, out: &mut Vec<Output>) {
        if self.encodes.is_empty() {
            return;
        }
        let Some(jpeg) = crate::engine::base64::decode(text) else {
            return;
        };
        let Ok(source_size) = jpeg_size(&jpeg) else {
            return;
        };
        self.epoch = epoch;
        let pts = self.last_pts.saturating_add(1).max(captured_us);
        self.last_pts = pts;
        let fed = Fed {
            jpeg: &jpeg,
            source_size,
            pts,
            epoch,
            captured_us,
        };
        let ids: Vec<u32> = self.encodes.keys().copied().collect();
        for id in ids {
            let Some(running) = self.encodes.get_mut(&id) else {
                continue;
            };
            let Err(error) = feed(&mut self.backends, running, &fed) else {
                continue;
            };
            if !running.moved {
                return self.fail(&error, out);
            }
            // The hardware encoder cut over to refused it: the fallback takes this very
            // picture, as a keyframe.
            if !self.back_to_fallback(id, out) {
                return;
            }
            let Some(running) = self.encodes.get_mut(&id) else {
                continue;
            };
            if let Err(error) = feed(&mut self.backends, running, &fed) {
                return self.fail(&error, out);
            }
        }
    }

    fn report(&mut self, out: &mut Vec<Output>) {
        let Some(steps) = self
            .encodes
            .values()
            .map(|r| r.steps.clone())
            .find(|s| !s.is_empty())
        else {
            return;
        };
        let acceleration = crate::acceleration::assess(&self.backends.probed(), steps);
        if self.reported.as_ref() != Some(&acceleration) {
            self.reported = Some(acceleration.clone());
            out.push(Output::Report(acceleration));
        }
    }

    /// Takes every unit the encoders have finished. Hardware encoders finish on their own
    /// threads, so the caller polls between commands too.
    pub fn poll(&mut self, now_us: u64, out: &mut Vec<Output>) {
        if self.failed {
            return;
        }
        let mut failure = None;
        // Encodes whose cut-over hardware encoder failed, or never sent its keyframe in time.
        let mut back = Vec::new();
        for (&id, running) in &mut self.encodes {
            if running
                .probation
                .as_ref()
                .is_some_and(|p| p.expired(now_us))
            {
                back.push(id);
                continue;
            }
            loop {
                match running.chosen.encoder.poll_result() {
                    Ok(Some(unit)) => {
                        if running.probation.is_some() {
                            if !unit.key {
                                // Its output must begin at a keyframe.
                                back.push(id);
                                break;
                            }
                            running.probation = None;
                        }
                        out.push(Output::Unit(frame(running, unit, self.epoch, now_us)));
                    }
                    Ok(None) => break,
                    Err(_) if running.moved => {
                        back.push(id);
                        break;
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
        }
        if let Some(error) = failure {
            return self.fail(&error, out);
        }
        for id in back {
            if !self.back_to_fallback(id, out) {
                return;
            }
        }
    }
}

fn set_pts(picture: &mut Picture, pts: u64) {
    match picture {
        Picture::Cpu(p) => p.pts_us = pts,
        Picture::Platform(p) => p.pts_us = pts,
    }
}

/// A unit as a `MediaFrame`, stamped with the epoch and age of the picture it came from.
fn frame(running: &mut Running, unit: EncodedUnit, fallback_epoch: u32, now_us: u64) -> MediaFrame {
    while running.pending.front().is_some_and(|p| p.pts < unit.pts_us) {
        running.pending.pop_front();
    }
    let (epoch, captured_us) = match running.pending.front() {
        Some(p) if p.pts == unit.pts_us => {
            let found = (p.epoch, p.captured_us);
            running.pending.pop_front();
            found
        }
        _ => (fallback_epoch, now_us),
    };
    if let Some(description) = unit.description {
        running.codec_string = codec_string(running.codec, Some(&description), &running.wire.codec);
        running.description = Some(description);
    }
    let description = if unit.key {
        running.description.clone().unwrap_or_default()
    } else {
        Vec::new()
    };
    let mut flags = 0;
    if unit.key {
        flags |= FLAG_KEYFRAME;
    }
    if !description.is_empty() {
        flags |= FLAG_DESCRIPTION;
    }
    let side = |v: u32| u16::try_from(v).unwrap_or(u16::MAX);
    MediaFrame {
        kind: KIND_VIDEO,
        flags,
        age_us: u32::try_from(now_us.saturating_sub(captured_us)).unwrap_or(u32::MAX),
        width: side(unit.size.width),
        height: side(unit.size.height),
        display_width: side(unit.size.width),
        display_height: side(unit.size.height),
        scale: 1000,
        rotation: 0,
        codec: wire_codec(unit.codec, unit.format),
        encode: running.wire.id,
        epoch,
        codec_string: running.codec_string.clone(),
        description,
        extension: Vec::new(),
        payload: unit.data,
    }
}

#[path = "cutover.rs"]
mod cutover;

#[cfg(test)]
#[path = "worker_tests.rs"]
mod tests;
