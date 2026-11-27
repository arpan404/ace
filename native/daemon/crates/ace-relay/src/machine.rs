// SPDX-License-Identifier: Apache-2.0
//! A relayed machine stream's own mechanics (`apps/daemon/src/relay-machine-host.ts`): the welcome
//! it opens with, which calls run now, which wait, the four work slots and four urgent ones, the
//! refusal past 32 waiting, the answers, and the hosted-relay transfer policy
//! (`transfers/route-policy.ts`). The target that decides and runs a call is the machines ADR's;
//! this is the stream around it.

use ace_json::{Map, Value};

/// Calls answered at once on one stream; more wait for a free one.
pub const PARALLEL: usize = 4;
/// Urgent calls (a cancel, an answer for the person, a command stop) run beside them, up to this.
pub const URGENT: usize = 4;
/// A peer that keeps sending past this is refused rather than queued without end.
pub const WAITING: usize = 32;
/// The most bytes of a bulk payload ace's hosted relay carries (ADR 0192).
pub const HOSTED_RELAY_TRANSFER_BYTES: usize = 8 * 1024 * 1024;

/// The welcome a machine stream opens with (`relay-machine-host.ts:52`).
pub fn welcome(host_id: &str, head_seq: u64, machine_transfers: bool) -> Value {
    let mut message = Map::new();
    message.insert("type", Value::String("welcome".into()));
    message.insert("hostId", Value::String(host_id.into()));
    message.insert("protocolVersion", Value::from(1));
    message.insert("headSeq", Value::from(head_seq));
    if machine_transfers {
        message.insert("machineTransfers", Value::Bool(true));
    }
    Value::Object(message)
}

/// One answer to a call.
pub fn answer(id: u64, status: u16, body: &str) -> Value {
    let mut message = Map::new();
    message.insert("type", Value::String("machine.answer".into()));
    message.insert("id", Value::from(id));
    message.insert("status", Value::from(status));
    message.insert("body", ace_json::parse(body).unwrap_or(Value::Null));
    Value::Object(message)
}

/// The refusal a stream answers when it has no room, no device or no target.
pub fn refusal(id: u64, status: u16) -> Value {
    let error = if status == 401 {
        "unauthorized"
    } else {
        "unavailable"
    };
    let body = format!("{{\"error\":\"{error}\"}}");
    answer(id, status, &body)
}

/// A frame the stream reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Incoming {
    Ping,
    /// A machine call; `urgent` is the call's lane (a cancel or an answer for the person).
    Call {
        id: u64,
        urgent: bool,
    },
    Transfer {
        id: u64,
    },
    Cancel {
        id: u64,
    },
    /// A type this stream doesn't take (a transfer when none are offered, or anything else).
    Ignored,
}

/// What a frame is, read leniently: an unknown type is ignored, never fatal.
pub fn incoming(message: &Value, transfers_offered: bool, urgent: bool) -> Incoming {
    let Some(object) = message.as_object() else {
        return Incoming::Ignored;
    };
    let id = object.get("id").and_then(Value::as_u64);
    match object.get("type").and_then(Value::as_str) {
        Some("ping") => Incoming::Ping,
        Some("machine.call") => match id {
            Some(id) => Incoming::Call { id, urgent },
            None => Incoming::Ignored,
        },
        Some("machine.transfer") if transfers_offered => match id {
            Some(id) => Incoming::Transfer { id },
            None => Incoming::Ignored,
        },
        Some("machine.cancel") => match id {
            Some(id) => Incoming::Cancel { id },
            None => Incoming::Ignored,
        },
        _ => Incoming::Ignored,
    }
}

/// Where a call went when it arrived.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    /// Run it now; `urgent` names the pool it took.
    Run { urgent: bool },
    /// It waits for a work slot (its caller was told nothing yet).
    Wait,
    /// The stream has no room: answer 503 `unavailable`.
    Refused,
}

/// The stream's four work slots, four urgent ones and its waiting line
/// (`relay-machine-host.ts:64`-`:106`).
#[derive(Debug, Default)]
pub struct Slots {
    running: usize,
    urgent: usize,
    waiting: Vec<u64>,
}

impl Slots {
    pub fn new() -> Self {
        Self::default()
    }

    /// A call arrived: an urgent one takes an urgent slot; a work call takes a free work slot or
    /// waits; past 32 waiting the stream refuses it.
    pub fn arrive(&mut self, id: u64, urgent: bool) -> Admission {
        if urgent {
            if self.urgent >= URGENT {
                return Admission::Refused;
            }
            self.urgent += 1;
            return Admission::Run { urgent: true };
        }
        if self.running < PARALLEL {
            self.running += 1;
            return Admission::Run { urgent: false };
        }
        if self.waiting.len() >= WAITING {
            return Admission::Refused;
        }
        self.waiting.push(id);
        Admission::Wait
    }

    /// A waiting call's caller stopped waiting: it leaves the line, or (already started) hands its
    /// slot on. True when it was still waiting.
    pub fn leave_wait(&mut self, id: u64) -> bool {
        if let Some(at) = self.waiting.iter().position(|each| *each == id) {
            self.waiting.remove(at);
            true
        } else {
            false
        }
    }

    /// A call finished: a work slot goes straight to the next waiting call, or is given back.
    /// `Some(id)` is the call a work slot was handed to.
    pub fn finish(&mut self, urgent: bool) -> Option<u64> {
        if urgent {
            self.urgent = self.urgent.saturating_sub(1);
            return None;
        }
        if !self.waiting.is_empty() {
            return Some(self.waiting.remove(0));
        }
        self.running = self.running.saturating_sub(1);
        None
    }

    /// The caller stopped a call (`machine.cancel`): a running one aborts and a waiting one
    /// leaves. True when the call was known (running or waiting).
    pub fn cancel(&mut self, id: u64) -> bool {
        if self.leave_wait(id) {
            return true;
        }
        // A running call is the run's to abort; the line never holds it.
        self.running > 0
    }

    pub fn running(&self) -> usize {
        self.running
    }

    pub fn urgent(&self) -> usize {
        self.urgent
    }

    pub fn waiting(&self) -> usize {
        self.waiting.len()
    }
}

/// Whether a transfer chunk may go through ace's hosted relay: control calls and a live move's
/// final payload always may, and other bulk within the byte cap. A chunk past it belongs on a
/// direct address or the person's own relay (ADR 0192, `route-policy.ts:44`).
pub fn hosted_relay_carries(offset: usize, part: &str, bytes: usize) -> bool {
    part == "final" || offset.saturating_add(bytes) <= HOSTED_RELAY_TRANSFER_BYTES
}

/// A relay transfer frame's chunk data, base64 on the wire, decoded for the target.
pub fn transfer_chunk(data: &str) -> Option<Vec<u8>> {
    base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data.as_bytes()).ok()
}

#[cfg(test)]
mod tests;
