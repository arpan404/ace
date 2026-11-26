// SPDX-License-Identifier: Apache-2.0
//! The stdin side: input admission (`session.ts:377`-`:419`, `input.ts:13`-`:37`) and the write
//! queue every outbound line shares, so a `send` frame follows its write (rule 16). One record
//! per write, in order; only user lines count toward the 256 cap.

use std::collections::VecDeque;

use ace_json::{Map, Value};

use crate::session::error::ClaudeError;
use crate::session::wire::{CLOSED, ClaudeWire, Effect, FrameDir, LINE_BYTES, OUTBOUND};

const SDK: &str = "sdk";
/// `InputStream`'s queue bound (`input.ts:20`).
const MAX_INPUTS: usize = 256;
/// The node message a refused port write becomes; the shell reports it as uncertain.
const STDIN_CLOSED: &str = "Claude stdin closed";

/// What a write emits once the port has taken it.
pub(crate) enum After {
    /// A user line: the `send`/`sdk` frame's captured text.
    Input(String),
    /// A control envelope: the `send`/`wire` frame's captured text.
    Wire(&'static str, String),
}

pub(crate) struct Record {
    after: After,
    /// A control request's facade tag and id, so a refused write settles it (`PiWire`'s rule).
    control: Option<(u64, String)>,
}

/// Outbound lines handed to the port and not yet acknowledged, in order.
#[derive(Default)]
pub(crate) struct Writes {
    records: VecDeque<Record>,
    inputs: usize,
    failed: Option<String>,
}

impl Writes {
    pub(crate) fn new() -> Writes {
        Writes::default()
    }

    /// Hand one line to the port: the write effect, and the frame its acknowledgement emits.
    pub(crate) fn push(
        &mut self,
        wire: Vec<u8>,
        after: After,
        control: Option<(u64, String)>,
    ) -> Effect {
        if matches!(after, After::Input(_)) {
            self.inputs += 1;
        }
        self.records.push_back(Record { after, control });
        Effect::Write { wire }
    }

    pub(crate) fn inputs(&self) -> usize {
        self.inputs
    }

    pub(crate) fn failed(&self) -> Option<&str> {
        self.failed.as_deref()
    }

    /// One write reached the port: its frame, now that the write is handed over.
    pub(crate) fn written(&mut self) -> Vec<Effect> {
        let Some(record) = self.records.pop_front() else {
            return Vec::new();
        };
        match record.after {
            After::Input(text) => {
                self.inputs = self.inputs.saturating_sub(1);
                vec![Effect::Frame {
                    dir: FrameDir::Send,
                    channel: SDK,
                    text,
                }]
            }
            After::Wire(channel, text) => vec![Effect::Frame {
                dir: FrameDir::Send,
                channel,
                text,
            }],
        }
    }

    /// Every queued write, for a port that failed.
    pub(crate) fn take_all(&mut self) -> Vec<Record> {
        self.inputs = 0;
        self.records.drain(..).collect()
    }

    /// Latch the failure and report it.
    pub(crate) fn fail(&mut self, message: &str) -> Effect {
        self.failed = Some(message.to_owned());
        Effect::Fatal {
            message: message.to_owned(),
        }
    }
}

impl ClaudeWire {
    /// `send(messages, delivery, commandId, …)`'s write half (`session.ts:377`-`:419`): every
    /// message is encoded, bounded and captured before the first write, so a refusal takes none.
    pub fn send(
        &mut self,
        messages_json: &str,
        command_id: Option<&str>,
    ) -> Result<Vec<Effect>, ClaudeError> {
        // Input closed is the session's close (`input.ts:20`: `push` throws once `close` ran),
        // so nothing reaches a pipe that already took its EOF.
        if self.finished || self.failed || !self.input_open {
            return Err(ClaudeError::Refused(CLOSED.to_owned()));
        }
        if let Some(message) = self.writes.failed() {
            return Err(ClaudeError::Refused(message.to_owned()));
        }
        let value = ace_json::parse(messages_json)
            .map_err(|_| ClaudeError::Refused("Claude input is not valid".to_owned()))?;
        let Some(messages) = value.as_array() else {
            return Err(ClaudeError::Refused("Claude input is not valid".to_owned()));
        };
        if self.writes.inputs() + messages.len() > MAX_INPUTS {
            return Err(ClaudeError::Refused(
                "Claude input capacity reached".to_owned(),
            ));
        }
        let mut admitted = Vec::with_capacity(messages.len());
        for message in messages {
            let text = ace_json::to_string(message);
            let mut wire = text.into_bytes();
            wire.push(b'\n');
            if wire.len() > LINE_BYTES {
                return Err(ClaudeError::Refused(OUTBOUND.to_owned()));
            }
            let captured = self.capture(message).map_err(ClaudeError::Refused)?;
            let uuid = message
                .get("uuid")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            admitted.push((wire, captured, uuid));
        }
        let mut effects = Vec::new();
        for (wire, captured, uuid) in admitted {
            if let Some(command_id) = command_id {
                effects.push(Effect::Callback {
                    name: "onInputMessage",
                    json: input_message(command_id, &uuid),
                });
            }
            effects.push(self.writes.push(wire, After::Input(captured), None));
        }
        Ok(effects)
    }

    /// One write reached the port. A late ack after the barrier emits nothing.
    pub fn stdin_written(&mut self) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        self.writes.written()
    }

    /// The port failed: every queued control settles `Uncertain`, then the latch.
    pub fn stdin_error(&mut self, message: &str) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        self.failed = true;
        self.settle_queued(message)
    }

    /// The port refused a write: every queued control settles `Uncertain` (`pushed > 0`), then
    /// the latch. The later writes cannot reach a closed port either.
    pub fn write_refused(&mut self) -> Vec<Effect> {
        if self.finished || self.failed {
            return Vec::new();
        }
        self.failed = true;
        self.settle_queued(STDIN_CLOSED)
    }

    fn settle_queued(&mut self, message: &str) -> Vec<Effect> {
        let mut effects = Vec::new();
        for record in self.writes.take_all() {
            if let Some((tag, request_id)) = record.control
                && self.controls.settle(&request_id).is_some()
            {
                effects.push(Effect::Settle {
                    id: tag,
                    result: Err(ClaudeError::Uncertain(message.to_owned())),
                });
            }
        }
        effects.push(self.writes.fail(message));
        effects
    }
}

/// `{commandId, nativeId}` (`session.ts:409`).
fn input_message(command_id: &str, uuid: &str) -> String {
    let mut map = Map::with_capacity(2);
    map.insert("commandId", Value::from(command_id));
    map.insert("nativeId", Value::from(uuid));
    // The bridge calls `ctx[name](...args)`: one argument, the identity object.
    ace_json::to_string(&Value::from(vec![Value::Object(map)]))
}
