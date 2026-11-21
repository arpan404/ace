// SPDX-License-Identifier: Apache-2.0
//! Sources, their ingest connections, epochs and recordings (docs/media/plan.md, "Ingest
//! framing" and "Recording privacy barrier"). Pure: `now` is ace-media's monotonic
//! milliseconds, which only bound how long the barrier holds frames.
use super::egress::{EgressSink, SourceEgress};
use super::recorder::{RecordSpec, Recorder, Recorders, Started};
use super::{Effect, EncodeEffect, Now, log, normal, priority};
use crate::secret::{SecretId, Vault};
use media_core::privacy::{Barrier, Decision, Event, Frame, Limits, ReadStamper, Track};
use media_wire::capability::Acceleration;
use media_wire::control::{
    EncodeSpec, FromMedia, Id, KeyReason, Level, Origin, Part, Sequence, Status,
};
use media_wire::frame::MediaFrame;
use std::collections::{HashMap, HashSet, VecDeque};

/// An ingest connection, named by the shell.
pub type IngestId = u64;

pub const KIND_VIDEO: u8 = 1;
pub const KIND_AUDIO: u8 = 2;
pub const KIND_PICTURE: u8 = 3;
pub const KIND_END: u8 = 4;
pub const KIND_HELLO: u8 = 5;
const FLAG_KEYFRAME: u32 = 1;
/// Sources open at once, and handles remembered (handles are never reused in one process).
/// A `source.open` past either limit ends at once with the limit as its reason.
pub const MAX_SOURCES: usize = 256;
pub const MAX_HANDLES: usize = 65_536;
const CODEC_JPEG: u8 = 7;
/// `record.meta` messages waiting for their epoch's decision; past this the oldest are dropped.
pub const MAX_PENDING_META: usize = 1_024;
/// Decisions kept for a source that isn't recording yet, and sources they are kept for.
pub const MAX_EARLY_DECISIONS: usize = 64;
/// Ended recordings remembered, so their late decisions are dropped rather than kept.
pub const MAX_ENDED_RECORDINGS: usize = 4_096;

/// A frame with when it was captured on ace-media's clock: its arrival less the producer's age.
pub struct Timed {
    frame: MediaFrame,
    captured_us: u64,
}

struct Meta {
    epoch: u32,
    at_us: u64,
    data: serde_json::Value,
}

struct Recording {
    id: Id,
    directory: String,
    barrier: Barrier<Timed>,
    recorder: Box<dyn Recorder>,
    /// Pointer and lease changes, written only once their epoch is decided clear.
    meta: VecDeque<Meta>,
    /// Parts already sent as `record.part`.
    reported: HashSet<u32>,
}

impl Recording {
    fn report(&mut self, out: &mut Vec<Effect>, closed: Vec<Part>) {
        for part in &closed {
            self.reported.insert(part.index);
        }
        parts(out, &self.id, closed);
    }
}

struct Source {
    id: Id,
    /// The daemon's handle for this source: what egress frames carry.
    handle: u32,
    egress: SourceEgress,
    /// The ingest token, until a producer presents it.
    token: Option<SecretId>,
    /// ace-media is this source's producer (pictures, simulators, scrcpy, emulator frames), so
    /// it stamps epochs itself.
    stamper: Option<ReadStamper>,
    epoch: u32,
    status: Status,
    drops: u32,
    ingest: Option<IngestId>,
    encode: u32,
    recording: Option<Recording>,
    /// A JPEG source ace-media encodes itself (`tab-pictures`, `user-tab`), and the token of
    /// its running encoder: every command to that encoder and every word from it carries the
    /// token, so a reopened source never takes an earlier encoder's output.
    pictures: bool,
    encoder: Option<u64>,
    /// Frames taken from the producer's connection since its hello.
    received: u64,
    /// `source.sync` barriers not yet answered: seq, frames, the epoch to be decided.
    syncs: Vec<(Sequence, u64, u32)>,
}

/// Barriers one source keeps waiting; an older one beyond this is dropped (its asker times out).
const MAX_SYNCS: usize = 8;

