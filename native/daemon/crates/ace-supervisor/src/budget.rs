// SPDX-License-Identifier: Apache-2.0
//! Bounded output budgets: the line counter every reader shares, the framing that
//! drops an oversized line instead of retaining it, and the one-note-per-interval
//! summary a flood of drops produces. Ports `byte-limit.ts`, the non-dropping half
//! of `output-budget.ts`, `bounded-line-framing.ts`, `output-line-drop.ts` and
//! `dropped-line-notes.ts`. No I/O: the schedules and stream callbacks stay in the
//! shell (`native-streams.ts`).

use std::fmt;

/// Why a framed stream refused its input. Messages are the shell's contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum StreamError {
    /// A limit the caller passed is not a positive safe integer (`byteLimit`).
    #[error("Invalid {0}")]
    InvalidLimit(&'static str),
    /// Refused for the reason given: `JSON.stringify`-safe text the shell rethrows.
    #[error("{0}")]
    Refused(String),
}

impl StreamError {
    /// A refusal with today's message.
    pub fn refused(message: impl Into<String>) -> StreamError {
        StreamError::Refused(message.into())
    }
}

/// Largest integer a JavaScript number holds exactly (`Number.isSafeInteger`).
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger(value) && value > 0`, the check every limit shares.
pub fn is_byte_limit(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0 && value > 0.0 && value <= MAX_SAFE_INTEGER
}

/// `byteLimit(value, name)`: a positive safe integer, or `Invalid <name>`.
pub fn byte_limit(value: f64, name: &'static str) -> Result<usize, StreamError> {
    if is_byte_limit(value) {
        Ok(value as usize)
    } else {
        Err(StreamError::InvalidLimit(name))
    }
}

/// A byte count from JavaScript, never panicking on a hostile value.
pub fn byte_count(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        value.min(u64::MAX as f64) as u64
    } else {
        0
    }
}

/// The byte counter the non-dropping gate runs before any decoding: bytes since
/// the last CR or LF, failing once a line is longer than the limit.
#[derive(Debug, Clone)]
pub struct OutputGate {
    max_line_bytes: Option<usize>,
    line_bytes: usize,
    stopped: bool,
}

impl OutputGate {
    pub fn new(max_line_bytes: Option<usize>) -> OutputGate {
        OutputGate {
            max_line_bytes,
            line_bytes: 0,
            stopped: false,
        }
    }

    /// No line may be retained after the limit was crossed.
    pub fn stop(&mut self) {
        self.stopped = true;
    }

    /// Check one chunk's raw bytes. On `Some`, the caller fails the stream and stops.
    pub fn push(&mut self, chunk: &[u8]) -> Option<String> {
        if self.stopped {
            return None;
        }
        let max = self.max_line_bytes?;
        for &byte in chunk {
            if byte == b'\n' || byte == b'\r' {
                self.line_bytes = 0;
                continue;
            }
            self.line_bytes += 1;
            if self.line_bytes > max {
                self.stopped = true;
                return Some(format!(
                    "Process output line exceeded limit (line limit {max} bytes)"
                ));
            }
        }
        None
    }
}

/// How a dropped line's loss is reported: as it starts, and at its delimiter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropPhase {
    Start,
    End,
    Complete,
}

impl DropPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            DropPhase::Start => "start",
            DropPhase::End => "end",
            DropPhase::Complete => "complete",
        }
    }
}

/// A line that was too long to keep: its final size and a bounded prefix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DroppedLine {
    pub bytes: usize,
    pub prefix: String,
    pub phase: DropPhase,
}

/// What framing produced for one chunk, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Framed {
    /// Complete lines kept together as one publishable run.
    Data(Vec<u8>),
    /// One lost line.
    Drop(DroppedLine),
}

/// Stateful byte framing without I/O; an oversized line retains only a bounded
/// prefix (`BoundedLineFraming`).
#[derive(Debug, Clone)]
pub struct BoundedLineFraming {
    limit: usize,
    parts: Vec<Vec<u8>>,
    bytes: usize,
    prefix: Option<String>,
    announced: bool,
}

impl BoundedLineFraming {
    pub fn new(limit: usize) -> BoundedLineFraming {
        BoundedLineFraming {
            limit,
            parts: Vec::new(),
            bytes: 0,
            prefix: None,
            announced: false,
        }
    }

    pub fn next(&mut self, chunk: &[u8]) -> Vec<Framed> {
        let mut frames = Vec::new();
        let mut start = 0usize;
        for end in 0..=chunk.len() {
            let delimiter = end < chunk.len() && (chunk[end] == b'\n' || chunk[end] == b'\r');
            if !delimiter && end != chunk.len() {
                continue;
            }
            let size = end - start;
            self.bytes += size;
            if self.prefix.is_none() {
                // Copy: a short tail must not retain the provider's entire chunk.
                let remaining = self.limit.saturating_sub(self.bytes - size);
                if size > 0 {
                    let keep = size.min(remaining);
                    self.parts.push(chunk[start..start + keep].to_vec());
                }
                if self.bytes > self.limit {
                    self.prefix = Some(prefix_text(&self.parts, self.limit.min(4096)));
                    self.parts.clear();
                    if !delimiter {
                        self.announced = true;
                        frames.push(Framed::Drop(DroppedLine {
                            bytes: self.bytes,
                            prefix: self.prefix.clone().unwrap_or_default(),
                            phase: DropPhase::Start,
                        }));
                    }
                }
            }
            if delimiter {
                let skipped = self.prefix.is_some();
                frames.extend(self.finish());
                // A dropped line contributes no delimiter; CRLF's following LF is
                // harmless framing.
                if !skipped {
                    frames.push(Framed::Data(vec![chunk[end]]));
                }
            }
            start = end + 1;
        }
        frames
    }

    pub fn finish(&mut self) -> Vec<Framed> {
        let frames = if let Some(prefix) = self.prefix.take() {
            let phase = if self.announced {
                DropPhase::End
            } else {
                DropPhase::Complete
            };
            vec![Framed::Drop(DroppedLine {
                bytes: self.bytes,
                prefix,
                phase,
            })]
        } else if self.parts.is_empty() {
            Vec::new()
        } else {
            let mut bytes = Vec::with_capacity(self.bytes.min(self.limit));
            for part in &self.parts {
                bytes.extend_from_slice(part);
            }
            vec![Framed::Data(bytes)]
        };
        self.parts.clear();
        self.bytes = 0;
        self.prefix = None;
        self.announced = false;
        frames
    }
}

/// `Buffer.concat(parts, total).toString("utf8")` for the retained prefix.
fn prefix_text(parts: &[Vec<u8>], total: usize) -> String {
    let mut bytes = Vec::with_capacity(total.min(4096));
    for part in parts {
        let room = total.saturating_sub(bytes.len());
        if room == 0 {
            break;
        }
        bytes.extend_from_slice(&part[..part.len().min(room)]);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The dropping gate: framing plus the stop that follows a refused admission.
#[derive(Debug, Clone)]
pub struct DroppingGate {
    framing: Option<BoundedLineFraming>,
}

impl DroppingGate {
    pub fn new(limit: usize) -> DroppingGate {
        DroppingGate {
            framing: Some(BoundedLineFraming::new(limit)),
        }
    }

    pub fn push(&mut self, chunk: &[u8]) -> Vec<Framed> {
        match &mut self.framing {
            Some(framing) => framing.next(chunk),
            None => Vec::new(),
        }
    }

    /// Admission was refused: drop the framing and hold nothing more.
    pub fn stop(&mut self) {
        self.framing = None;
    }

    pub fn finish(&mut self) -> Vec<Framed> {
        match &mut self.framing {
            Some(framing) => framing.finish(),
            None => Vec::new(),
        }
    }
}

/// One step's outcome for the notes shell: a note to deliver, and whether the
/// interval timer must be armed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NoteStep {
    pub note: Option<String>,
    pub arm: bool,
}

/// Bounded diagnostics for dropped stderr lines (`droppedLineNotes`). The first
/// drop is noted at once; later ones within the interval are summed into one note
/// when it ends. The schedule itself stays in the shell.
#[derive(Debug, Clone, Default)]
pub struct DroppedNotes {
    lines: u64,
    bytes: u64,
    armed: bool,
}

impl DroppedNotes {
    pub fn new() -> DroppedNotes {
        DroppedNotes::default()
    }

    /// Feed every drop the spawn reports; a split line counts once, at its final size.
    pub fn dropped(&mut self, bytes: u64, phase: DropPhase) -> NoteStep {
        if phase == DropPhase::Start {
            return NoteStep::default();
        }
        self.lines = self.lines.saturating_add(1);
        self.bytes = self.bytes.saturating_add(bytes);
        if self.armed {
            return NoteStep::default();
        }
        let note = self.report();
        self.armed = true;
        NoteStep { note, arm: true }
    }

    /// The interval ended: report what it holds and open the next one.
    pub fn fire(&mut self) -> NoteStep {
        self.armed = false;
        let note = self.report();
        let arm = note.is_some();
        self.armed = arm;
        NoteStep { note, arm }
    }

    /// Report what is still pending and stop the timer, as when the process exits.
    pub fn flush(&mut self) -> Option<String> {
        self.armed = false;
        self.report()
    }

    fn report(&mut self) -> Option<String> {
        if self.lines == 0 {
            return None;
        }
        let lines = std::mem::take(&mut self.lines);
        let bytes = std::mem::take(&mut self.bytes);
        Some(if lines == 1 {
            format!("ace dropped a stderr line of {bytes} bytes")
        } else {
            format!("ace dropped {lines} stderr lines, {bytes} bytes in total")
        })
    }
}

impl fmt::Display for DropPhase {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn take(frames: Vec<Framed>, output: &mut Vec<u8>, drops: &mut Vec<DroppedLine>) {
        for frame in frames {
            match frame {
                Framed::Data(bytes) => output.extend_from_slice(&bytes),
                Framed::Drop(line) => drops.push(line),
            }
        }
    }

    fn run(chunks: &[&str], limit: usize) -> (String, Vec<DroppedLine>) {
        let mut gate = DroppingGate::new(limit);
        let mut output = Vec::new();
        let mut drops = Vec::new();
        for chunk in chunks {
            take(gate.push(chunk.as_bytes()), &mut output, &mut drops);
        }
        take(gate.finish(), &mut output, &mut drops);
        (String::from_utf8_lossy(&output).into_owned(), drops)
    }

    fn drop_line(bytes: usize, prefix: &str, phase: DropPhase) -> DroppedLine {
        DroppedLine {
            bytes,
            prefix: prefix.to_owned(),
            phase,
        }
    }

    #[test]
    fn skipping_an_oversized_line_keeps_the_next_line_intact_across_chunks() {
        type Case<'a> = (&'a [&'a str], &'a str, &'a [(usize, &'a str, DropPhase)]);
        let cases: &[Case<'_>] = &[
            (
                &["12345678", "9", "extra\n", "next\n"],
                "next\n",
                &[
                    (9, "12345678", DropPhase::Start),
                    (14, "12345678", DropPhase::End),
                ],
            ),
            (
                &["1234", "56789extra\nnext", "\n"],
                "next\n",
                &[(14, "12345678", DropPhase::Complete)],
            ),
            (
                &["ok\n123456789", "extra\r", "\nnext\n"],
                "ok\n\nnext\n",
                &[
                    (9, "12345678", DropPhase::Start),
                    (14, "12345678", DropPhase::End),
                ],
            ),
        ];
        for (chunks, expected, notices) in cases {
            let (output, drops) = run(chunks, 8);
            assert_eq!(&output, expected);
            let expected: Vec<DroppedLine> = notices
                .iter()
                .map(|(bytes, prefix, phase)| drop_line(*bytes, prefix, *phase))
                .collect();
            assert_eq!(drops, expected);
        }
    }

    #[test]
    fn a_line_ending_at_the_limit_is_kept_and_a_dropped_final_line_is_reported_at_eof() {
        let (output, drops) = run(&["12345678", "\n12345678", "9"], 8);
        assert_eq!(output, "12345678\n");
        assert_eq!(
            drops,
            vec![
                drop_line(9, "12345678", DropPhase::Start),
                drop_line(9, "12345678", DropPhase::End),
            ]
        );
    }

    #[test]
    fn crossing_the_line_budget_reports_lost_state_before_a_newline_arrives() {
        let mut gate = DroppingGate::new(8);
        let mut drops = Vec::new();
        for frame in gate.push(b"123456789") {
            if let Framed::Drop(line) = frame {
                drops.push(line);
            }
        }
        assert_eq!(drops, vec![drop_line(9, "12345678", DropPhase::Start)]);
        for frame in gate.push(b"longer\n") {
            if let Framed::Drop(line) = frame {
                drops.push(line);
            }
        }
        assert_eq!(
            drops.last(),
            Some(&drop_line(15, "12345678", DropPhase::End))
        );
    }

    fn line(bytes: u64, phase: DropPhase) -> (u64, DropPhase) {
        (bytes, phase)
    }

    #[test]
    fn a_flood_of_dropped_lines_gives_one_note_at_once_then_one_summary_per_interval() {
        let mut notes = DroppedNotes::new();
        let mut emitted = Vec::new();
        for index in 0..1000 {
            let (bytes, phase) = line(100, DropPhase::Complete);
            let step = notes.dropped(bytes, phase);
            if let Some(note) = step.note {
                emitted.push(note);
            }
            assert_eq!(step.arm, index == 0);
        }
        assert_eq!(emitted, vec!["ace dropped a stderr line of 100 bytes"]);
        let step = notes.fire();
        assert_eq!(
            step.note.as_deref(),
            Some("ace dropped 999 stderr lines, 99900 bytes in total")
        );
        assert!(step.arm);
        let step = notes.fire();
        assert_eq!(step.note, None);
        assert!(!step.arm);
        assert_eq!(emitted.len(), 1);
        let (bytes, phase) = line(7, DropPhase::Complete);
        let step = notes.dropped(bytes, phase);
        assert_eq!(
            step.note.as_deref(),
            Some("ace dropped a stderr line of 7 bytes")
        );
    }

    #[test]
    fn a_split_line_counts_once_at_its_final_size() {
        let mut notes = DroppedNotes::new();
        let mut emitted = Vec::new();
        for (bytes, phase) in [line(10, DropPhase::Start), line(50, DropPhase::End)] {
            if let Some(note) = notes.dropped(bytes, phase).note {
                emitted.push(note);
            }
        }
        assert_eq!(emitted, vec!["ace dropped a stderr line of 50 bytes"]);
    }

    #[test]
    fn flush_reports_what_is_still_pending_and_stops_the_timer() {
        let mut notes = DroppedNotes::new();
        let mut emitted = Vec::new();
        for bytes in [1, 2, 3] {
            if let Some(note) = notes.dropped(bytes, DropPhase::Complete).note {
                emitted.push(note);
            }
        }
        if let Some(note) = notes.flush() {
            emitted.push(note);
        }
        assert_eq!(
            emitted,
            vec![
                "ace dropped a stderr line of 1 bytes",
                "ace dropped 2 stderr lines, 5 bytes in total",
            ]
        );
        assert_eq!(notes.flush(), None);
        assert_eq!(emitted.len(), 2);
    }
}
