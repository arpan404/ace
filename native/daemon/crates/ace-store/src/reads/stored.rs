// SPDX-License-Identifier: Apache-2.0
//! The lenient decode of stored rows (T4a, ADR 0226 §4 item 3): rows this build wrote are read as
//! stored, older rows are decoded the way the TypeScript's `stored-decode.ts` decodes them.
//!
//! Ports `decodeStoredPayload`, `decodeStoredItem`, `storedPayload`, `storedItem`,
//! `storedEvent`, `decodeStoredEntity` and `storedEntity`. The shape table
//! (`ace_protocol::shapes`) says what Zod's parse keeps of a value: field order, stripped
//! unknowns and defaults. A transform's output can't be described by the table, so the legacy
//! transforms the stored data reaches are applied here (`recommendation: "delegate_task"`).
//! Nothing here validates types: a row that Zod would reject decodes as its shape, a recorded
//! difference covered by the fixtures over the trust tests' samples.

use std::collections::BTreeSet;

use ace_json::{JsString, Map, Number, Value};
use ace_projection::{strip, strip_object};
use ace_protocol::shape::Shape;
use ace_protocol::shapes::{EVENT, STORED_ITEM};

/// Which stored rows are read as stored, as `stored-shape.ts` tracks it: rows from `from` on are
/// trusted, except the sequences in `rejected` that the idle pass found the validating decode
/// would change. Nothing is trusted until an open sets it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Trust {
    pub from: u64,
    pub rejected: BTreeSet<u64>,
}

/// Trust in no row (until open sets it).
pub fn untrusted() -> Trust {
    Trust {
        from: u64::MAX,
        rejected: BTreeSet::new(),
    }
}

/// Trust in every row from `from` on.
pub fn trusted_from(from: u64) -> Trust {
    Trust {
        from,
        rejected: BTreeSet::new(),
    }
}

impl Trust {
    /// `isTrusted(trust, seq)`.
    pub fn is_trusted(&self, seq: u64) -> bool {
        seq >= self.from && !self.rejected.contains(&seq)
    }
}

/// A row that is not an object with a string `type` (the TypeScript's `tagged.parse` throws).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodeError;

fn object(value: &Value) -> Result<&Map, DecodeError> {
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(DecodeError),
    }
}

fn type_of(value: &Value) -> Result<String, DecodeError> {
    match object(value)?.get("type") {
        Some(Value::String(kind)) => Ok(kind.as_str().to_owned()),
        _ => Err(DecodeError),
    }
}

fn tagged(shape: &Shape) -> Option<(&str, &[(&'static str, Shape)])> {
    match shape {
        Shape::Tagged { key, options } => Some((key, options)),
        _ => None,
    }
}

/// The option a union takes for `tag`, as the table prints literals (`"\"item.created\""`).
fn option_for<'a>(shape: &'a Shape, tag: &str) -> Option<&'a Shape> {
    let (_, options) = tagged(shape)?;
    let printed = ace_json::to_string(&Value::String(JsString::from(tag)));
    options
        .iter()
        .find(|(literal, _)| *literal == printed)
        .map(|(_, option)| option)
}

/// The shape of `Event.payload`.
fn payload_shape() -> &'static Shape {
    match &EVENT {
        Shape::Object(fields) => fields
            .iter()
            .find(|field| field.key == "payload")
            .map(|field| &field.shape)
            .unwrap_or_else(|| unreachable_shape()),
        // The generated table's EVENT root is an object.
        _ => unreachable_shape(),
    }
}

/// The shape of `Item` (the table walks it through the object that holds one).
fn item_shape() -> &'static Shape {
    match &STORED_ITEM {
        Shape::Object(fields) => fields
            .iter()
            .find(|field| field.key == "item")
            .map(|field| &field.shape)
            .unwrap_or_else(|| unreachable_shape()),
        _ => unreachable_shape(),
    }
}