#[derive(Default)]
pub struct Sources {
    /// The daemon agreed to `source.ingest`: a bound hello is reported.
    pub(crate) report_ingest: bool,
    by_id: HashMap<String, Source>,
    /// Every handle this process was given: handles are never reused while it lives.
    handles: HashSet<u32>,
    bindings: HashMap<IngestId, String>,
    events: Vec<Event<Timed>>,
    /// `record.epochs` that overtook their `record.start` (or `source.open`): the priority lane
    /// is read first, so a recording's first decisions can arrive before it exists.
    early: HashMap<String, Vec<Decision>>,
    /// Recordings that ended in this process, newest last: their late decisions are dropped.
    ended: EndedRecordings,
    /// Closed JPEG sources whose encoder is still handing over its last output, with when they
    /// give up (`DRAIN_MS` after the close).
    draining: HashMap<String, (Source, u64)>,
    /// The last encoder token given out (tokens are never reused in one process).
    last_token: u64,
    /// Encoder threads the shell has seen outlive their deadline: they hold a source and an
    /// encoder slot until they exit.
    stuck: usize,
}

/// Picture encoders running at once (live, draining and stuck ones), each a thread of its own.
pub const MAX_ENCODERS: usize = 32;

/// Longest a closed JPEG source waits for its encoder to drain before it ends interrupted.
pub const DRAIN_MS: u64 = 2_000;

/// A bounded memory of ended recording ids.
#[derive(Default)]
struct EndedRecordings {
    order: VecDeque<String>,
    set: HashSet<String>,
}

impl EndedRecordings {
    fn insert(&mut self, id: &str) {
        if !self.set.insert(id.to_owned()) {
            return;
        }
        self.order.push_back(id.to_owned());
        if self.order.len() > MAX_ENDED_RECORDINGS
            && let Some(old) = self.order.pop_front()
        {
            self.set.remove(&old);
        }
    }

    fn contains(&self, id: &str) -> bool {
        self.set.contains(id)
    }
}

fn status(
    out: &mut Vec<Effect>,
    source: &Id,
    status: Status,
    reason: Option<&str>,
    attempts: Option<u32>,
) {
    report(out, source, status, reason, attempts, None);
}

fn report(
    out: &mut Vec<Effect>,
    source: &Id,
    status: Status,
    reason: Option<&str>,
    attempts: Option<u32>,
    acceleration: Option<Acceleration>,
) {
    normal(
        out,
        FromMedia::SourceStatus {
            source: source.clone(),
            status,
            reason: reason.map(Into::into),
            attempts,
            acceleration,
        },
    );
}

fn sequence(value: u64) -> Sequence {
    // Counters of one process stay far below 2^53.
    Sequence::new(value.min(9_007_199_254_740_991)).unwrap_or_else(|_| unreachable!())
}

impl Sources {
    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open(
        &mut self,
        id: &Id,
        handle: u32,
        epoch: u32,
        origin: &Origin,
        token: &[u8],
        vault: &mut Vault,
        now: u64,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        if self.handles.contains(&handle) {
            log(out, Level::Warn, "source handle reused", id);
            return status(out, id, Status::Ended, Some("handle-reused"), None);
        }
        self.close(id.get(), vault, now, egress, out);
        self.drained(id.get(), None, true, egress, out);
        let held = self.by_id.len() + self.draining.len() + self.stuck;
        if held >= MAX_SOURCES || self.handles.len() >= MAX_HANDLES {
            log(out, Level::Warn, "source.open refused: source limit", id);
            return status(out, id, Status::Ended, Some("source-limit"), None);
        }
        self.handles.insert(handle);
        let Some(secret) = vault.store(token) else {
            return status(out, id, Status::Ended, Some("too-many-sources"), None);
        };
        let pictures = matches!(origin, Origin::TabPictures {} | Origin::UserTab {});
        // An emulator's frame file is encoded by the screen helper's `--encode-frames`, and an
        // Android device's scrcpy stream is forwarded by the daemon, which keeps its sockets: both
        // stream in over ingest like any producer and stamp their own epochs. A Simulator's
        // serve-sim stream is read here.
        let reads_itself = pictures || matches!(origin, Origin::Simulator { .. });
        let mut stamper = reads_itself.then(|| ReadStamper::new(epoch));
        if let Some(stamper) = &mut stamper {
            stamper.apply(epoch, false, now);
        }
        self.by_id.insert(
            id.get().to_owned(),
            Source {
                id: id.clone(),
                handle,
                egress: SourceEgress::default(),
                token: Some(secret),
                stamper,
                epoch,
                status: Status::Starting,
                drops: 0,
                ingest: None,
                encode: 0,
                recording: None,
                pictures,
                encoder: None,
                received: 0,
                syncs: Vec::new(),
            },
        );
        status(out, id, Status::Starting, None, None);
        // A Simulator's serve-sim stream is read here, by a reader under an encoder token.
        if let Origin::Simulator { stream_url, .. } = origin {
            self.read(id, stream_url, out);
        }
    }

