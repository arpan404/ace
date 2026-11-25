// SPDX-License-Identifier: Apache-2.0
//! `media-paths.ts`: a device's video comes only through ace-media. Every unit off egress goes
//! through one path merge, so the capture downstream sees one ordered stream across ace-media
//! paths (a reconnect, a restart) and numbers its frames as before.
//!
//! Leaving a path, it ends with ace-media's end marker after its last unit. While the producer
//! isn't pointed at ace-media nothing streams; a producer whose ingest connection fails stops,
//! that path is cut, and video starts again at a keyframe on the next one.
//!
//! The media source, its producer and ace-media's address are the shell's; this module decides
//! when the producer moves, whether the move took, which path the merge is on, and which units
//! are handed on. Every method returns [`Action`]s in order.

mod egress;
mod merge;

pub use egress::{EgressFrame, EgressUnit, H264_ONLY, VideoUnit, egress_video_unit};
pub use merge::{HOLD_MS, MAX_HELD_BYTES};

use std::collections::{HashMap, VecDeque};

use merge::{MergeOutcome, VideoMerge};

/// The path name for "nothing streams".
pub const OFF: &str = "off";
/// What switching the producer to ace-media answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Switched {
    pub ingest: bool,
    pub boundary: Option<u64>,
    pub cut: bool,
}

/// What the shell must do, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// Hand a unit to the capture's own consumers.
    Emit(VideoUnit),
    /// Ask the producer for a keyframe (`source.key(encode)`).
    Key { encode: u32 },
    /// The producer's ingest connection ended; open the source again.
    Reconnect,
    /// The codecs the producer encodes, best first.
    Codes(Vec<String>),
    /// Point the producer at this path, or off with `None`.
    Switch { token: u64, to: Option<String> },
    /// ace-media's source was pointed again while live: it restarted.
    Repointed,
    /// The move finished: the shell's `point` promise resolves.
    PointDone { token: u64 },
    /// The move failed: the shell's `point` promise rejects.
    PointFailed { token: u64, message: String },
    /// Arm the merge's hold timer; the shell calls `hold_elapsed` when it fires.
    ScheduleHold { timer: u64 },
    /// Drop the merge's hold timer.
    CancelHold { timer: u64 },
}

#[derive(Debug, Clone)]
struct SwitchRequest {
    token: u64,
    to: Option<String>,
}

#[derive(Debug)]
struct InFlight {
    token: u64,
    to: Option<String>,
}

/// One device's video paths. See the module docs.
#[derive(Debug)]
pub struct DevicePaths {
    merge: VideoMerge,
    codec: String,
    on_path: String,
    merge_on: String,
    /// Paths whose end has come: the merge moves on from them at once.
    ended: HashMap<String, bool>,
    last_unit: Option<u64>,
    closed: bool,
    scrcpy: bool,
    queue: VecDeque<SwitchRequest>,
    in_flight: Option<InFlight>,
    off_queued: bool,
    off_token: Option<u64>,
    next_token: u64,
}

impl DevicePaths {
    pub fn new(codec: &str, scrcpy: bool) -> (Self, Vec<Action>) {
        let mut ended = HashMap::new();
        ended.insert(OFF.to_string(), false);
        (
            Self {
                merge: VideoMerge::new(OFF),
                codec: codec.to_string(),
                on_path: OFF.to_string(),
                merge_on: OFF.to_string(),
                ended,
                last_unit: None,
                closed: false,
                scrcpy,
                queue: VecDeque::new(),
                in_flight: None,
                off_queued: false,
                off_token: None,
                next_token: 0,
            },
            vec![Action::Codes(vec![H264_ONLY.to_string()])],
        )
    }

    pub fn stale(&self) -> u64 {
        self.merge.stale()
    }

    /// Points the producer at ace-media, or stops it; the shell awaits `PointDone`/`PointFailed`.
    pub fn point(&mut self, to: Option<&str>) -> (u64, Vec<Action>) {
        let token = self.next_token;
        self.next_token += 1;
        self.queue.push_back(SwitchRequest {
            token,
            to: to.map(str::to_string),
        });
        let actions = self.start_next();
        (token, actions)
    }

