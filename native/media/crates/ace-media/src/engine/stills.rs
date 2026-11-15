// SPDX-License-Identifier: Apache-2.0
//! Stills from the current picture (docs/media/plan.md, F2; ADR 0148 §6). Pure: what each
//! source shows now, which `still.take` requests wait, and when they fail. The work itself
//! (decode, scale, JPEG) runs behind [`StillMaker`] on threads of its own.
//!
//! - **A JPEG source** keeps its latest picture; a still transcodes it.
//! - **A video source** keeps the units its maker hasn't seen yet. The maker decodes them in
//!   order with a decoder it keeps per source, so a still decodes only what changed since the
//!   last one, never the whole stream. A keyframe starts a new group and drops what came
//!   before it. Past [`MAX_UNITS`] or [`MAX_BYTES`] undecoded, the group is dropped too; the
//!   next still then asks the producer for a keyframe and waits for it.
//! - **Deadlines.** A request past its `deadlineMs` fails `deadline`, so the daemon falls back
//!   to its legacy still maker in time. A result that arrives later is dropped.
use super::{Effect, normal};
use media_codec::{Size, fit_size_with_max_pixels};
use media_wire::control::{Capability, FromMedia, Id, KeyReason, SourceStep};
use media_wire::frame::MediaFrame;
use std::collections::HashMap;
use std::sync::Arc;

/// Units a video source may hold for its maker before the group is dropped.
pub const MAX_UNITS: usize = 120;
/// Bytes a video source may hold for its maker before the group is dropped.
pub const MAX_BYTES: usize = 32 << 20;
/// Requests waiting at once; past this a request fails `busy`.
pub const MAX_PENDING: usize = 32;

const KIND_VIDEO: u8 = 1;
const KIND_PICTURE: u8 = 3;
const FLAG_KEYFRAME: u32 = 1;
const CODEC_JPEG: u8 = 7;
/// The reason a maker gives when a unit didn't decode.
pub const DECODE_FAILED: &str = "decode-failed";
/// The reason a maker gives when the group was decoded smaller than a still now asks: the
/// request waits for a keyframe, which starts a group decoded at its size.
pub const NEEDS_KEYFRAME: &str = "needs-keyframe";

/// One encoded video unit as the producer sent it.
pub struct StillUnit {
    /// The `MediaFrame` codec: 1 to 4 (H.264 or HEVC, Annex B or length-prefixed).
    pub codec: u8,
    pub key: bool,
    pub size: Size,
    pub description: Vec<u8>,
    pub payload: Vec<u8>,
}

pub enum StillInput {
    Jpeg {
        data: Arc<[u8]>,
        size: Size,
    },
    /// The units of group `group` the maker hasn't been given yet, in order. The first job of
    /// a group starts at its keyframe.
    Video {
        group: u64,
        size: Size,
        units: Vec<StillUnit>,
    },
}

pub struct StillJob {
    pub request: Id,
    /// This dispatch's own token, unique in the process: its result must carry it back, so a
    /// result is never taken for a later request that reuses the id.
    pub token: u64,
    /// The source's handle, unique in this process: the maker keeps decoder state by it.
    pub stream: u32,
    pub input: StillInput,
    /// The size to make, already fitted to the request's box and pixel budget.
    pub target: Size,
    pub make: Make,
    /// On ace-media's monotonic clock, in µs.
    pub deadline_us: u64,
}

/// What a maker made.
/// What a job makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Make {
    /// An agent's still at this JPEG quality (1–100).
    Still { quality: u8 },
    /// A viewer's poster: 10–20 KB, its quality searched (`stills::poster`).
    Poster,
}

pub struct Made {
    pub jpeg: Vec<u8>,
    pub size: Size,
    pub steps: Vec<SourceStep>,
}

pub struct StillOutcome {
    pub request: Id,
    /// The job's token.
    pub token: u64,
    pub result: Result<Made, String>,
}

/// Runs still jobs off the engine's thread. Jobs of one stream must be made in the order they
/// are taken, because each continues the decoder state of the one before.
pub trait StillMaker: Send {
    /// Queues a job. A full queue hands it back.
    fn take(&mut self, job: StillJob) -> Result<(), StillJob>;
    /// The source closed: drop its decoder state.
    fn forget(&mut self, stream: u32);
    /// The probe's findings changed (`capabilities.changed`).
    fn capabilities(&mut self, _capabilities: &[Capability]) {}
}

/// No still path in this process: every request fails, so the daemon keeps its legacy one.
pub struct NoStills;