    /// Starts the reader of a source ace-media reads itself.
    fn read(&mut self, id: &Id, url: &str, out: &mut Vec<Effect>) {
        if self.encoders() >= MAX_ENCODERS {
            if let Some(source) = self.by_id.get_mut(id.get()) {
                source.status = Status::Ended;
            }
            log(out, Level::Warn, "source.open refused: encoder limit", id);
            return status(out, id, Status::Ended, Some("encoder-limit"), None);
        }
        self.last_token += 1;
        let token = self.last_token;
        if let Some(source) = self.by_id.get_mut(id.get()) {
            source.encoder = Some(token);
        }
        out.push(Effect::Encode(EncodeEffect::Read {
            source: id.get().to_owned(),
            token,
            url: url.to_owned(),
        }));
    }

    /// The handle of an open source.
    pub fn handle(&self, id: &str) -> Option<u32> {
        self.by_id.get(id).map(|s| s.handle)
    }

    /// The source an admitted ingest connection feeds.
    /// Whether `token` is `id`'s live encoder (a draining one's output still reaches egress,
    /// but viewers have moved on).
    pub fn encoder_is(&self, id: &str, token: u64) -> bool {
        self.by_id.get(id).is_some_and(|s| s.encoder == Some(token))
    }

    pub fn bound(&self, conn: IngestId) -> Option<&str> {
        self.bindings.get(&conn).map(String::as_str)
    }

    /// `source.close`.
    pub fn close_source(
        &mut self,
        id: &str,
        vault: &mut Vault,
        now: u64,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        self.close(id, vault, now, egress, out);
    }

    /// Closes a source. A producer still streaming into it ends with a marker; a JPEG source
    /// that encodes keeps delivering until its encoder has drained (`encoder_drained`), and
    /// only then ends with a clean marker.
    pub fn close(
        &mut self,
        id: &str,
        vault: &mut Vault,
        now: u64,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        let Some(mut source) = self.by_id.remove(id) else {
            return;
        };
        if let Some(token) = source.token.take() {
            vault.erase(token);
        }
        if let Some(conn) = source.ingest.take() {
            self.bindings.remove(&conn);
            out.push(Effect::CloseIngest(conn));
            source.egress.end(source.handle, false, egress);
        }
        if let Some(recording) = source.recording.take() {
            finish(recording, &mut self.ended, out);
        }
        if let Some(token) = source.encoder {
            // Pictures already handed over may still come out: wait for the encoder's word.
            out.push(Effect::Encode(EncodeEffect::Drain {
                source: id.to_owned(),
                token,
            }));
            self.draining
                .insert(id.to_owned(), (source, now.saturating_add(DRAIN_MS)));
        }
    }

    /// A closed JPEG source is done: its encoder drained (`interrupted` false), or couldn't, or
    /// ran out of time. Its marker goes after its last unit, and its encoder thread ends.
    /// With `token`, only that encoder's drain: an earlier encoder's word ends nothing.
    fn drained(
        &mut self,
        id: &str,
        token: Option<u64>,
        interrupted: bool,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        let current = self.draining.get(id).and_then(|(s, _)| s.encoder);
        if current.is_none() || (token.is_some() && token != current) {
            return;
        }
        let Some((mut source, _)) = self.draining.remove(id) else {
            return;
        };
        source.egress.end(source.handle, interrupted, egress);
        out.push(Effect::Encode(EncodeEffect::Close {
            source: id.to_owned(),
            token: current.unwrap_or_default(),
        }));
    }

    /// The shell's count of encoder threads that outlived their deadline.
    pub fn encoders_stuck(&mut self, stuck: usize) {
        self.stuck = stuck;
    }

    fn encoders(&self) -> usize {
        self.by_id.values().filter(|s| s.encoder.is_some()).count()
            + self.draining.len()
            + self.stuck
    }

    /// The encoder of a closed JPEG source handed over its last output.
    pub fn encoder_drained(
        &mut self,
        id: &str,
        token: u64,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        self.drained(id, Some(token), false, egress, out);
    }

