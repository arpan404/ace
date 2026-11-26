// SPDX-License-Identifier: Apache-2.0
//! The per-connection wire encoder: an events message as the bytes this connection receives.
//! Ports `WireEncoder` from `apps/daemon/src/wire-encoder.ts`, byte for byte: the same key
//! order, the same escaped strings, the same 1 MiB frames and the same short-delta envelope.

use ace_json::{JsString, Value};

use crate::event::{DeliveryEvent, EventEncodings};
use crate::js::{field, field_text, number, string, truth};

/// `eventFrameBytes`: the most event JSON one frame holds.
pub const EVENT_FRAME_BYTES: usize = 1024 * 1024;

/// What one connection's hello said it takes in place of whole events.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EventShape {
    /// Trim `raw-on-demand`: item events without the raw payloads clients only show.
    pub raw_on_demand: bool,
    /// Framing `short-deltas`: deltas in short form, their thread named once per message.
    pub short_deltas: bool,
}

/// `wholeEvents`: a connection that asked for nothing.
pub const WHOLE_EVENTS: EventShape = EventShape {
    raw_on_demand: false,
    short_deltas: false,
};

/// One `events` server message.
#[derive(Clone, Debug)]
pub struct EventsMessage {
    pub subscription_id: JsString,
    pub after_seq: f64,
    pub through_seq: f64,
    pub early: bool,
    pub events: Vec<DeliveryEvent>,
}

impl EventsMessage {
    pub fn new(subscription_id: JsString, after_seq: f64, through_seq: f64) -> EventsMessage {
        EventsMessage {
            subscription_id,
            after_seq,
            through_seq,
            early: false,
            events: Vec::new(),
        }
    }

    /// The message a publication or a test hands over as JSON.
    pub fn from_value(value: &Value) -> Option<EventsMessage> {
        if field_text(value, "type")? != "events" {
            return None;
        }
        let events = field(value, "events")?;
        let items = match events {
            Value::Array(items) => items,
            _ => return None,
        };
        Some(EventsMessage {
            subscription_id: string(field(value, "subscriptionId")?)?.clone(),
            after_seq: number(field(value, "afterSeq")?)?,
            through_seq: number(field(value, "throughSeq")?)?,
            early: field(value, "early").is_some_and(truth),
            events: items
                .iter()
                .cloned()
                .map(DeliveryEvent::from_value)
                .collect(),
        })
    }

    /// The last event's sequence, which delivery uses as the batch's head.
    pub fn last_seq(&self) -> Option<f64> {
        self.events.last().and_then(DeliveryEvent::seq)
    }
}

/// One connection's encoder. The encodings it reads live on the events themselves, so every
/// connection weighs and sends the same bytes without serializing the same event twice.
#[derive(Clone, Copy, Debug, Default)]
pub struct WireEncoder {
    encodings: EventEncodings,
}

impl WireEncoder {
    pub fn new() -> WireEncoder {
        WireEncoder::default()
    }

    pub fn with_encodings(encodings: EventEncodings) -> WireEncoder {
        WireEncoder { encodings }
    }

    pub fn encodings(&self) -> EventEncodings {
        self.encodings
    }

    /// `split(message, shape)`: the frames this connection receives, each at most
    /// `EVENT_FRAME_BYTES` of event bytes; a single larger event still travels alone.
    pub fn split(&self, message: &EventsMessage, shape: EventShape) -> Vec<EventsMessage> {
        let thread = short_thread(message, shape);
        let overhead = events_prefix(message, thread).len() + 2 + 64;
        let mut frames = Vec::new();
        let mut events: Vec<DeliveryEvent> = Vec::new();
        let mut after_seq = message.after_seq;
        let mut bytes = overhead;
        for event in &message.events {
            let size = self.sized(event, shape, thread) + 1;
            if !events.is_empty() && bytes + size > EVENT_FRAME_BYTES {
                let through_seq = events
                    .last()
                    .and_then(DeliveryEvent::seq)
                    .unwrap_or(after_seq);
                frames.push(EventsMessage {
                    after_seq,
                    through_seq,
                    events: std::mem::take(&mut events),
                    ..message.clone()
                });
                after_seq = through_seq;
                bytes = overhead;
            }
            events.push(event.clone());
            bytes += size;
        }
        frames.push(EventsMessage {
            after_seq,
            events,
            ..message.clone()
        });
        frames
    }

