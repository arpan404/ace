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
use media_wire::control::{FromMedia, Id, KeyReason, SourceStep};
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
    /// The source's handle, unique in this process: the maker keeps decoder state by it.
    pub stream: u32,
    pub input: StillInput,
    /// The size to make, already fitted to the request's box and pixel budget.
    pub target: Size,
    pub quality: u8,
    /// On ace-media's monotonic clock, in µs.
    pub deadline_us: u64,
}

/// What a maker made.
pub struct Made {
    pub jpeg: Vec<u8>,
    pub size: Size,
    pub steps: Vec<SourceStep>,
}

pub struct StillOutcome {
    pub request: Id,
    pub result: Result<Made, String>,
}

/// Runs still jobs off the engine's thread. Jobs of one stream must be made in the order they
/// are taken, because each continues the decoder state of the one before.
pub trait StillMaker: Send {
    /// Queues a job. A full queue hands it back.
    fn take(&mut self, job: StillJob) -> Result<(), StillJob>;
    /// The source closed: drop its decoder state.
    fn forget(&mut self, stream: u32);
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
    /// The encode id of the latest video unit: what a keyframe request names.
    encode: u32,
    /// The latest configuration record: a producer sends it only when it changes, so a
    /// keyframe without one keeps the one before.
    description: Vec<u8>,
    current: Current,
}

enum Current {
    Nothing,
    Jpeg {
        data: Arc<[u8]>,
        size: Size,
    },
    Video {
        group: u64,
        size: Size,
        units: Vec<StillUnit>,
        bytes: usize,
    },
    /// The group was dropped: a still needs the next keyframe.
    Lost,
    /// A codec stills don't take (VP8, VP9, PNG).
    Unsupported,
}

struct Request {
    request: Id,
    source: String,
    bounds: Size,
    max_pixels: u64,
    quality: u8,
    deadline_ms: u64,
}

struct Held {
    request: Request,
    /// The video group the job continued, if any.
    group: Option<u64>,
}

pub struct Stills {
    maker: Box<dyn StillMaker>,
    current: HashMap<String, Entry>,
    next_group: u64,
    /// Requests waiting for a keyframe.
    waiting: Vec<Request>,
    /// Requests a maker has.
    made: HashMap<String, Held>,
}

impl Stills {
    pub fn new(maker: Box<dyn StillMaker>) -> Self {
        Self {
            maker,
            current: HashMap::new(),
            next_group: 0,
            waiting: Vec::new(),
            made: HashMap::new(),
        }
    }

    pub fn open(&mut self, source: &str, handle: u32) {
        self.close(source, &mut Vec::new());
        let entry = Entry {
            handle,
            encode: 0,
            description: Vec::new(),
            current: Current::Nothing,
        };
        self.current.insert(source.to_owned(), entry);
    }

    /// The source closed: its waiting requests fail, and its maker state goes.
    pub fn close(&mut self, source: &str, out: &mut Vec<Effect>) {
        if let Some(entry) = self.current.remove(source) {
            self.maker.forget(entry.handle);
        }
        let (gone, kept) = std::mem::take(&mut self.waiting)
            .into_iter()
            .partition(|r| r.source == source);
        self.waiting = kept;
        for request in gone {
            failed(out, request.request, "source-closed");
        }
    }

    /// A video unit or picture of an open source.
    pub fn frame(&mut self, source: &str, frame: &MediaFrame, out: &mut Vec<Effect>) {
        let Some(entry) = self.current.get_mut(source) else {
            return;
        };
        if frame.kind == KIND_VIDEO {
            entry.encode = frame.encode;
            if !frame.description.is_empty() {
                entry.description.clone_from(&frame.description);
            }
        }
        let current = &mut entry.current;
        let key = frame.flags & FLAG_KEYFRAME != 0;
        let size = Size {
            width: u32::from(frame.width),
            height: u32::from(frame.height),
        };
        match (frame.kind, frame.codec) {
            (KIND_PICTURE, CODEC_JPEG) => *current = jpeg(&frame.payload, size),
            (KIND_VIDEO, 1..=4) if key => {
                if size.validate().is_err() {
                    *current = Current::Lost;
                    return;
                }
                self.next_group += 1;
                let mut key = unit(frame, true, size);
                key.description.clone_from(&entry.description);
                *current = Current::Video {
                    group: self.next_group,
                    size,
                    units: vec![key],
                    bytes: frame.payload.len(),
                };
                self.dispatch_waiting(source, out);
            }
            (KIND_VIDEO, 1..=4) => {
                if let Current::Video {
                    size, units, bytes, ..
                } = current
                {
                    *bytes += frame.payload.len();
                    units.push(unit(frame, false, *size));
                    if units.len() > MAX_UNITS || *bytes > MAX_BYTES {
                        *current = Current::Lost;
                    }
                }
            }
            (KIND_VIDEO | KIND_PICTURE, _) => *current = Current::Unsupported,
            _ => {}
        }
    }

    /// `source.picture`: a JPEG the daemon passes on.
    pub fn picture(&mut self, source: &str, jpeg_bytes: &[u8]) {
        if let Some(entry) = self.current.get_mut(source) {
            entry.current = jpeg(
                jpeg_bytes,
                Size {
                    width: 0,
                    height: 0,
                },
            );
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
            quality,
            deadline_ms: now_ms.saturating_add(u64::from(deadline_ms)),
        };
        self.start(request, out);
    }

    /// Hands a request to the maker, or keeps it until a keyframe arrives.
    fn start(&mut self, request: Request, out: &mut Vec<Effect>) {
        let Some(entry) = self.current.get_mut(&request.source) else {
            return failed(out, request.request, "no-source");
        };
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
                size,
                units,
                bytes,
            } => {
                *bytes = 0;
                (
                    StillInput::Video {
                        group: *group,
                        size: *size,
                        units: std::mem::take(units),
                    },
                    *size,
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
        let job = StillJob {
            request: request.request.clone(),
            stream: handle,
            input,
            target,
            quality: request.quality,
            deadline_us: request.deadline_ms.saturating_mul(1_000),
        };
        match self.maker.take(job) {
            Ok(()) => {
                let key = request.request.get().to_owned();
                self.made.insert(key, Held { request, group });
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
        let Some(held) = self.made.remove(outcome.request.get()) else {
            return;
        };
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