fn unreachable_shape() -> ! {
    panic!("ace-protocol's shape table has no T4 root");
}

/// `decodeStoredItem(value)`: a known item as Zod parses it, an unknown kind as `unknown` with
/// the original value kept in `data` (and the base fields' defaults).
pub fn decode_item(value: &Value) -> Result<Value, DecodeError> {
    let kind = type_of(value)?;
    if let Some(shape) = option_for(item_shape(), &kind) {
        return Ok(strip(shape, value));
    }
    let unknown = option_for(item_shape(), "unknown").ok_or(DecodeError)?;
    // `Item.parse({ ...input, type: "unknown", raw: [], data: value })`.
    let mut rebuilt = object(value)?.clone();
    rebuilt.insert("type", Value::String(JsString::from("unknown")));
    rebuilt.insert("raw", Value::Array(Vec::new().into()));
    rebuilt.insert("data", value.clone());
    Ok(strip(unknown, &Value::Object(rebuilt)))
}

/// `decodeStoredPayload(value)`: a known event payload as Zod parses it, an unknown type as
/// `unknown` with the original value kept in `raw`.
pub fn decode_payload(value: &Value) -> Result<Value, DecodeError> {
    let kind = type_of(value)?;
    if kind == "item.created" || kind == "item.updated" {
        let item = object(value)?.get("item").ok_or(DecodeError)?;
        let decoded = decode_item(item)?;
        let mut rebuilt = object(value)?.clone();
        rebuilt.insert("item", decoded);
        let shape = option_for(payload_shape(), &kind).ok_or(DecodeError)?;
        return Ok(apply_legacy_transforms(strip(
            shape,
            &Value::Object(rebuilt),
        )));
    }
    if let Some(shape) = option_for(payload_shape(), &kind) {
        return Ok(apply_legacy_transforms(strip(shape, value)));
    }
    let unknown = option_for(payload_shape(), "unknown").ok_or(DecodeError)?;
    let mut rebuilt = Map::with_capacity(2);
    rebuilt.insert("type", Value::String(JsString::from("unknown")));
    rebuilt.insert("raw", value.clone());
    Ok(strip(unknown, &Value::Object(rebuilt)))
}

/// A stored payload by its row's sequence: trusted rows are JSON-parse only, others decoded.
pub fn stored_payload(seq: u64, json: &str, trust: &Trust) -> Result<Value, DecodeError> {
    let value = ace_json::parse(json).map_err(|_| DecodeError)?;
    if trust.is_trusted(seq) {
        return Ok(value);
    }
    decode_payload(&value)
}

/// A stored item by the sequence its body was written at (`storedItem`).
pub fn stored_item(created_seq: u64, json: &str, trust: &Trust) -> Result<Value, DecodeError> {
    let value = ace_json::parse(json).map_err(|_| DecodeError)?;
    if trust.is_trusted(created_seq) {
        return Ok(value);
    }
    decode_item(&value)
}

/// An `events` row, as a read has it.
#[derive(Debug, Clone, Copy)]
pub struct EventRow<'a> {
    pub seq: u64,
    pub id: &'a str,
    pub thread_id: &'a str,
    pub at: f64,
    pub payload: &'a str,
}

/// `storedEvent(row, trust)`: the event and the UTF-8 bytes of its JSON. A trusted row is
/// rebuilt in the schema's order from its columns and stored payload text, so its size is the
/// stored text plus the envelope, without serialising it again; another row is decoded.
pub fn stored_event(row: EventRow<'_>, trust: &Trust) -> Result<(Value, usize), DecodeError> {
    let payload = stored_payload(row.seq, row.payload, trust)?;
    if !trust.is_trusted(row.seq) {
        let event = event_value(row, payload);
        let bytes = ace_json::to_string(&event).len();
        return Ok((event, bytes));
    }
    let mut envelope = String::from("{\"seq\":");
    ace_json::write_number(&mut envelope, row.seq as f64);
    envelope.push_str(",\"id\":");
    ace_json::write_js_string(&mut envelope, &JsString::from(row.id));
    envelope.push_str(",\"at\":");
    ace_json::write_number(&mut envelope, row.at);
    envelope.push_str(",\"threadId\":");
    ace_json::write_js_string(&mut envelope, &JsString::from(row.thread_id));
    envelope.push_str(",\"payload\":}");
    Ok((
        event_value(row, payload),
        row.payload.len() + envelope.len(),
    ))
}