    /// `source.encodes`: the encodes ace-media runs for a JPEG source while the daemon plans
    /// them. Only JPEG sources take them; an empty list stops the encoder.
    pub fn encodes(&mut self, id: &Id, encodes: Vec<EncodeSpec>, out: &mut Vec<Effect>) {
        let running = self.encoders();
        let Some(source) = self.by_id.get_mut(id.get()) else {
            return log(
                out,
                Level::Debug,
                "source.encodes for an unknown source",
                id,
            );
        };
        // A source ace-media reads itself (a Simulator) re-encodes for the viewer in its reader,
        // under the reader's own token; no encodes means passing its stream through.
        if !source.pictures
            && source.stamper.is_some()
            && let Some(token) = source.encoder
            && !matches!(source.status, Status::Ended)
        {
            return out.push(Effect::Encode(EncodeEffect::Configure {
                source: id.get().to_owned(),
                token,
                encodes,
            }));
        }
        if !source.pictures || matches!(source.status, Status::Ended) {
            return log(
                out,
                Level::Warn,
                "source.encodes for a source ace-media doesn't encode",
                id,
            );
        }
        let token = if encodes.is_empty() {
            // Stops the encoder, if one runs.
            let Some(token) = source.encoder.take() else {
                return;
            };
            token
        } else if let Some(token) = source.encoder {
            token
        } else {
            if running >= MAX_ENCODERS {
                source.status = Status::Ended;
                log(
                    out,
                    Level::Warn,
                    "source.encodes refused: encoder limit",
                    id,
                );
                return status(out, id, Status::Ended, Some("encoder-limit"), None);
            }
            self.last_token += 1;
            source.encoder = Some(self.last_token);
            self.last_token
        };
        out.push(Effect::Encode(EncodeEffect::Configure {
            source: id.get().to_owned(),
            token,
            encodes,
        }));
    }

    /// `source.key`: the encode's next unit is a keyframe.
    pub fn key(&mut self, id: &Id, encode: u32, out: &mut Vec<Effect>) {
        if let Some(token) = self.by_id.get(id.get()).and_then(|s| s.encoder) {
            out.push(Effect::Encode(EncodeEffect::Key {
                source: id.get().to_owned(),
                token,
                encode,
            }));
        }
    }

    /// A unit the source's encoder finished: it goes where an ingested unit goes.
    #[allow(clippy::too_many_arguments)]
    pub fn encoded(
        &mut self,
        id: &str,
        token: u64,
        frame: MediaFrame,
        now: Now,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        if let Some(source) = self.by_id.get(id).filter(|s| s.encoder == Some(token)) {
            let mut frame = frame;
            // A reader's units are stamped as they are read; an encoder's carry their picture's.
            if !source.pictures
                && let Some(stamper) = &source.stamper
            {
                frame.epoch = stamper.stamp(now.mono_ms);
            }
            self.unit(id, frame, now, egress, out);
        } else if let Some((source, _)) = self
            .draining
            .get_mut(id)
            .filter(|(s, _)| s.encoder == Some(token))
        {
            source
                .egress
                .unit(&source.id, source.handle, &frame, egress, out);
        }
    }

    pub fn encoder_steps(
        &mut self,
        id: &str,
        token: u64,
        acceleration: Acceleration,
        out: &mut Vec<Effect>,
    ) {
        let Some(source) = self.by_id.get(id).filter(|s| s.encoder == Some(token)) else {
            return;
        };
        report(
            out,
            &source.id,
            source.status.clone(),
            None,
            None,
            Some(acceleration),
        );
    }

    pub fn encoder_failed(
        &mut self,
        id: &str,
        token: u64,
        reason: &str,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        if self
            .draining
            .get(id)
            .is_some_and(|(s, _)| s.encoder == Some(token))
        {
            return self.drained(id, Some(token), true, egress, out);
        }
        let Some(source) = self.by_id.get_mut(id).filter(|s| s.encoder == Some(token)) else {
            return;
        };
        source.encoder = None;
        source.egress.end(source.handle, true, egress);
        source.status = Status::Ended;
        status(out, &source.id, Status::Ended, Some(reason), None);
        out.push(Effect::Encode(EncodeEffect::Close {
            source: id.to_owned(),
            token,
        }));
    }

    /// `source.egress`: whether this source's units also go back to the daemon.
    pub fn egress(&mut self, id: &Id, on: bool, out: &mut Vec<Effect>) {
        match self.by_id.get_mut(id.get()) {
            Some(source) => source.egress.set(on),
            None => log(out, Level::Debug, "source.egress for an unknown source", id),
        }
    }