    /// `encode(message, shape)`: the text one frame is sent as.
    pub fn encode(&self, message: &EventsMessage, shape: EventShape) -> String {
        let thread = short_thread(message, shape);
        let mut out = events_prefix(message, thread);
        for (index, event) in message.events.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(self.event_json(event, shape, thread));
        }
        out.push_str("]}");
        out
    }

    /// `encodedBytes(message, shape)`: `encode`'s UTF-8 length, from each event's cached size.
    pub fn encoded_bytes(&self, message: &EventsMessage, shape: EventShape) -> usize {
        let thread = short_thread(message, shape);
        let mut bytes =
            events_prefix(message, thread).len() + 2 + message.events.len().saturating_sub(1);
        for event in &message.events {
            bytes += self.sized(event, shape, thread);
        }
        bytes
    }

    /// `eventBytes(event, shape)`: the UTF-8 length of the event as this connection receives
    /// it (never more than whole).
    pub fn event_bytes(&self, event: &DeliveryEvent, shape: EventShape) -> usize {
        if takes_trimmed(event, shape) {
            self.encodings.trimmed_bytes(event)
        } else {
            self.encodings.bytes(event)
        }
    }

    fn sized(&self, event: &DeliveryEvent, shape: EventShape, thread: Option<&JsString>) -> usize {
        if trimmed_here(event, shape, thread) {
            self.encodings.trimmed_bytes(event)
        } else {
            self.encodings.bytes(event)
        }
    }

    fn event_json<'a>(
        &self,
        event: &'a DeliveryEvent,
        shape: EventShape,
        thread: Option<&JsString>,
    ) -> &'a str {
        if trimmed_here(event, shape, thread) {
            self.encodings.trimmed_json(event)
        } else {
            self.encodings.json(event)
        }
    }
}

fn takes_trimmed(event: &DeliveryEvent, shape: EventShape) -> bool {
    let Some(kind) = event.payload_type() else {
        return false;
    };
    if kind == "item.delta" {
        shape.short_deltas
    } else {
        shape.raw_on_demand && (kind == "item.created" || kind == "item.updated")
    }
}

/// As `takes_trimmed`, in a message naming `thread`: a short delta of another thread goes whole.
fn trimmed_here(event: &DeliveryEvent, shape: EventShape, thread: Option<&JsString>) -> bool {
    if event
        .payload_type()
        .is_some_and(|kind| kind == "item.delta")
        && event.thread_id() != thread
    {
        return false;
    }
    takes_trimmed(event, shape)
}

/// The thread a short-deltas message names: its deltas' one thread, when the shape takes them.
/// Deltas of several threads (never on a thread subscription) all go whole, so a frame `split`
/// cuts from the message is never larger than it was weighed.
fn short_thread(message: &EventsMessage, shape: EventShape) -> Option<&JsString> {
    if !shape.short_deltas {
        return None;
    }
    let mut thread: Option<&JsString> = None;
    for event in &message.events {
        if event.payload_type().is_none_or(|kind| kind != "item.delta") {
            continue;
        }
        let Some(seen) = event.thread_id() else {
            continue;
        };
        if thread.is_some_and(|thread| thread != seen) {
            return None;
        }
        thread = Some(seen);
    }
    thread
}

/// `eventsPrefix(message, thread)`, without the events themselves.
fn events_prefix(message: &EventsMessage, thread: Option<&JsString>) -> String {
    let mut out = String::from("{\"type\":\"events\",\"subscriptionId\":");
    ace_json::write_js_string(&mut out, &message.subscription_id);
    out.push_str(",\"afterSeq\":");
    ace_json::write_number(&mut out, message.after_seq);
    out.push_str(",\"throughSeq\":");
    ace_json::write_number(&mut out, message.through_seq);
    out.push(',');
    if message.early {
        out.push_str("\"early\":true,");
    }
    if let Some(thread) = thread {
        out.push_str("\"threadId\":");
        ace_json::write_js_string(&mut out, thread);
        out.push(',');
    }
    out.push_str("\"events\":[");
    out
}