fn event_value(row: EventRow<'_>, payload: Value) -> Value {
    let mut event = Map::with_capacity(5);
    event.insert("seq", Value::Number(Number::from(row.seq)));
    event.insert("id", Value::String(JsString::from(row.id)));
    event.insert(
        "at",
        Value::Number(Number::from_f64(row.at).unwrap_or_else(zero)),
    );
    event.insert("threadId", Value::String(JsString::from(row.thread_id)));
    event.insert("payload", payload);
    Value::Object(event)
}

fn zero() -> Number {
    Number::from(0_u64)
}

/// A `view_entities` collection's schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntityKind {
    Agent,
    Run,
    Interaction,
    BackgroundTask,
    Usage,
    ContextMeter,
    Queue,
}

impl EntityKind {
    fn shape(self) -> &'static Shape {
        use ace_protocol::shapes::{
            AGENT, BACKGROUND_TASK, CONTEXT_METER, INTERACTION, QUEUE_STATE, RUN, USAGE_UPDATED,
        };
        match self {
            EntityKind::Agent => &AGENT,
            EntityKind::Run => &RUN,
            EntityKind::Interaction => &INTERACTION,
            EntityKind::BackgroundTask => &BACKGROUND_TASK,
            EntityKind::Usage => &USAGE_UPDATED,
            EntityKind::ContextMeter => &CONTEXT_METER,
            EntityKind::Queue => &QUEUE_STATE,
        }
    }
}

/// `decodeStoredEntity(collection, value)`: the collection's schema parse, defaults included.
pub fn decode_entity(kind: EntityKind, value: &Value) -> Value {
    let shape = kind.shape();
    match shape {
        // The generated roots are objects, so a stored entity is one too.
        Shape::Object(fields) | Shape::Open(fields) => match value {
            Value::Object(map) => Value::Object(strip_object(fields, map)),
            _ => value.clone(),
        },
        shape => strip(shape, value),
    }
}

/// `storedEntity(collection, json, trust)`: trusted rows are JSON-parse only.
pub fn stored_entity(kind: EntityKind, json: &str, trusted: bool) -> Result<Value, DecodeError> {
    let value = ace_json::parse(json).map_err(|_| DecodeError)?;
    if trusted {
        return Ok(value);
    }
    Ok(decode_entity(kind, &value))
}

/// The legacy transforms a stored payload still needs: the TypeScript schema's own, whose
/// output the shape table can't describe. `SwitchRecommendation` reads the pre-rename
/// `delegate_task` as `delegate`.
fn apply_legacy_transforms(payload: Value) -> Value {
    let Value::Object(mut map) = payload else {
        return payload;
    };
    if let Some(Value::Object(switch)) = map.remove("switch") {
        let mut switch = switch;
        fix_recommendation(&mut switch);
        map.insert("switch", Value::Object(switch));
    }
    if let Some(Value::Object(thread)) = map.remove("thread") {
        let mut thread = thread;
        if let Some(Value::Object(switch)) = thread.remove("switch") {
            let mut switch = switch;
            fix_recommendation(&mut switch);
            thread.insert("switch", Value::Object(switch));
        }
        map.insert("thread", Value::Object(thread));
    }
    Value::Object(map)
}

fn fix_recommendation(switch: &mut Map) {
    if switch.get("recommendation").and_then(|value| match value {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    }) == Some("delegate_task")
    {
        switch.insert("recommendation", Value::String(JsString::from("delegate")));
    }
}
