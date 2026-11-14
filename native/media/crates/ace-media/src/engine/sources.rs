// SPDX-License-Identifier: Apache-2.0
//! Sources, their ingest connections, epochs and recordings (docs/media/plan.md, "Ingest
//! framing" and "Recording privacy barrier"). Pure: `now` is ace-media's monotonic
//! milliseconds, which only bound how long the barrier holds frames.
use super::recorder::{RecordSpec, Recorder, Recorders};
use super::{Effect, log, normal, priority};
use crate::secret::{SecretId, Vault};
use media_core::privacy::{Barrier, Decision, Event, Frame, Limits, ReadStamper, Track};
use media_wire::control::{FromMedia, Id, KeyReason, Level, Origin, Sequence, Status};
use media_wire::frame::MediaFrame;
use std::collections::{HashMap, HashSet};

/// An ingest connection, named by the shell.
pub type IngestId = u64;

pub const KIND_VIDEO: u8 = 1;
pub const KIND_AUDIO: u8 = 2;
pub const KIND_PICTURE: u8 = 3;
pub const KIND_END: u8 = 4;
pub const KIND_HELLO: u8 = 5;
const FLAG_KEYFRAME: u32 = 1;
const CODEC_JPEG: u8 = 7;

struct Recording {
    id: Id,
    barrier: Barrier<MediaFrame>,
    recorder: Box<dyn Recorder>,
}

struct Source {
    id: Id,
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
}

#[derive(Default)]
pub struct Sources {
    by_id: HashMap<String, Source>,
    /// Every handle this process was given: handles are never reused while it lives.
    handles: HashSet<u32>,
    bindings: HashMap<IngestId, String>,
    events: Vec<Event<MediaFrame>>,
}