    /// `source.picture`: a screencast frame the daemon passes on, read by ace-media as producer.
    #[allow(clippy::too_many_arguments)]
    pub fn picture(
        &mut self,
        id: &str,
        epoch: u32,
        age_ms: u32,
        payload: Vec<u8>,
        now: Now,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        let Some(source) = self.by_id.get(id) else {
            return;
        };
        // The stricter of the two stamps: a lower epoch is never released by a later decision.
        let stamped = source
            .stamper
            .as_ref()
            .map_or(epoch, |s| s.stamp(now.mono_ms).min(epoch));
        if let Some(token) = source.encoder {
            out.push(Effect::Encode(EncodeEffect::Picture {
                source: id.to_owned(),
                token,
                text: payload,
                epoch: stamped,
                age_us: age_ms.saturating_mul(1000),
            }));
            return;
        }
        let frame = MediaFrame {
            kind: KIND_PICTURE,
            flags: FLAG_KEYFRAME,
            age_us: 0,
            width: 0,
            height: 0,
            display_width: 0,
            display_height: 0,
            scale: 1000,
            rotation: 0,
            codec: CODEC_JPEG,
            encode: 0,
            epoch: stamped,
            codec_string: String::new(),
            description: Vec::new(),
            extension: Vec::new(),
            payload,
        };
        self.unit(id, frame, now, egress, out);
    }

    /// `source.epoch`, for sources ace-media produces: stamp `epoch` from now on, then
    /// acknowledge it.
    pub fn epoch(
        &mut self,
        id: &Id,
        seq: &Sequence,
        epoch: u32,
        follows_private: bool,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        let Some(source) = self.by_id.get_mut(id.get()) else {
            return;
        };
        let stamper = source
            .stamper
            .get_or_insert_with(|| ReadStamper::new(epoch));
        stamper.apply(epoch, follows_private, now);
        source.epoch = source.epoch.max(epoch);
        if let Some(recording) = &mut source.recording {
            recording.barrier.issued(epoch);
        }
        priority(
            out,
            FromMedia::EpochApplied {
                source: id.clone(),
                seq: seq.clone(),
                epoch,
            },
        );
    }

    /// `record.epochs`: the daemon's decisions for one recording, applied in `seq` order by its
    /// barrier. Decisions name their recording, so a stopped recording's stragglers never reach
    /// the next one on the same source. Ones for a recording that hasn't started yet are kept
    /// for it; ones for a recording that ended are dropped. Every one is answered.
    pub fn decide(
        &mut self,
        id: &Id,
        recording: &Id,
        decision: Decision,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        let live = self
            .by_id
            .get_mut(id.get())
            .and_then(|s| s.recording.as_mut())
            .filter(|r| r.id == *recording);
        if let Some(live) = live {
            live.barrier.decide(decision, now, &mut self.events);
            self.release(id.get(), out);
            return self.synced(id.get(), out);
        }
        let key = recording.get();
        let running = self
            .by_id
            .values()
            .any(|s| s.recording.as_ref().is_some_and(|r| r.id == *recording));
        let keep = !running
            && !self.ended.contains(key)
            && (self.early.len() < MAX_SOURCES || self.early.contains_key(key));
        if keep {
            let kept = self.early.entry(key.to_owned()).or_default();
            if kept.len() < MAX_EARLY_DECISIONS {
                kept.push(decision.clone());
            }
        }
        priority(
            out,
            FromMedia::EpochsApplied {
                source: id.clone(),
                seq: sequence(decision.seq),
                written: sequence(0),
                dropped: sequence(0),
            },
        );
    }

    /// A frame from an ingest connection. The first must be a hello with an unused token of an
    /// open source; anything else closes the connection.
    pub fn ingest(
        &mut self,
        conn: IngestId,
        frame: MediaFrame,
        now: Now,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        let Some(id) = self.bindings.get(&conn).cloned() else {
            return out.push(Effect::CloseIngest(conn));
        };
        match frame.kind {
            KIND_VIDEO | KIND_AUDIO | KIND_PICTURE => {
                self.unit(&id, frame, now, egress, out);
                if let Some(source) = self.by_id.get_mut(&id) {
                    source.received += 1;
                }
                self.synced(&id, out);
            }
            KIND_END => {
                self.bindings.remove(&conn);
                out.push(Effect::CloseIngest(conn));
                if let Some(source) = self.by_id.get_mut(&id) {
                    source.ingest = None;
                    source.status = Status::Ended;
                    source.egress.end(source.handle, false, egress);
                    status(out, &source.id, Status::Ended, None, None);
                }
            }
            _ => self.unbind(conn, now.mono_ms, egress, out),
        }
    }