impl StillMaker for NoStills {
    fn take(&mut self, job: StillJob) -> Result<(), StillJob> {
        Err(job)
    }
    fn forget(&mut self, _: u32) {}
}

struct Entry {
    handle: u32,
    /// The encode the stills follow: the one whose keyframe started the current group. A
    /// keyframe request names it; other encodes' deltas are ignored.
    encode: u32,
    /// The last configuration record the selected stream sent, with the configuration it
    /// belongs to. A producer sends it only when it changes, so a keyframe of the same
    /// configuration without one keeps it; any other configuration drops it.
    config: Option<(Config, Vec<u8>)>,
    current: Current,
    /// The privacy epochs the current picture's content came from: a JPEG's own, or every unit
    /// of the video group since its keyframe (a delta carries earlier content forward).
    epochs: Option<(u32, u32)>,
}

enum Current {
    Nothing,
    Jpeg {
        data: Arc<[u8]>,
        size: Size,
    },
    Video {
        group: u64,
        config: Config,
        units: Vec<StillUnit>,
        bytes: usize,
    },
    /// The group was dropped: a still needs the next keyframe.
    Lost,
    /// A codec stills don't take (VP8, VP9, PNG).
    Unsupported,
}

/// What a configuration record belongs to: one encode's codec, layout and coded size.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Config {
    encode: u32,
    codec: u8,
    size: Size,
}

struct Request {
    request: Id,
    source: String,
    bounds: Size,
    max_pixels: u64,
    make: Make,
    deadline_ms: u64,
    /// A poster's: the epochs the daemon decided clear. None for an agent's still, which is
    /// the daemon's grant (live views and stills aren't filtered by the barrier).
    clear: Option<Vec<(u32, u32)>>,
}

struct Held {
    request: Request,
    token: u64,
    /// The video group the job continued, if any.
    group: Option<u64>,
    /// The epochs of the picture it is made from.
    epochs: Option<(u32, u32)>,
}

/// Discarded ranges remembered per source.
const MAX_DISCARDED: usize = 1024;

pub struct Stills {
    maker: Box<dyn StillMaker>,
    current: HashMap<String, Entry>,
    next_group: u64,
    next_token: u64,
    /// Requests waiting for a keyframe.
    waiting: Vec<Request>,
    /// Requests a maker has.
    made: HashMap<String, Held>,
    /// Epochs the daemon decided discarded, per source (`record.epochs`): no poster ever comes
    /// from a picture that has content from one.
    discarded: HashMap<String, Vec<(u32, u32)>>,
}

impl Stills {
    pub fn new(maker: Box<dyn StillMaker>) -> Self {
        Self {
            maker,
            current: HashMap::new(),
            next_group: 0,
            next_token: 0,
            waiting: Vec::new(),
            made: HashMap::new(),
            discarded: HashMap::new(),
        }
    }

    /// `record.epochs`'s discarded ranges for `source`: a poster in the making from one of them
    /// fails `private` when it finishes, and none is made from them again.
    pub fn discard(&mut self, source: &str, ranges: &[(u32, u32)]) {
        if ranges.is_empty() {
            return;
        }
        let kept = self.discarded.entry(source.to_owned()).or_default();
        kept.extend_from_slice(ranges);
        // Bounded: the oldest go first, and nothing older than them is ever shown again anyway,
        // as a picture's epochs only grow.
        if kept.len() > MAX_DISCARDED {
            let over = kept.len() - MAX_DISCARDED;
            kept.drain(..over);
        }
    }

    /// Whether a poster may show content from `epochs`: every one decided clear, none discarded.
    fn cleared(&self, source: &str, epochs: Option<(u32, u32)>, clear: &[(u32, u32)]) -> bool {
        let Some((low, high)) = epochs else {
            return false;
        };
        let discarded = self.discarded.get(source).map_or(&[][..], Vec::as_slice);
        if discarded.iter().any(|&(a, b)| a <= high && low <= b) {
            return false;
        }
        // Every epoch in [low, high] lies in some clear range.
        let mut next = u64::from(low);
        let mut ranges = clear.to_vec();
        ranges.sort_unstable();
        for (a, b) in ranges {
            if u64::from(a) <= next && next <= u64::from(b) {
                next = u64::from(b) + 1;
            }
            if next > u64::from(high) {
                return true;
            }
        }
        false
    }

    pub fn open(&mut self, source: &str, handle: u32) {
        self.close(source, &mut Vec::new());
        let entry = Entry {
            handle,
            encode: 0,
            config: None,
            current: Current::Nothing,
            epochs: None,
        };
        self.current.insert(source.to_owned(), entry);
    }