fn status(
    out: &mut Vec<Effect>,
    source: &Id,
    status: Status,
    reason: Option<&str>,
    attempts: Option<u32>,
) {
    normal(
        out,
        FromMedia::SourceStatus {
            source: source.clone(),
            status,
            reason: reason.map(Into::into),
            attempts,
            acceleration: None,
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
        out: &mut Vec<Effect>,
    ) {
        if !self.handles.insert(handle) {
            log(out, Level::Warn, "source handle reused", id);
            return status(out, id, Status::Ended, Some("handle-reused"), None);
        }
        self.close(id.get(), vault, out);
        let Some(secret) = vault.store(token) else {
            return status(out, id, Status::Ended, Some("too-many-sources"), None);
        };
        let reads_itself = matches!(
            origin,
            Origin::TabPictures {}
                | Origin::Simulator { .. }
                | Origin::Scrcpy { .. }
                | Origin::EmulatorFrames { .. }
        );
        let mut stamper = reads_itself.then(|| ReadStamper::new(epoch));
        if let Some(stamper) = &mut stamper {
            stamper.apply(epoch, false, now);
        }
        self.by_id.insert(
            id.get().to_owned(),
            Source {
                id: id.clone(),
                token: Some(secret),
                stamper,
                epoch,
                status: Status::Starting,
                drops: 0,
                ingest: None,
                encode: 0,
                recording: None,
            },
        );
        status(out, id, Status::Starting, None, None);
        // Readers for simulators, scrcpy and emulator frame files land with their producers'
        // PRs; until then the daemon keeps reading those itself.
        if matches!(
            origin,
            Origin::Simulator { .. } | Origin::Scrcpy { .. } | Origin::EmulatorFrames { .. }
        ) {
            if let Some(source) = self.by_id.get_mut(id.get()) {
                source.status = Status::Ended;
            }
            status(out, id, Status::Ended, Some("reader-unavailable"), None);
        }
    }

    pub fn close(&mut self, id: &str, vault: &mut Vault, out: &mut Vec<Effect>) {
        let Some(mut source) = self.by_id.remove(id) else {
            return;
        };
        if let Some(token) = source.token.take() {
            vault.erase(token);
        }
        if let Some(conn) = source.ingest.take() {
            self.bindings.remove(&conn);
            out.push(Effect::CloseIngest(conn));
        }
        if let Some(recording) = source.recording.take() {
            finish(recording, out);
        }
    }

    /// `source.picture`: a screencast frame the daemon passes on, read by ace-media as producer.
    pub fn picture(
        &mut self,
        id: &str,
        epoch: u32,
        payload: Vec<u8>,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        let Some(source) = self.by_id.get(id) else {
            return;
        };
        // The stricter of the two stamps: a lower epoch is never released by a later decision.
        let stamped = source
            .stamper
            .as_ref()
            .map_or(epoch, |s| s.stamp(now).min(epoch));
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
        self.unit(id, frame, now, out);
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

    /// `record.epochs`: the daemon's decisions, applied in `seq` order by the source's barrier.
    pub fn decide(&mut self, id: &Id, decision: Decision, now: u64, out: &mut Vec<Effect>) {
        let recording = self
            .by_id
            .get_mut(id.get())
            .and_then(|s| s.recording.as_mut());
        let Some(recording) = recording else {
            return priority(
                out,
                FromMedia::EpochsApplied {
                    source: id.clone(),
                    seq: sequence(decision.seq),
                    written: sequence(0),
                    dropped: sequence(0),
                },
            );
        };
        recording.barrier.decide(decision, now, &mut self.events);
        self.release(id.get(), out);
    }

    /// A frame from an ingest connection. The first must be a hello with an unused token of an
    /// open source; anything else closes the connection.
    pub fn ingest(
        &mut self,
        conn: IngestId,
        frame: MediaFrame,
        vault: &mut Vault,
        now: u64,
        out: &mut Vec<Effect>,
    ) {
        let Some(id) = self.bindings.get(&conn).cloned() else {
            return self.hello(conn, &frame, vault, out);
        };
        match frame.kind {
            KIND_VIDEO | KIND_AUDIO | KIND_PICTURE => self.unit(&id, frame, now, out),
            KIND_END => {
                self.bindings.remove(&conn);
                out.push(Effect::CloseIngest(conn));
                if let Some(source) = self.by_id.get_mut(&id) {
                    source.ingest = None;
                    source.status = Status::Ended;
                    status(out, &source.id, Status::Ended, None, None);
                }
            }
            _ => self.unbind(conn, now, out),
        }
    }

    fn hello(
        &mut self,
        conn: IngestId,
        frame: &MediaFrame,
        vault: &mut Vault,
        out: &mut Vec<Effect>,
    ) {
        let candidates = self
            .by_id
            .iter()
            .filter_map(|(key, s)| s.token.map(|t| (key.as_str(), t)));
        let found = (frame.kind == KIND_HELLO)
            .then(|| vault.find(candidates, &frame.payload))
            .flatten()
            .map(str::to_owned);
        let source = found.as_ref().and_then(|key| self.by_id.get_mut(key));
        let Some(source) = source else {
            return out.push(Effect::CloseIngest(conn));
        };
        if let Some(token) = source.token.take() {
            vault.erase(token);
        }
        source.ingest = Some(conn);
        self.bindings.insert(conn, source.id.get().to_owned());
    }

    /// The producer's connection ended without an end-of-source frame.
    pub fn ingest_closed(&mut self, conn: IngestId, now: u64, out: &mut Vec<Effect>) {
        let Some(id) = self.bindings.remove(&conn) else {
            return;
        };
        let Some(source) = self.by_id.get_mut(&id) else {
            return;
        };
        source.ingest = None;
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

    fn unbind(&mut self, conn: IngestId, now: u64, out: &mut Vec<Effect>) {
        out.push(Effect::CloseIngest(conn));
        self.ingest_closed(conn, now, out);
    }

    fn unit(&mut self, id: &str, frame: MediaFrame, now: u64, out: &mut Vec<Effect>) {
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
            payload: frame,
        };
        recording
            .barrier
            .frame(barrier_frame, now, &mut self.events);
        self.release(id, out);
    }

    /// Hands what the barrier released to the recorder and the daemon.
    fn release(&mut self, id: &str, out: &mut Vec<Effect>) {
        let Some(source) = self.by_id.get_mut(id) else {
            self.events.clear();
            return;
        };
        for event in self.events.drain(..) {
            let Some(recording) = &mut source.recording else {
                continue;
            };
            match event {
                Event::Write(frame) => recording.recorder.write(&frame.payload),
                Event::Drop(..) => {}
                Event::Gap => recording.recorder.gap(),
                Event::Keyframe => normal(
                    out,
                    FromMedia::SourceKeyframe {
                        source: source.id.clone(),
                        encode: source.encode,
                        reason: KeyReason::Resume,
                    },
                ),
                Event::Applied {
                    seq,
                    written,
                    dropped,
                } => priority(
                    out,
                    FromMedia::EpochsApplied {
                        source: source.id.clone(),
                        seq: sequence(seq),
                        written: sequence(written),
                        dropped: sequence(dropped),
                    },
                ),
            }
        }
    }

    pub fn record_start(
        &mut self,
        spec: &RecordSpec<'_>,
        recording: &Id,
        recorders: &mut dyn Recorders,
        out: &mut Vec<Effect>,
    ) {
        let fail = |out: &mut Vec<Effect>, reason: &str| {
            normal(
                out,
                FromMedia::RecordFailed {
                    recording: recording.clone(),
                    reason: reason.into(),
                },
            )
        };
        let Some(source) = self.by_id.get_mut(spec.source) else {
            return fail(out, "unknown-source");
        };
        if source.recording.is_some() {
            return fail(out, "already-recording");
        }
        match recorders.start(spec) {
            Err(reason) => fail(out, &reason),
            Ok(recorder) => {
                let mut barrier = Barrier::new(source.epoch, Limits::default());
                if source.stamper.is_some() {
                    barrier.issued(source.epoch);
                }
                source.recording = Some(Recording {
                    id: recording.clone(),
                    barrier,
                    recorder,
                });
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

    pub fn record_meta(&mut self, recording: &str, epoch: u32, data: &serde_json::Value) {
        if let Some(r) = self.recording_mut(recording) {
            r.recorder.meta(epoch, data);
        }
    }

    pub fn record_stop(&mut self, recording: &Id, out: &mut Vec<Effect>) {
        let source = self
            .by_id
            .values_mut()
            .find(|s| s.recording.as_ref().is_some_and(|r| r.id == *recording));
        match source.and_then(|s| s.recording.take()) {
            Some(r) => finish(r, out),
            None => normal(
                out,
                FromMedia::RecordFailed {
                    recording: recording.clone(),
                    reason: "unknown-recording".into(),
                },
            ),
        }
    }

    pub fn tick(&mut self, now: u64, out: &mut Vec<Effect>) {
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
                finish(recording, out);
            }
        }
    }
}

fn finish(recording: Recording, out: &mut Vec<Effect>) {
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