    /// A connection's hello: binds it to the open source whose unused token it presents. The
    /// token is single use. False when no source matches; the shell then closes it.
    pub fn hello(
        &mut self,
        conn: IngestId,
        token: &[u8],
        vault: &mut Vault,
        out: &mut Vec<Effect>,
    ) -> bool {
        let candidates = self
            .by_id
            .iter()
            .filter_map(|(key, s)| s.token.map(|t| (key.as_str(), t)));
        let found = vault.find(candidates, token).map(str::to_owned);
        let source = found.as_ref().and_then(|key| self.by_id.get_mut(key));
        let Some(source) = source else {
            out.push(Effect::CloseIngest(conn));
            return false;
        };
        if let Some(token) = source.token.take() {
            vault.erase(token);
        }
        source.ingest = Some(conn);
        source.received = 0;
        self.bindings.insert(conn, source.id.get().to_owned());
        if self.report_ingest {
            normal(
                out,
                FromMedia::SourceIngest {
                    source: source.id.clone(),
                },
            );
        }
        true
    }

    /// `source.sync`: answered once the source has taken `frames` frames from its producer and
    /// its recording decided `decided` (at once, if both already hold).
    pub fn sync(
        &mut self,
        id: &Id,
        seq: Sequence,
        frames: u64,
        decided: u32,
        out: &mut Vec<Effect>,
    ) {
        let Some(source) = self.by_id.get_mut(id.get()) else {
            return;
        };
        if source.syncs.len() >= MAX_SYNCS {
            source.syncs.remove(0);
        }
        source.syncs.push((seq, frames, decided));
        self.synced(id.get(), out);
    }

    /// Answers every barrier of `id` that now holds.
    fn synced(&mut self, id: &str, out: &mut Vec<Effect>) {
        let Some(source) = self.by_id.get_mut(id) else {
            return;
        };
        if source.syncs.is_empty() {
            return;
        }
        let received = source.received;
        let recording = source.recording.as_ref();
        let (held, waiting): (Vec<_>, Vec<_>) =
            source.syncs.drain(..).partition(|(_, frames, decided)| {
                // Every counted frame settled: decided, and none held (clear audio waiting on
                // a video fragment is neither written nor dropped yet).
                received >= *frames
                    && recording.is_none_or(|r| {
                        r.barrier.decided(*decided).is_some() && r.barrier.held() == 0
                    })
            });
        source.syncs = waiting;
        for (seq, _, _) in held {
            normal(
                out,
                FromMedia::SourceSynced {
                    source: source.id.clone(),
                    seq,
                },
            );
        }
    }

    /// The producer's connection ended without an end-of-source frame.
    pub fn ingest_closed(
        &mut self,
        conn: IngestId,
        now: u64,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        let Some(id) = self.bindings.remove(&conn) else {
            return;
        };
        let Some(source) = self.by_id.get_mut(&id) else {
            return;
        };
        source.ingest = None;
        source.egress.end(source.handle, true, egress);
        source.drops += 1;
        source.status = Status::Retrying;
        status(
            out,
            &source.id,
            Status::Retrying,
            Some("producer-closed"),
            Some(source.drops),
        );
        if let Some(recording) = &mut source.recording {
            recording.barrier.interrupt(now, &mut self.events);
        }
        self.release(&id, out);
    }

    fn unbind(
        &mut self,
        conn: IngestId,
        now: u64,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        out.push(Effect::CloseIngest(conn));
        self.ingest_closed(conn, now, egress, out);
    }

    fn unit(
        &mut self,
        id: &str,
        frame: MediaFrame,
        now: Now,
        egress: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        let Some(source) = self.by_id.get_mut(id) else {
            return;
        };
        if !matches!(source.status, Status::Playing) {
            source.status = Status::Playing;
            status(out, &source.id, Status::Playing, None, None);
        }
        if frame.kind != KIND_AUDIO {
            source.encode = frame.encode;
        }
        source
            .egress
            .unit(&source.id, source.handle, &frame, egress, out);
        let Some(recording) = &mut source.recording else {
            return;
        };
        let barrier_frame = Frame {
            track: if frame.kind == KIND_AUDIO {
                Track::Audio
            } else {
                Track::Video
            },
            epoch: frame.epoch,
            keyframe: frame.flags & FLAG_KEYFRAME != 0,
            bytes: frame.payload.len(),
            payload: Timed {
                captured_us: now.mono_us.saturating_sub(u64::from(frame.age_us)),
                frame,
            },
        };
        recording
            .barrier
            .frame(barrier_frame, now.mono_ms, &mut self.events);
        self.release(id, out);
    }