    /// The source closed: every request for it fails now, whether waiting for a keyframe or
    /// with its maker, and a maker's result for one is dropped when it arrives.
    pub fn close(&mut self, source: &str, out: &mut Vec<Effect>) {
        if let Some(entry) = self.current.remove(source) {
            self.maker.forget(entry.handle);
        }
        let (gone, kept) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|r| r.source == source);
        self.waiting = kept;
        let mut made: Vec<String> = self
            .made
            .iter()
            .filter(|(_, held)| held.request.source == source)
            .map(|(request, _)| request.clone())
            .collect();
        made.sort();
        let made = made
            .into_iter()
            .filter_map(|request| self.made.remove(&request))
            .map(|held| held.request);
        for request in gone.into_iter().chain(made) {
            failed(out, request.request, "source-closed");
        }
    }

    /// A video unit or picture of an open source.
    pub fn frame(&mut self, source: &str, frame: &MediaFrame, out: &mut Vec<Effect>) {
        let Some(entry) = self.current.get_mut(source) else {
            return;
        };
        let key = frame.flags & FLAG_KEYFRAME != 0;
        let config = Config {
            encode: frame.encode,
            codec: frame.codec,
            size: Size {
                width: u32::from(frame.width),
                height: u32::from(frame.height),
            },
        };
        match (frame.kind, frame.codec) {
            (KIND_PICTURE, CODEC_JPEG) => {
                entry.current = jpeg(&frame.payload, config.size);
                entry.epochs = Some((frame.epoch, frame.epoch));
            }
            (KIND_VIDEO, 1..=4) if key => {
                entry.encode = frame.encode;
                if config.size.validate().is_err() {
                    entry.current = Current::Lost;
                    return;
                }
                let record = used_record(frame, config, entry.config.take());
                let mut unit = unit(frame, true, config.size);
                if let Some(record) = &record {
                    unit.description.clone_from(record);
                }
                entry.config = record.map(|record| (config, record));
                entry.epochs = Some((frame.epoch, frame.epoch));
                self.next_group += 1;
                entry.current = Current::Video {
                    group: self.next_group,
                    config,
                    units: vec![unit],
                    bytes: frame.payload.len(),
                };
                self.dispatch_waiting(source, out);
            }
            (KIND_VIDEO, 1..=4) => {
                let Current::Video {
                    config: group,
                    units,
                    bytes,
                    ..
                } = &mut entry.current
                else {
                    return;
                };
                // Another encode's deltas belong to another decoder.
                if frame.encode != group.encode {
                    return;
                }
                // A new configuration without a keyframe can't continue this group.
                if config != *group {
                    entry.current = Current::Lost;
                    return;
                }
                *bytes += frame.payload.len();
                units.push(unit(frame, false, group.size));
                entry.epochs = entry
                    .epochs
                    .map(|(low, high)| (low.min(frame.epoch), high.max(frame.epoch)));
                if units.len() > MAX_UNITS || *bytes > MAX_BYTES {
                    entry.current = Current::Lost;
                }
            }
            (KIND_VIDEO | KIND_PICTURE, _) => entry.current = Current::Unsupported,
            _ => {}
        }
    }

    /// `source.picture`: a screencast frame the daemon passes on, as the base64 JPEG text
    /// Chrome sent. Text that doesn't decode leaves the source with no picture.
    pub fn picture(&mut self, source: &str, text: &[u8], epoch: u32) {
        if let Some(entry) = self.current.get_mut(source) {
            entry.epochs = Some((epoch, epoch));
            let no_size = Size {
                width: 0,
                height: 0,
            };
            entry.current =
                super::base64::decode(text).map_or(Current::Nothing, |bytes| jpeg(&bytes, no_size));
        }
    }

    /// `still.take`.
    #[allow(clippy::too_many_arguments)]
    pub fn take(
        &mut self,
        request: Id,
        source: &Id,
        bounds: Size,
        max_pixels: u32,
        quality: u32,
        deadline_ms: u32,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        let Ok(quality) = u8::try_from(quality) else {
            return failed(out, request, "invalid");
        };
        if !(1..=100).contains(&quality) || bounds.width < 2 || bounds.height < 2 {
            return failed(out, request, "invalid");
        }
        if self.waiting.len() + self.made.len() >= MAX_PENDING
            || self.made.contains_key(request.get())
            || self.waiting.iter().any(|r| r.request == request)
        {
            return failed(out, request, "busy");
        }
        let request = Request {
            request,
            source: source.get().to_owned(),
            bounds,
            max_pixels: u64::from(max_pixels),
            make: Make::Still { quality },
            deadline_ms: now_ms.saturating_add(u64::from(deadline_ms)),
            clear: None,
        };
        self.start(request, out);
    }

    /// `still.poster`: the source's picture fitted to a viewer's viewport at 10–20 KB, answered
    /// like a still.
    pub fn poster(
        &mut self,
        request: Id,
        source: &Id,
        viewport: Size,
        deadline_ms: u32,
        clear: Vec<(u32, u32)>,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        if viewport.width < 2 || viewport.height < 2 {
            return failed(out, request, "invalid");
        }
        if self.waiting.len() + self.made.len() >= MAX_PENDING
            || self.made.contains_key(request.get())
            || self.waiting.iter().any(|r| r.request == request)
        {
            return failed(out, request, "busy");
        }
        let request = Request {
            request,
            source: source.get().to_owned(),
            bounds: viewport,
            max_pixels: u64::MAX,
            make: Make::Poster,
            deadline_ms: now_ms.saturating_add(u64::from(deadline_ms)),
            clear: Some(clear),
        };
        self.start(request, out);
    }

    /// Hands a request to the maker, or keeps it until a keyframe arrives.
    fn start(&mut self, request: Request, out: &mut Vec<Effect>) {
        if let (Some(clear), Some(entry)) = (&request.clear, self.current.get(&request.source))
            && matches!(entry.current, Current::Jpeg { .. } | Current::Video { .. })
            && !self.cleared(&request.source, entry.epochs, clear)
        {
            return failed(out, request.request, "private");
        }
        let Some(entry) = self.current.get_mut(&request.source) else {
            return failed(out, request.request, "no-source");
        };
        let epochs = entry.epochs;
        let handle = entry.handle;
        let (input, size) = match &mut entry.current {
            Current::Nothing => return failed(out, request.request, "no-picture"),
            Current::Unsupported => return failed(out, request.request, "unsupported-codec"),
            Current::Lost => {
                // One keyframe request per wait; the keyframe dispatches every waiting still.
                if !self.waiting.iter().any(|r| r.source == request.source) {
                    normal(
                        out,
                        FromMedia::SourceKeyframe {
                            source: id(&request.source),
                            encode: entry.encode,
                            reason: KeyReason::Drop,
                        },
                    );
                }
                self.waiting.push(request);
                return;
            }
            Current::Jpeg { data, size } => (
                StillInput::Jpeg {
                    data: data.clone(),
                    size: *size,
                },
                *size,
            ),
            Current::Video {
                group,
                config,
                units,
                bytes,
            } => {
                *bytes = 0;
                (
                    StillInput::Video {
                        group: *group,
                        size: config.size,
                        units: std::mem::take(units),
                    },
                    config.size,
                )
            }
        };
        let Ok(target) = fit_size_with_max_pixels(size, request.bounds, request.max_pixels) else {
            self.restore(&request.source, input);
            return failed(out, request.request, "invalid");
        };
        let group = match &input {
            StillInput::Video { group, .. } => Some(*group),
            StillInput::Jpeg { .. } => None,
        };
        self.next_token += 1;
        let token = self.next_token;
        let job = StillJob {
            request: request.request.clone(),
            token,
            stream: handle,
            input,
            target,
            make: request.make,
            deadline_us: request.deadline_ms.saturating_mul(1_000),
        };
        match self.maker.take(job) {
            Ok(()) => {
                let key = request.request.get().to_owned();
                self.made.insert(
                    key,
                    Held {
                        request,
                        token,
                        group,
                        epochs,
                    },
                );
            }
            Err(job) => {
                self.restore(&request.source, job.input);
                failed(out, request.request, "busy");
            }
        }
    }

    /// A job the maker refused gives its units back, in front of any that arrived since.
    fn restore(&mut self, source: &str, input: StillInput) {
        let StillInput::Video {
            group,
            units: mut given,
            ..
        } = input
        else {
            return;
        };
        if let Some(Entry {
            current:
                Current::Video {
                    group: now,
                    units,
                    bytes,
                    ..
                },
            ..
        }) = self.current.get_mut(source)
            && *now == group
        {
            given.append(units);
            *bytes = given.iter().map(|u| u.payload.len()).sum();
            *units = given;
        }
    }

    fn dispatch_waiting(&mut self, source: &str, out: &mut Vec<Effect>) {
        let (ready, kept) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|r| r.source == source);
        self.waiting = kept;
        for request in ready {
            self.start(request, out);
        }
    }

    /// A maker's result. Dropped when its request already failed at its deadline.
    pub fn finished(&mut self, outcome: StillOutcome, out: &mut Vec<Effect>) {
        // Only the result of the job this request is waiting on: one for an earlier request
        // with the same id (failed at close or its deadline) belongs to nothing.
        let current = self.made.get(outcome.request.get());
        if current.is_none_or(|held| held.token != outcome.token) {
            return;
        }
        let Some(held) = self.made.remove(outcome.request.get()) else {
            return;
        };
        // A poster whose epochs were discarded while it was made never goes out.
        if let Some(clear) = &held.request.clear
            && outcome.result.is_ok()
            && !self.cleared(&held.request.source, held.epochs, clear)
        {
            return failed(out, outcome.request, "private");
        }
        match outcome.result {
            Ok(made) => {
                out.push(Effect::NormalWith(
                    FromMedia::StillDone {
                        request: outcome.request,
                        width: made.size.width,
                        height: made.size.height,
                        steps: made.steps,
                    },
                    made.jpeg,
                ));
            }
            Err(reason) => {
                // The maker's decoder lost its place, or decoded the group too small: the
                // group is no use until a keyframe.
                let lost = reason == DECODE_FAILED || reason == NEEDS_KEYFRAME;
                if lost
                    && let Some(entry) = self.current.get_mut(&held.request.source)
                    && matches!(entry.current, Current::Video { group, .. } if Some(group) == held.group)
                {
                    entry.current = Current::Lost;
                }
                if reason == NEEDS_KEYFRAME {
                    return self.start(held.request, out);
                }
                failed(out, outcome.request, &reason);
            }
        }
    }

    /// The probe's findings changed: the maker may change its path.
    pub fn capabilities(&mut self, capabilities: &[Capability]) {
        self.maker.capabilities(capabilities);
    }

    /// Fails every request past its deadline.
    pub fn tick(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
        let (late, kept) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|r| r.deadline_ms <= now_ms);
        self.waiting = kept;
        for request in late {
            failed(out, request.request, "deadline");
        }
        let mut late: Vec<String> = self
            .made
            .iter()
            .filter(|(_, held)| held.request.deadline_ms <= now_ms)
            .map(|(request, _)| request.clone())
            .collect();
        late.sort();
        for request in late {
            self.made.remove(&request);
            failed(out, id(&request), "deadline");
        }
    }

    /// Shutdown: every request still waiting fails.
    pub fn finish(&mut self, out: &mut Vec<Effect>) {
        for request in std::mem::take(&mut self.waiting) {
            failed(out, request.request, "shutdown");
        }
        let mut made: Vec<String> = self.made.drain().map(|(r, _)| r).collect();
        made.sort();
        for request in made {
            failed(out, id(&request), "shutdown");
        }
    }
}

