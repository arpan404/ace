// SPDX-License-Identifier: Apache-2.0
//! The path merge (`@ace/media/path-merge`) for a device, which runs one video stream. Two
//! ace-media paths, as after a restart, race: a new path's first keyframe can overtake the old
//! path's last deltas, which would then reach the decoder out of order and break its references.
//! Units are handed on in path order: after `switching(to)` the new path waits for the old
//! path's ordered end. A clean end releases everything held; an interrupted end, a full hold
//! budget or the hold's timeout gives the old path up and drops its deltas until a keyframe.
//! Pure: time is the shell's timer, named by an id this module hands out.

use std::collections::HashSet;

use super::VideoUnit;

/// Longest the new path waits for the old path's end.
pub const HOLD_MS: u64 = 1_000;
/// Most bytes a switch holds while it waits; past it the old path is given up on.
pub const MAX_HELD_BYTES: usize = 32 * 1024 * 1024;

/// What one call delivered, and the hold timer it armed or cancelled.
#[derive(Debug, Default, PartialEq)]
pub struct MergeOutcome {
    pub delivered: Vec<VideoUnit>,
    pub schedule: Option<u64>,
    pub cancel: Option<u64>,
}

#[derive(Debug)]
struct Pending {
    from: String,
    to: String,
    held: Vec<VideoUnit>,
    bytes: usize,
    timer: u64,
}

/// The device's one-stream path merge.
#[derive(Debug)]
pub struct VideoMerge {
    current: String,
    pending: Option<Pending>,
    closed: HashSet<String>,
    /// After a cut, whether the one stream has had its keyframe: `Some(false)` until it does.
    keyed: Option<bool>,
    stale: u64,
    next_timer: u64,
}

impl VideoMerge {
    pub fn new(initial: &str) -> Self {
        Self {
            current: initial.to_string(),
            pending: None,
            closed: HashSet::new(),
            keyed: None,
            stale: 0,
            next_timer: 0,
        }
    }

    /// Units dropped: from a path given up on, or deltas waiting for their keyframe.
    pub fn stale(&self) -> u64 {
        self.stale
    }

    pub fn deliver(&mut self, path: &str, unit: VideoUnit) -> MergeOutcome {
        if let Some(pending) = &mut self.pending
            && path == pending.to
        {
            pending.bytes += unit.payload.len();
            pending.held.push(unit);
            if pending.bytes > MAX_HELD_BYTES {
                return self.settle(true);
            }
            return MergeOutcome::default();
        }
        if path != self.current || self.closed.contains(path) {
            self.stale += 1;
            return MergeOutcome::default();
        }
        self.emit(unit)
    }

    /// The producer is moving to `to`: its units wait for the current path's end.
    pub fn switching(&mut self, to: &str) -> MergeOutcome {
        let repeat = self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.to == to);
        if repeat {
            return MergeOutcome::default();
        }
        let abandoned = self
            .pending
            .as_ref()
            .is_some_and(|pending| to == pending.from);
        if abandoned {
            // Told again that the producer never got to the new path: the old path goes on, and
            // whatever came on the new one is dropped.
            if let Some(pending) = self.pending.take() {
                self.closed.insert(pending.to.clone());
                self.stale += pending.held.len() as u64;
                return MergeOutcome {
                    cancel: Some(pending.timer),
                    ..MergeOutcome::default()
                };
            }
        }
        let mut outcome = if self.pending.is_some() {
            self.settle(true)
        } else {
            MergeOutcome::default()
        };
        if to == self.current {
            return outcome;
        }
        self.closed.remove(to);
        let timer = self.next_timer;
        self.next_timer += 1;
        self.pending = Some(Pending {
            from: self.current.clone(),
            to: to.to_string(),
            held: Vec::new(),
            bytes: 0,
            timer,
        });
        outcome.schedule = Some(timer);
        outcome
    }

    /// `path`'s ordered end: nothing more comes on it. `interrupted` when units may be missing.
    pub fn ended(&mut self, path: &str, interrupted: bool) -> MergeOutcome {
        if let Some(pending) = &self.pending
            && path == pending.from
        {
            return self.settle(interrupted);
        }
        if path != self.current {
            self.closed.insert(path.to_string());
        }
        MergeOutcome::default()
    }

    /// The hold's timeout fired.
    pub fn hold_elapsed(&mut self, timer: u64) -> MergeOutcome {
        match &self.pending {
            Some(pending) if pending.timer == timer => self.settle(true),
            _ => MergeOutcome::default(),
        }
    }

    pub fn dispose(&mut self) -> MergeOutcome {
        match self.pending.take() {
            Some(pending) => MergeOutcome {
                cancel: Some(pending.timer),
                ..MergeOutcome::default()
            },
            None => MergeOutcome::default(),
        }
    }

    fn settle(&mut self, interrupted: bool) -> MergeOutcome {
        let Some(pending) = self.pending.take() else {
            return MergeOutcome::default();
        };
        self.closed.insert(pending.from);
        self.current = pending.to;
        if interrupted {
            self.keyed = Some(false);
        }
        let mut outcome = MergeOutcome {
            cancel: Some(pending.timer),
            ..MergeOutcome::default()
        };
        for unit in pending.held {
            let delivered = self.emit(unit);
            outcome.delivered.extend(delivered.delivered);
        }
        outcome
    }

    fn emit(&mut self, unit: VideoUnit) -> MergeOutcome {
        if self.keyed == Some(false) {
            if !unit.keyframe {
                self.stale += 1;
                return MergeOutcome::default();
            }
            self.keyed = Some(true);
        }
        MergeOutcome {
            delivered: vec![unit],
            ..MergeOutcome::default()
        }
    }
}
