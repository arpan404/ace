// SPDX-License-Identifier: Apache-2.0
//! The egress writer (docs/media/plan.md, "Routes and setting combinations"): while a source's
//! route needs consumers in the daemon, each of its units goes back on the egress lane under
//! the source's handle and ace-media's own sequence for it. The daemon dispatches by handle,
//! never by encode id, so two sources with the same encode ids never mix.
//!
//! The lane is bounded. A unit the lane can't take is dropped, and `media-core::gate` keeps each
//! encode decodable: deltas are dropped to the next keyframe and the producer is asked for one.
use super::{Effect, normal};
use media_core::gate::ChunkGate;
use media_wire::control::{FromMedia, Id, KeyReason};
use media_wire::frame::{MediaFrame, encode_egress};

/// Where egress frames go: the shell's egress lane, or a fake in tests.
pub trait EgressSink: Send {
    /// Queues one whole egress frame. False when the lane can't take it (full, or not up yet);
    /// the frame is then dropped.
    fn offer(&mut self, frame: Vec<u8>) -> bool;
}

/// No egress lane: every frame is refused.
pub struct NoEgress;

impl EgressSink for NoEgress {
    fn offer(&mut self, _: Vec<u8>) -> bool {
        false
    }
}

const KIND_VIDEO: u8 = 1;
const KIND_AUDIO: u8 = 2;
const FLAG_KEYFRAME: u32 = 1;
/// Encodes one source keeps a gate for; past this the oldest is forgotten.
const MAX_ENCODES: usize = 16;

/// One source's egress: off until the daemon turns it on.
#[derive(Default)]
pub struct SourceEgress {
    on: bool,
    /// The sequence of the next unit. Every unit while on takes one, sent or dropped, so a gap
    /// tells the daemon frames were lost.
    sequence: u32,
    /// One gate per encode id, created at that encode's first unit since egress turned on.
    gates: Vec<(u32, ChunkGate)>,
}

impl SourceEgress {
    pub fn set(&mut self, on: bool) {
        if on && !self.on {
            // A consumer that starts now needs a keyframe first.
            self.gates.clear();
        }
        self.on = on;
    }

    /// Offers one unit of `source` (whose handle is `handle`) to the egress lane.
    pub fn unit(
        &mut self,
        source: &Id,
        handle: u32,
        frame: &MediaFrame,
        sink: &mut dyn EgressSink,
        out: &mut Vec<Effect>,
    ) {
        if !self.on {
            return;
        }
        let sequence = self.sequence;
        self.sequence = self.sequence.wrapping_add(1);
        let Ok(bytes) = encode_egress(handle, sequence, frame) else {
            return;
        };
        if frame.kind == KIND_AUDIO {
            // Every audio packet decodes on its own: nothing to gate.
            sink.offer(bytes);
            return;
        }
        let key = frame.kind != KIND_VIDEO || frame.flags & FLAG_KEYFRAME != 0;
        let gate = self.gate(frame.encode);
        let (outcome, reason) = match gate {
            Some(gate) => (gate.offer(key, || sink.offer(bytes)), KeyReason::Drop),
            None => {
                // The encode's first unit since egress turned on, and not a keyframe: the gate
                // starts closed, as after a refused send, until a keyframe comes.
                let mut gate = ChunkGate::default();
                let outcome = if key {
                    gate.offer(true, || sink.offer(bytes))
                } else {
                    gate.offer(false, || false)
                };
                self.remember(frame.encode, gate);
                (outcome, KeyReason::Resume)
            }
        };
        if outcome.keyframe && frame.kind == KIND_VIDEO {
            normal(
                out,
                FromMedia::SourceKeyframe {
                    source: source.clone(),
                    encode: frame.encode,
                    reason,
                },
            );
        }
    }

    fn gate(&mut self, encode: u32) -> Option<&mut ChunkGate> {
        self.gates
            .iter_mut()
            .find(|(id, _)| *id == encode)
            .map(|(_, gate)| gate)
    }

    fn remember(&mut self, encode: u32, gate: ChunkGate) {
        if self.gates.len() >= MAX_ENCODES {
            self.gates.remove(0);
        }
        self.gates.push((encode, gate));
    }
}