/// The configuration record a keyframe decodes with, which is what the next keyframe of the
/// same configuration without one keeps. Parameter sets in the stream win (Annex B), as
/// `record::video` decides for recordings and the maker; then the record the frame carries;
/// then the cached one, only if it belongs to this configuration.
fn used_record(
    frame: &MediaFrame,
    config: Config,
    cached: Option<(Config, Vec<u8>)>,
) -> Option<Vec<u8>> {
    let given = if frame.description.is_empty() {
        cached
            .filter(|(c, _)| *c == config)
            .map(|(_, record)| record)
    } else {
        Some(frame.description.clone())
    };
    if !matches!(frame.codec, 1 | 3) {
        return given;
    }
    let in_band = crate::record::video::encoded(frame.codec, &frame.payload, &[])
        .ok()
        .and_then(|unit| unit.description);
    in_band.or(given)
}

/// A JPEG's own size wins over the frame's; one with neither can't be fitted.
fn jpeg(data: &[u8], given: Size) -> Current {
    match media_codec::jpeg_size(data) {
        Ok(size) => Current::Jpeg {
            data: Arc::from(data),
            size,
        },
        Err(_) if given.validate().is_ok() => Current::Jpeg {
            data: Arc::from(data),
            size: given,
        },
        Err(_) => Current::Nothing,
    }
}

fn unit(frame: &MediaFrame, key: bool, size: Size) -> StillUnit {
    StillUnit {
        codec: frame.codec,
        key,
        size,
        description: frame.description.clone(),
        payload: frame.payload.clone(),
    }
}

fn failed(out: &mut Vec<Effect>, request: Id, reason: &str) {
    normal(
        out,
        FromMedia::StillFailed {
            request,
            reason: reason.into(),
        },
    );
}

fn id(value: &str) -> Id {
    Id::new(value.to_owned()).unwrap_or_else(|_| unreachable!())
}
