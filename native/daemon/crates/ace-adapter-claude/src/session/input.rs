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

struct Record {
    after: After,
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
    pub(crate) fn push(&mut self, wire: Vec<u8>, after: After) -> Effect {
        if matches!(after, After::Input(_)) {
            self.inputs += 1;
        }
        self.records.push_back(Record { after });
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

    /// The port refused the write just returned: it may not have reached the CLI.
    pub(crate) fn refused(&mut self) -> Vec<Effect> {
        let Some(record) = self.records.pop_back() else {
            return Vec::new();
        };
        if matches!(record.after, After::Input(_)) {
            self.inputs = self.inputs.saturating_sub(1);
        }
        self.failed = Some(STDIN_CLOSED.to_owned());
        vec![Effect::Fatal {
            message: STDIN_CLOSED.to_owned(),
        }]
    }

    /// The port failed: no later write reaches the CLI.
    pub(crate) fn error(&mut self, message: &str) -> Vec<Effect> {
        self.records.clear();
        self.inputs = 0;
        self.failed = Some(message.to_owned());
        vec![Effect::Fatal {
            message: message.to_owned(),
        }]
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
        if self.finished {
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
            effects.push(self.writes.push(wire, After::Input(captured)));
        }
        Ok(effects)
    }

    /// One write reached the port.
    pub fn stdin_written(&mut self) -> Vec<Effect> {
        self.writes.written()
    }

    /// The port failed; its message is the session's failure text.
    pub fn stdin_error(&mut self, message: &str) -> Vec<Effect> {
        self.writes.error(message)
    }

    /// The port refused the write just returned (`pushed > 0` makes this uncertain).
    pub fn write_refused(&mut self) -> Vec<Effect> {
        self.writes.refused()
    }
}

/// `{commandId, nativeId}` (`session.ts:409`).
fn input_message(command_id: &str, uuid: &str) -> String {
    let mut map = Map::with_capacity(2);
    map.insert("commandId", Value::from(command_id));
    map.insert("nativeId", Value::from(uuid));
    ace_json::to_string(&Value::Object(map))
}
