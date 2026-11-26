// SPDX-License-Identifier: Apache-2.0
//! One event's JSON, serialized once for everyone who weighs or sends it: the live write
//! buffer and the wire encoder see the same published event. Ports `EventEncodings` from
//! `apps/daemon/src/event-encodings.ts` and `shortDeltaJson` from
//! `packages/projection/src/short-deltas.ts`.
//!
//! The TypeScript keys its cache by object identity in a `WeakMap` and re-checks the payload
//! so that replacing an event's payload after it was sent is sent with the new payload. Here
//! an event is immutable (an `Arc` around its parsed `Value`): a replaced payload is a new
//! event, so the cache on the event cannot outlive its value. Storing may replace a payload
//! with a capped copy, as `PayloadStore.cap` does; that build makes a new `DeliveryEvent`.

use std::sync::{Arc, OnceLock};

use ace_json::{JsString, Map, Number, Value};

use crate::js::{field, field_text, number};
use crate::raw_trim::omit_raw;

/// One delivered event: the event's JSON value, with its whole and trimmed encodings made at
/// most once. Cloning shares the encodings, as one published event is shared by every
/// connection that receives it.
#[derive(Clone)]
pub struct DeliveryEvent {
    inner: Arc<Inner>,
}

struct Inner {
    value: Value,
    whole: OnceLock<String>,
    trimmed: OnceLock<Option<String>>,
    /// `wireEvent(event)`: made once for every subscriber that shares this event (an
    /// `interaction.opened` whose request goes summarized).
    wired: OnceLock<Option<DeliveryEvent>>,
}

impl std::fmt::Debug for DeliveryEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeliveryEvent")
            .field("value", &self.inner.value)
            .finish()
    }
}

impl DeliveryEvent {
    /// The event from its JSON value, in the envelope order `Event.parse` gives it
    /// (`seq`, `id`, `at`, `threadId`, `payload`, then `firstSeq`). The store's trusted reads
    /// build the envelope in that order and splice the stored payload text; normalizing here
    /// makes the bytes independent of how a caller built the tree, and an unknown top-level
    /// field is dropped as the schema drops it.
    pub fn from_value(value: Value) -> DeliveryEvent {
        DeliveryEvent {
            inner: Arc::new(Inner {
                value: canonical_envelope(value),
                whole: OnceLock::new(),
                trimmed: OnceLock::new(),
                wired: OnceLock::new(),
            }),
        }
    }

    /// The event from the JSON text its publication carries.
    pub fn parse(text: &str) -> Result<DeliveryEvent, ace_json::SyntaxError> {
        ace_json::parse(text).map(DeliveryEvent::from_value)
    }

    pub fn value(&self) -> &Value {
        &self.inner.value
    }

    /// `event.seq`.
    pub fn seq(&self) -> Option<f64> {
        field(&self.inner.value, "seq").and_then(number)
    }

    /// `event.firstSeq`.
    pub fn first_seq(&self) -> Option<f64> {
        field(&self.inner.value, "firstSeq").and_then(number)
    }

    /// `event.threadId`.
    pub fn thread_id(&self) -> Option<&JsString> {
        field_text(&self.inner.value, "threadId")
    }

    /// `event.payload.type`.
    pub fn payload_type(&self) -> Option<&JsString> {
        field(&self.inner.value, "payload").and_then(|payload| field_text(payload, "type"))
    }

    /// `wireEvent(event)`: the event clients get, made once for every subscriber that shares
    /// this event. An `interaction.opened` whose request is too large carries its summary; any
    /// other event is itself.
    pub fn wired(&self) -> DeliveryEvent {
        self.inner
            .wired
            .get_or_init(|| {
                ace_projection::wire_event(&self.inner.value).map(DeliveryEvent::from_value)
            })
            .clone()
            .unwrap_or_else(|| self.clone())
    }
}

/// `Event.parse`'s envelope order, payload spliced as it came.
fn canonical_envelope(value: Value) -> Value {
    let Value::Object(map) = value else {
        return value;
    };
    let mut out = Map::with_capacity(map.len());
    for key in ["seq", "id", "at", "threadId", "payload", "firstSeq"] {
        if let Some(found) = map.get(key) {
            out.insert(key, found.clone());
        }
    }
    Value::Object(out)
}

/// Each event's encodings. The cache lives on the immutable event, so this type has no state
/// of its own and can be shared freely, as the TypeScript's one instance per server is.
#[derive(Clone, Copy, Debug, Default)]
pub struct EventEncodings;

impl EventEncodings {
    pub const fn new() -> EventEncodings {
        EventEncodings
    }

    /// `JSON.stringify(event)`, the whole form every connection can read.
    pub fn json<'a>(&self, event: &'a DeliveryEvent) -> &'a str {
        event
            .inner
            .whole
            .get_or_init(|| ace_json::to_string(&event.inner.value))
    }

    /// `Buffer.byteLength(json(event))`.
    pub fn bytes(&self, event: &DeliveryEvent) -> usize {
        self.json(event).len()
    }

    /// The trimmed form: a delta in short form (its thread named by the message around it), an
    /// item event without the raw payloads clients only show, or the whole form for any other
    /// event.
    pub fn trimmed_json<'a>(&self, event: &'a DeliveryEvent) -> &'a str {
        let trimmed = event.inner.trimmed.get_or_init(|| trimmed_event(event));
        trimmed.as_deref().unwrap_or_else(|| self.json(event))
    }

    /// `Buffer.byteLength(trimmedJson(event))`.
    pub fn trimmed_bytes(&self, event: &DeliveryEvent) -> usize {
        self.trimmed_json(event).len()
    }
}

/// `trimmed(event)`: the short or raw-omitted form, or `None` for an event that goes whole.
fn trimmed_event(event: &DeliveryEvent) -> Option<String> {
    let payload = field(&event.inner.value, "payload")?;
    match field_text(payload, "type")?.as_str() {
        "item.delta" => short_delta_json(event),
        "item.created" | "item.updated" => {
            let item = omit_raw(field(payload, "item")?)?;
            let mut outer = match &event.inner.value {
                Value::Object(map) => map.clone(),
                _ => return None,
            };
            let mut payload = match payload {
                Value::Object(map) => map.clone(),
                _ => return None,
            };
            payload.insert("item", item);
            outer.insert("payload", Value::Object(payload));
            Some(ace_json::to_string(&Value::Object(outer)))
        }
        _ => None,
    }
}

/// `shortDeltaJson(event)`: `{"seq":…,"firstSeq"?:…,"at":…,"d":[itemId,agentId,field,append]}`.
pub fn short_delta_json(event: &DeliveryEvent) -> Option<String> {
    let payload = field(&event.inner.value, "payload")?;
    if field_text(payload, "type")? != "item.delta" {
        return None;
    }
    let seq = event.seq()?;
    let at = field(&event.inner.value, "at").and_then(number)?;
    let mut short = Map::with_capacity(4);
    short.insert("seq", Value::Number(Number::from_f64(seq)?));
    if let Some(first) = event.first_seq() {
        short.insert("firstSeq", Value::Number(Number::from_f64(first)?));
    }
    short.insert("at", Value::Number(Number::from_f64(at)?));
    let mut parts = Vec::with_capacity(4);
    for key in ["itemId", "agentId", "field", "append"] {
        parts.push(Value::String(field_text(payload, key)?.clone()));
    }
    short.insert("d", Value::Array(parts.into()));
    Some(ace_json::to_string(&Value::Object(short)))
}
