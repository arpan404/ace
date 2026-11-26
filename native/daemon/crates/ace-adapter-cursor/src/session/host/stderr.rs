// SPDX-License-Identifier: Apache-2.0
//! Stderr framing for a host whose SDK hands its own stderr to the MCP servers it starts
//! (`onStderrLineDropped`, `host.ts:115`): an oversized line is dropped up to its terminator and
//! every line after it still arrives. The drop is `ace_supervisor::budget::DroppingGate`, the
//! port of `output-line-drop.ts`; this only turns its data runs into lines with the same
//! `LineFramer` the stdout path uses, so a line split across reads keeps its head.

use ace_supervisor::budget::{DroppingGate, Framed};
use ace_supervisor::lines::{FramedLines, LineFramer};

pub(super) struct DroppingStderr {
    gate: DroppingGate,
    framer: LineFramer,
}

impl DroppingStderr {
    pub(super) fn new(max_bytes: usize) -> DroppingStderr {
        DroppingStderr {
            gate: DroppingGate::new(max_bytes),
            framer: LineFramer::new(max_bytes),
        }
    }

    pub(super) fn push(&mut self, chunk: &[u8]) -> FramedLines {
        let mut framed = FramedLines::default();
        for frame in self.gate.push(chunk) {
            self.collect(frame, &mut framed);
        }
        framed
    }

    pub(super) fn finish(&mut self) -> FramedLines {
        let mut framed = FramedLines::default();
        for frame in self.gate.finish() {
            self.collect(frame, &mut framed);
        }
        push_lines(&self.framer.finish(), &mut framed);
        framed
    }

    /// One kept run goes through the line framer; a dropped line carries no bytes to frame.
    fn collect(&mut self, frame: Framed, framed: &mut FramedLines) {
        let Framed::Data(bytes) = frame else {
            return;
        };
        if let Ok(lines) = self.framer.push(&bytes) {
            push_lines(&lines, framed);
        }
    }
}

fn push_lines(lines: &FramedLines, framed: &mut FramedLines) {
    if lines.count == 0 {
        return;
    }
    for line in lines.text.split('\n') {
        framed.push(line);
    }
}