    /// Hands what the barrier released to the recorder and the daemon, then the metadata whose
    /// epochs are now decided. A recorder error ends the recording with `record.failed`.
    fn release(&mut self, id: &str, out: &mut Vec<Effect>) {
        let Some(source) = self.by_id.get_mut(id) else {
            self.events.clear();
            return;
        };
        let mut closed = Vec::new();
        let mut failure = None;
        for event in self.events.drain(..) {
            let Some(recording) = &mut source.recording else {
                continue;
            };
            let written = match event {
                Event::Write(frame) => {
                    let Timed { frame, captured_us } = frame.payload;
                    if failure.is_some() {
                        continue;
                    }
                    recording.recorder.write(&frame, captured_us, &mut closed)
                }
                Event::Drop(..) => Ok(()),
                Event::Gap if failure.is_none() => recording.recorder.gap(&mut closed),
                Event::Gap => Ok(()),
                Event::Keyframe => {
                    normal(
                        out,
                        FromMedia::SourceKeyframe {
                            source: source.id.clone(),
                            encode: source.encode,
                            reason: KeyReason::Resume,
                        },
                    );
                    Ok(())
                }
                Event::Applied {
                    seq,
                    written,
                    dropped,
                } => {
                    priority(
                        out,
                        FromMedia::EpochsApplied {
                            source: source.id.clone(),
                            seq: sequence(seq),
                            written: sequence(written),
                            dropped: sequence(dropped),
                        },
                    );
                    Ok(())
                }
            };
            if let Err(reason) = written {
                failure.get_or_insert(reason);
            }
        }
        if failure.is_none()
            && let Some(recording) = &mut source.recording
            && let Err(reason) = flush_meta(recording)
        {
            failure = Some(reason);
        }
        let Some(recording) = &mut source.recording else {
            return;
        };
        recording.report(out, closed);
        if let Some(reason) = failure {
            let recording = source.recording.take();
            if let Some(recording) = recording {
                self.ended.insert(recording.id.get());
                // Close what was written and report every part not yet reported; the
                // recording itself has failed.
                let reported = recording.reported;
                if let Ok(all) = recording.recorder.finish() {
                    let unreported = all
                        .into_iter()
                        .filter(|p| !reported.contains(&p.index))
                        .collect();
                    parts(out, &recording.id, unreported);
                }
                normal(
                    out,
                    FromMedia::RecordFailed {
                        recording: recording.id,
                        reason,
                    },
                );
            }
        }
    }

    pub fn record_start(
        &mut self,
        spec: &RecordSpec<'_>,
        recording: &Id,
        recorders: &mut dyn Recorders,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        let early = self.early.remove(recording.get()).unwrap_or_default();
        let fail = |out: &mut Vec<Effect>, reason: &str| {
            normal(
                out,
                FromMedia::RecordFailed {
                    recording: recording.clone(),
                    reason: reason.into(),
                },
            )
        };
        let clash = self
            .by_id
            .values()
            .filter_map(|s| s.recording.as_ref())
            .find_map(|r| {
                if r.id == *recording {
                    Some("recording-exists")
                } else if r.directory == spec.directory {
                    Some("directory-in-use")
                } else {
                    None
                }
            });
        if let Some(reason) = clash {
            return fail(out, reason);
        }
        let Some(source) = self.by_id.get_mut(spec.source) else {
            return fail(out, "unknown-source");
        };
        if source.recording.is_some() {
            return fail(out, "already-recording");
        }
        match recorders.start(spec) {
            Err(reason) => fail(out, &reason),
            Ok(Started {
                recorder,
                recovered,
            }) => {
                let reported = recovered.iter().map(|p| p.index).collect();
                parts(out, recording, recovered);
                let mut barrier = Barrier::new(source.epoch, Limits::default());
                if source.stamper.is_some() {
                    barrier.issued(source.epoch);
                }
                // Decisions that overtook this record.start: they name this recording, so
                // all are its own, and the barrier orders them. They were answered already.
                let mut applied = Vec::new();
                for decision in early {
                    barrier.decide(decision, now, &mut applied);
                }
                self.events.extend(
                    applied
                        .into_iter()
                        .filter(|e| !matches!(e, Event::Applied { .. })),
                );
                source.recording = Some(Recording {
                    id: recording.clone(),
                    directory: spec.directory.to_owned(),
                    reported,
                    barrier,
                    recorder,
                    meta: VecDeque::new(),
                });
                let source = spec.source.to_owned();
                self.release(&source, out);
            }
        }
    }

