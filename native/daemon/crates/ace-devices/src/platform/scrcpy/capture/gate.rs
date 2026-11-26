// SPDX-License-Identifier: Apache-2.0
//! The media-forwarding gate: one unit off scrcpy's video socket goes to ace-media's ingest
//! while it carries the capture, else to the viewer. Moving to ace-media drops every unit until
//! the device's next keyframe, which is the first one forwarded (ace-media's egress drops
//! anything before one); a device that never answers still moves, from its next unit on. The
//! writer, its writes and the source are the shell's.

/// What forwarding one unit, or one switch event, calls for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateAction {
    /// The device's next keyframe switches the path: the previous path's boundary.
    SwitchOn { boundary: Option<u64> },
    /// The unit goes to ace-media's ingest, numbered as the producer stamps it.
    Forward { sequence: u64 },
    /// Ace-media does not carry this capture: the viewer gets the unit.
    Publish { sequence: u64 },
    /// The switch ends: the producer goes off after the numbered unit.
    SwitchOff { boundary: Option<u64> },
    /// A writer went away before its switch happened: the move fails.
    Fail { message: String },
    /// A writer carrying the capture went away: nothing streams until the source reopens.
    IngestClosed,
}

/// The forwarding state: the sequence counter, a move waiting for a keyframe, and whether a
/// writer carries units now.
#[derive(Debug, Default)]
pub struct IngestGate {
    forwarded: u64,
    awaiting: bool,
    forwarding: bool,
}

impl IngestGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// The producer is being pointed at ace-media: units wait for the device's keyframe.
    pub fn awaiting_switch(&mut self) {
        self.awaiting = true;
    }

    pub fn awaiting(&self) -> bool {
        self.awaiting
    }

    pub fn forwarding(&self) -> bool {
        self.forwarding
    }

    pub fn forwarded(&self) -> u64 {
        self.forwarded
    }

    /// One unit off the video socket.
    pub fn unit(&mut self, keyframe: bool) -> Vec<GateAction> {
        let sequence = self.forwarded;
        self.forwarded += 1;
        let mut actions = Vec::new();
        if self.awaiting && keyframe {
            // The switch: everything before this went the daemon's way.
            self.awaiting = false;
            self.forwarding = true;
            actions.push(GateAction::SwitchOn {
                boundary: sequence.checked_sub(1),
            });
        }
        if self.forwarding {
            actions.push(GateAction::Forward { sequence });
        } else {
            actions.push(GateAction::Publish { sequence });
        }
        actions
    }

    /// The keyframe's retry window ended: a device that never answers still moves.
    pub fn keyframe_timeout(&mut self) -> Vec<GateAction> {
        if !self.awaiting {
            return Vec::new();
        }
        self.awaiting = false;
        self.forwarding = true;
        vec![GateAction::SwitchOn {
            boundary: self.forwarded.checked_sub(1),
        }]
    }

    /// The producer is pointed off ace-media: the writer finishes after the last numbered unit.
    pub fn off(&mut self) -> Vec<GateAction> {
        let boundary = self.forwarded.checked_sub(1);
        self.awaiting = false;
        self.forwarding = false;
        vec![GateAction::SwitchOff { boundary }]
    }

    /// The writer ended. A move still waiting fails; the one carrying units stops.
    pub fn ingest_closed(&mut self) -> Vec<GateAction> {
        if self.awaiting {
            self.awaiting = false;
            self.forwarding = false;
            return vec![GateAction::Fail {
                message: "ace-media closed the ingest connection".to_string(),
            }];
        }
        if self.forwarding {
            self.forwarding = false;
            return vec![GateAction::IngestClosed];
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_before_the_switch_go_to_the_viewer_and_the_keyframe_switches_the_path() {
        let mut gate = IngestGate::new();
        assert_eq!(gate.unit(false), vec![GateAction::Publish { sequence: 0 }]);
        gate.awaiting_switch();
        assert_eq!(gate.unit(false), vec![GateAction::Publish { sequence: 1 }]);
        assert_eq!(
            gate.unit(true),
            vec![
                GateAction::SwitchOn { boundary: Some(1) },
                GateAction::Forward { sequence: 2 }
            ]
        );
        assert!(gate.forwarding());
        assert_eq!(gate.unit(false), vec![GateAction::Forward { sequence: 3 }]);
    }

    #[test]
    fn the_first_move_into_ace_media_names_no_boundary_and_a_later_one_the_last_unit() {
        let mut gate = IngestGate::new();
        gate.awaiting_switch();
        assert_eq!(
            gate.unit(true),
            vec![
                GateAction::SwitchOn { boundary: None },
                GateAction::Forward { sequence: 0 }
            ]
        );
        gate.awaiting_switch();
        assert_eq!(
            gate.unit(true),
            vec![
                GateAction::SwitchOn { boundary: Some(0) },
                GateAction::Forward { sequence: 1 }
            ]
        );
    }

    #[test]
    fn a_device_that_never_answers_still_moves_after_the_retry_window() {
        let mut gate = IngestGate::new();
        gate.awaiting_switch();
        assert_eq!(gate.unit(false), vec![GateAction::Publish { sequence: 0 }]);
        assert_eq!(
            gate.keyframe_timeout(),
            vec![GateAction::SwitchOn { boundary: Some(0) }]
        );
        assert_eq!(gate.unit(false), vec![GateAction::Forward { sequence: 1 }]);
        assert!(gate.keyframe_timeout().is_empty(), "the move happened");
    }

    #[test]
    fn going_off_names_the_last_numbered_unit_and_stops_forwarding() {
        let mut gate = IngestGate::new();
        gate.awaiting_switch();
        gate.unit(true);
        gate.unit(false);
        assert_eq!(
            gate.off(),
            vec![GateAction::SwitchOff { boundary: Some(1) }]
        );
        assert_eq!(gate.unit(false), vec![GateAction::Publish { sequence: 2 }]);
    }

    #[test]
    fn a_writer_that_ends_before_or_after_its_switch_is_reported_the_same_way() {
        let mut gate = IngestGate::new();
        assert!(gate.ingest_closed().is_empty());
        gate.awaiting_switch();
        assert_eq!(
            gate.ingest_closed(),
            vec![GateAction::Fail {
                message: "ace-media closed the ingest connection".to_string()
            }]
        );
        gate.awaiting_switch();
        gate.unit(true);
        assert_eq!(gate.ingest_closed(), vec![GateAction::IngestClosed]);
        assert!(gate.ingest_closed().is_empty());
    }
}