    /// The producer's answer to a switch named by `token`.
    pub fn switched(&mut self, token: u64, answer: Switched) -> Vec<Action> {
        let Some(in_flight) = self.in_flight.take() else {
            return Vec::new();
        };
        if in_flight.token != token {
            self.in_flight = Some(in_flight);
            return Vec::new();
        }
        if self.off_token == Some(token) {
            self.off_token = None;
            return self.start_next();
        }
        let Some(to) = in_flight.to.clone() else {
            return self.start_next();
        };
        let mut actions = Vec::new();
        let path = to.as_str();
        if self.closed {
            actions.push(Action::PointDone { token });
            actions.extend(self.start_next());
            return actions;
        }
        if answer.ingest != (path != OFF) {
            actions.push(Action::PointFailed {
                token,
                message: "The producer refused ace-media's ingest".to_string(),
            });
            actions.extend(self.start_next());
            return actions;
        }
        // ace-media's source pointed at a new path while live means it restarted: its reader
        // dials the tunnel again, and the daemon re-handshakes once it greets.
        if self.scrcpy && path != OFF && path != self.merge_on && self.merge_on != OFF {
            actions.push(Action::Repointed);
        }
        self.on_path = path.to_string();
        if path == OFF || path == self.merge_on {
            actions.push(Action::PointDone { token });
            actions.extend(self.start_next());
            return actions;
        }
        let previous = self.merge_on.clone();
        self.merge_on = path.to_string();
        let outcome = self.merge.switching(path);
        self.apply(outcome, &mut actions);
        if answer.cut {
            // The paths carry the same live stream: the old one ends at the switch, and the
            // new one starts at a keyframe of the picture as it is now.
            let outcome = self.merge.ended(&previous, true);
            self.apply(outcome, &mut actions);
            actions.push(Action::Key { encode: 0 });
        } else if let Some(interrupted) = self.ended.get(&previous).copied() {
            let outcome = self.merge.ended(&previous, interrupted);
            self.apply(outcome, &mut actions);
        }
        actions.push(Action::PointDone { token });
        actions.extend(self.start_next());
        actions
    }

    /// One path's ordered end came. `interrupted` when units may be missing.
    pub fn path_ended(&mut self, path: &str, interrupted: bool) -> Vec<Action> {
        self.ended.insert(path.to_string(), interrupted);
        let mut actions = Vec::new();
        let outcome = self.merge.ended(path, interrupted);
        self.apply(outcome, &mut actions);
        if interrupted {
            actions.push(Action::Key { encode: 0 });
        }
        actions
    }

    /// The producer's ingest connection failed: it has stopped already. The source reopens.
    pub fn ingest_closed(&mut self) -> Vec<Action> {
        if self.closed || self.on_path == OFF {
            return Vec::new();
        }
        self.on_path = OFF.to_string();
        vec![Action::Key { encode: 0 }, Action::Reconnect]
    }

    /// A keyframe while the source streams from ace-media: ace-media reads it, so it is asked.
    pub fn keyframe(&self) -> (bool, Vec<Action>) {
        if self.closed || self.on_path == OFF {
            return (false, Vec::new());
        }
        (true, vec![Action::Key { encode: 0 }])
    }

    /// One egress unit. `unit_id` names the delivery, so the same one handed on twice is ignored.
    pub fn egress(&mut self, unit_id: u64, unit: &EgressUnit) -> Vec<Action> {
        if self.closed || self.last_unit == Some(unit_id) {
            return Vec::new();
        }
        self.last_unit = Some(unit_id);
        let Some(video) = egress_video_unit(unit, &self.codec) else {
            return Vec::new();
        };
        let mut actions = Vec::new();
        let outcome = self.merge.deliver(&unit.source, video);
        self.apply(outcome, &mut actions);
        actions
    }

    /// The merge's hold timer fired.
    pub fn hold_elapsed(&mut self, timer: u64) -> Vec<Action> {
        let mut actions = Vec::new();
        let outcome = self.merge.hold_elapsed(timer);
        self.apply(outcome, &mut actions);
        actions
    }

    /// Closes the paths and turns the producer off, after any switch still in flight.
    pub fn close(&mut self) -> Vec<Action> {
        if self.closed {
            return Vec::new();
        }
        self.closed = true;
        let mut actions = Vec::new();
        let outcome = self.merge.dispose();
        self.apply(outcome, &mut actions);
        self.off_queued = true;
        actions.extend(self.start_next());
        actions
    }

    fn start_next(&mut self) -> Vec<Action> {
        if self.in_flight.is_some() {
            return Vec::new();
        }
        let mut actions = Vec::new();
        while let Some(next) = self.queue.pop_front() {
            if self.closed {
                actions.push(Action::PointDone { token: next.token });
                continue;
            }
            self.in_flight = Some(InFlight {
                token: next.token,
                to: next.to.clone(),
            });
            actions.push(Action::Switch {
                token: next.token,
                to: next.to,
            });
            return actions;
        }
        if self.off_queued && self.off_token.is_none() {
            let token = self.next_token;
            self.next_token += 1;
            self.off_token = Some(token);
            self.in_flight = Some(InFlight { token, to: None });
            actions.push(Action::Switch { token, to: None });
        }
        actions
    }

    fn apply(&mut self, outcome: MergeOutcome, actions: &mut Vec<Action>) {
        if let Some(cancel) = outcome.cancel {
            actions.push(Action::CancelHold { timer: cancel });
        }
        if let Some(timer) = outcome.schedule {
            actions.push(Action::ScheduleHold { timer });
        }
        for unit in outcome.delivered {
            if unit.keyframe {
                self.codec.clone_from(&unit.video_codec);
            }
            actions.push(Action::Emit(unit));
        }
    }
}

#[cfg(test)]
mod tests;