    fn recording_mut(&mut self, recording: &str) -> Option<&mut Recording> {
        self.by_id
            .values_mut()
            .filter_map(|s| s.recording.as_mut())
            .find(|r| r.id.get() == recording)
    }

    pub fn record_cut(&mut self, recording: &str) {
        if let Some(r) = self.recording_mut(recording) {
            r.recorder.cut();
        }
    }

    /// `record.meta`: kept until the barrier decides its epoch, then written (clear) or
    /// dropped (discarded), so a pointer never outlives the privacy of its moment.
    pub fn record_meta(
        &mut self,
        recording: &str,
        epoch: u32,
        data: serde_json::Value,
        now: Now,
        out: &mut Vec<Effect>,
    ) {
        let found = self.by_id.iter_mut().find(|(_, s)| {
            s.recording
                .as_ref()
                .is_some_and(|r| r.id.get() == recording)
        });
        let Some((key, source)) = found else {
            return;
        };
        let key = key.clone();
        if let Some(r) = &mut source.recording {
            if r.meta.len() >= MAX_PENDING_META {
                r.meta.pop_front();
            }
            r.meta.push_back(Meta {
                epoch,
                at_us: now.mono_us,
                data,
            });
        }
        self.release(&key, out);
    }

    pub fn record_stop(&mut self, recording: &Id, out: &mut Vec<Effect>) {
        let source = self
            .by_id
            .values_mut()
            .find(|s| s.recording.as_ref().is_some_and(|r| r.id == *recording));
        match source.and_then(|s| s.recording.take()) {
            Some(r) => finish(r, &mut self.ended, out),
            None => normal(
                out,
                FromMedia::RecordFailed {
                    recording: recording.clone(),
                    reason: "unknown-recording".into(),
                },
            ),
        }
    }

    pub fn tick(&mut self, now: u64, egress: &mut dyn EgressSink, out: &mut Vec<Effect>) {
        let late: Vec<String> = self
            .draining
            .iter()
            .filter(|(_, (_, until))| *until <= now)
            .map(|(id, _)| id.clone())
            .collect();
        for id in late {
            self.drained(&id, None, true, egress, out);
        }
        let ids: Vec<String> = self
            .by_id
            .iter()
            .filter(|(_, s)| s.recording.is_some())
            .map(|(k, _)| k.clone())
            .collect();
        for id in ids {
            if let Some(r) = self.by_id.get_mut(&id).and_then(|s| s.recording.as_mut()) {
                r.barrier.tick(now, &mut self.events);
            }
            self.release(&id, out);
        }
    }

    /// Shutdown: every recording closes its last part.
    pub fn finish_all(&mut self, out: &mut Vec<Effect>) {
        for source in self.by_id.values_mut() {
            if let Some(recording) = source.recording.take() {
                finish(recording, &mut self.ended, out);
            }
        }
    }
}

/// Writes the pending metadata whose epoch is decided clear, in order, and drops what was
/// discarded. Metadata behind an undecided epoch waits, and so does everything after it.
fn flush_meta(recording: &mut Recording) -> Result<(), String> {
    while let Some(meta) = recording.meta.front() {
        match recording.barrier.decided(meta.epoch) {
            None => break,
            Some(clear) => {
                if let Some(meta) = recording.meta.pop_front()
                    && clear
                {
                    recording
                        .recorder
                        .meta(meta.at_us, meta.epoch, &meta.data)?;
                }
            }
        }
    }
    Ok(())
}

fn parts(out: &mut Vec<Effect>, recording: &Id, parts: Vec<Part>) {
    for part in parts {
        normal(
            out,
            FromMedia::RecordPart {
                recording: recording.clone(),
                path: part.path,
                index: part.index,
                bytes: part.bytes,
                duration_ms: part.duration_ms,
                gaps: part.gaps,
            },
        );
    }
}

fn finish(recording: Recording, ended: &mut EndedRecordings, out: &mut Vec<Effect>) {
    ended.insert(recording.id.get());
    let message = match recording.recorder.finish() {
        Ok(parts) => FromMedia::RecordDone {
            recording: recording.id,
            parts,
        },
        Err(reason) => FromMedia::RecordFailed {
            recording: recording.id,
            reason,
        },
    };
    normal(out, message);
}
