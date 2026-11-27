// SPDX-License-Identifier: Apache-2.0
//! Per-socket outbound delivery queue, backpressure admission, delta coalescing, large-message
//! fragmentation, and frame packing (`apps/daemon/src/outbox.ts`).
//!
//! Pure core over an injected [`OutboxSocket`] boundary and clock (`now_ms`):
//! - Enforces `soft_limit` (pause feeding transport), `hard_limit` + `hard_timeout_ms` (resync
//!   slow consumers with close code `4009`), and `max_queued_bytes` (shared admission cap across
//!   pending queue, held packed frames, and socket `buffered_amount`).
//! - Coalesces contiguous `item.delta` events on the same item/agent/field up to 65,536 UTF-16
//!   code units while the transport is congested (`buffered_amount > soft_limit`).
//! - Streams `snapshot` and `entities.page` payloads larger than 1 MiB as 131,072-UTF-16-unit
//!   `snapshot.part` / `entities.page.part` fragments, bounding retained stream sources at 4
//!   concurrent streams and 64 MiB total.
//! - Integrates [`FrameHolder`] and [`LinkEstimate`] when `pack_frames` is enabled (`framing:
//!   ["lines"]`), flushing held frames before uncompressed messages or direct service writes.

use std::collections::VecDeque;

use ace_json::{JsString, Map, Number, Value};

use crate::compression::may_compress;
use crate::encode::{EVENT_FRAME_BYTES, EventShape, EventsMessage, WHOLE_EVENTS, WireEncoder};
use crate::event::DeliveryEvent;
use crate::frame_holder::{FrameHolder, LinkEstimate, may_hold_events};
use crate::js::{field, field_text, number};
use crate::liveness::ReadyState;

/// Close code asking a congested client to reconnect with its last `afterSeq`.
pub const RESYNC_CLOSE_CODE: u16 = 4009;
pub const RESYNC_CLOSE_REASON: &str = "Reconnect with afterSeq";
/// Service envelopes can contain a 1 MiB artifact plus metadata. Events use [`EVENT_FRAME_BYTES`].
pub const REPLY_FRAME_BYTES: usize = EVENT_FRAME_BYTES * 2;
/// Maximum retained UTF-16 source bytes across active fragment streams (64 MiB).
pub const MAX_STREAM_SOURCE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum concurrent fragment streams per socket.
pub const MAX_STREAM_SOURCES: usize = 4;
/// Maximum UTF-16 code units per `snapshot.part` / `entities.page.part` fragment.
pub const STREAM_FRAGMENT_UTF16_UNITS: usize = 131_072;
/// Maximum UTF-16 code units in a coalesced `item.delta` `append` payload.
pub const COALESCE_MAX_UTF16_UNITS: usize = 65_536;

/// Outbox backpressure thresholds (`PressureOptions`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PressureOptions {
    pub soft_limit: usize,
    /// Sustained transport pressure threshold; not the absolute memory admission cap.
    pub hard_limit: usize,
    /// Absolute queued + held + transport byte cap, shared by every outbound frame type.
    pub max_queued_bytes: usize,
    pub hard_timeout_ms: u64,
}

impl Default for PressureOptions {
    fn default() -> Self {
        Self {
            soft_limit: 256 * 1024,
            hard_limit: 4 * 1024 * 1024,
            max_queued_bytes: 4 * 1024 * 1024,
            hard_timeout_ms: 5_000,
        }
    }
}

/// The socket seam an [`Outbox`] drives (`MainSocket` subset).
pub trait OutboxSocket {
    fn ready_state(&self) -> ReadyState;
    fn buffered_amount(&self) -> usize;
    fn send(&mut self, text: String, compress: bool);
    fn close(&mut self, code: u16, reason: &str);
}

/// Coalesce contiguous `item.delta` events on the same thread/item/agent/field up to 65,536
/// UTF-16 code units (`coalesceEvents` in `outbox.ts:30`).
pub fn coalesce_events(events: &[DeliveryEvent]) -> Vec<DeliveryEvent> {
    let mut result = Vec::with_capacity(events.len());
    append_coalesced(&mut result, events);
    result
}

/// Append `events` onto `result`, coalescing adjacent compatible `item.delta` events in place.
pub fn append_coalesced(result: &mut Vec<DeliveryEvent>, events: &[DeliveryEvent]) {
    for event in events {
        if let Some(last) = result.last()
            && let Some(merged) = try_merge_delta(last, event)
        {
            if let Some(slot) = result.last_mut() {
                *slot = merged;
            }
            continue;
        }
        result.push(event.clone());
    }
}

fn try_merge_delta(last: &DeliveryEvent, next: &DeliveryEvent) -> Option<DeliveryEvent> {
    if last.payload_type()?.as_str() != "item.delta"
        || next.payload_type()?.as_str() != "item.delta"
    {
        return None;
    }
    let last_seq = last.seq()?;
    let next_start = next.first_seq().unwrap_or(next.seq()?);
    if last_seq + 1.0 != next_start {
        return None;
    }
    if last.thread_id() != next.thread_id() {
        return None;
    }
    let lp = field(last.value(), "payload")?;
    let np = field(next.value(), "payload")?;
    if field(lp, "itemId") != field(np, "itemId")
        || field(lp, "agentId") != field(np, "agentId")
        || field(lp, "field") != field(np, "field")
    {
        return None;
    }
    let last_append = field_text(lp, "append")?;
    let next_append = field_text(np, "append")?;
    if last_append.len_utf16() + next_append.len_utf16() > COALESCE_MAX_UTF16_UNITS {
        return None;
    }
    let mut merged_payload = match np {
        Value::Object(map) => map.clone(),
        _ => return None,
    };
    let mut combined = String::with_capacity(last_append.len() + next_append.len());
    combined.push_str(last_append.as_str());
    combined.push_str(next_append.as_str());
    merged_payload.insert("append", Value::String(JsString::from(combined.as_str())));

    let mut merged_event = match next.value() {
        Value::Object(map) => map.clone(),
        _ => return None,
    };
    let first_seq = last.first_seq().unwrap_or(last_seq);
    merged_event.insert(
        "firstSeq",
        Value::Number(Number::from_f64(first_seq).unwrap_or(Number::from(0_u64))),
    );
    merged_event.insert("payload", Value::Object(merged_payload));
    Some(DeliveryEvent::from_value(Value::Object(merged_event)))
}

#[derive(Clone, Debug)]
struct EventBatch {
    charged_bytes: usize,
    subscription_id: JsString,
    after_seq: f64,
    through_seq: f64,
    early: bool,
    events: Vec<DeliveryEvent>,
}

#[derive(Clone, Debug)]
struct SerializedFrame {
    charged_bytes: usize,
    encoded: String,
    compress: bool,
    hold: bool,
}

#[derive(Clone, Debug)]
enum StreamHeader {
    Snapshot {
        subscription_id: JsString,
        seq: f64,
    },
    EntitiesPage {
        request_id: JsString,
        thread_id: JsString,
        seq: f64,
    },
}

#[derive(Clone, Debug)]
struct FragmentStream {
    encoded_utf16_len: usize,
    source_bytes: usize,
    encoded: String,
    byte_offset: usize,
    utf16_offset: usize,
    header: StreamHeader,
    index: u64,
}

#[derive(Clone, Debug)]
enum PendingFrame {
    Events(EventBatch),
    Serialized(SerializedFrame),
    Stream(FragmentStream),
}

impl PendingFrame {
    fn charged_bytes(&self) -> usize {
        match self {
            Self::Events(batch) => batch.charged_bytes,
            Self::Serialized(frame) => frame.charged_bytes,
            Self::Stream(_) => 0,
        }
    }
}

/// One socket's outbound delivery queue (`Outbox` in `apps/daemon/src/outbox.ts`).
pub struct Outbox {
    pending: VecDeque<PendingFrame>,
    stream_sources: usize,
    source_bytes: usize,
    bytes: usize,
    above_hard_since: Option<u64>,
    options: PressureOptions,
    encoder: WireEncoder,
    shape: EventShape,
    holder: Option<FrameHolder>,
    link: Option<LinkEstimate>,
}

impl Outbox {
    pub fn new(options: PressureOptions, encoder: WireEncoder) -> Self {
        Self {
            pending: VecDeque::new(),
            stream_sources: 0,
            source_bytes: 0,
            bytes: 0,
            above_hard_since: None,
            options,
            encoder,
            shape: WHOLE_EVENTS,
            holder: None,
            link: None,
        }
    }

    pub fn queued_bytes(&self) -> usize {
        self.bytes
    }

    pub fn held_bytes(&self) -> usize {
        self.holder.as_ref().map_or(0, FrameHolder::bytes)
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    /// Next deadline at which a held packed frame should flush, if any.
    pub fn hold_due_ms(&self) -> Option<u64> {
        self.holder.as_ref().and_then(FrameHolder::due_ms)
    }

    /// Link estimate for this socket once `pack_frames` is enabled.
    pub fn link_estimate(&self) -> Option<&LinkEstimate> {
        self.link.as_ref()
    }

    /// Set the negotiated wire event shape (`trims` / `short-deltas`).
    pub fn shape_events(&mut self, shape: EventShape) {
        self.shape = shape;
    }

    /// Enable newline-delimited frame packing (`framing: ["lines"]`).
    pub fn pack_frames(&mut self, remote: bool) {
        if self.holder.is_some() {
            return;
        }
        self.link = Some(LinkEstimate::new(remote));
        self.holder = Some(FrameHolder::new());
    }

    /// Flush any held packed frames now (e.g., before an ordered service write bypasses outbox).
    pub fn release_held(&mut self, socket: &mut dyn OutboxSocket) {
        if let Some(frame) = self.holder.as_mut().and_then(FrameHolder::release) {
            self.transmit(frame, true, socket);
        }
    }

    /// Send an `events` server message, splitting into 1 MiB frames first.
    pub fn send_events(
        &mut self,
        message: &EventsMessage,
        now_ms: u64,
        socket: &mut dyn OutboxSocket,
    ) {
        if socket.ready_state() != ReadyState::Open {
            return;
        }
        for frame in self.encoder.split(message, self.shape) {
            self.send_events_frame(&frame, now_ms, socket);
        }
    }

    /// Send any non-`events` server message (`snapshot`, `entities.page`, replies, errors, etc.).
    pub fn send_value(&mut self, message: &Value, now_ms: u64, socket: &mut dyn OutboxSocket) {
        if socket.ready_state() != ReadyState::Open {
            return;
        }
        let msg_type = field_text(message, "type")
            .map(JsString::as_str)
            .unwrap_or("");
        if msg_type == "events" {
            if let Some(events) = EventsMessage::from_value(message) {
                self.send_events(&events, now_ms, socket);
            }
            return;
        }
        let encoded = ace_json::to_string(message);
        let bytes = encoded.len();
        if (msg_type == "snapshot" || msg_type == "entities.page") && bytes > EVENT_FRAME_BYTES {
            let encoded_utf16_len = encoded.encode_utf16().count();
            let source_bytes = encoded_utf16_len.saturating_mul(2);
            if source_bytes > MAX_STREAM_SOURCE_BYTES && msg_type == "entities.page" {
                let mut err = Map::with_capacity(4);
                err.insert("type", Value::String(JsString::from("error")));
                err.insert(
                    "code",
                    Value::String(JsString::from("entity_page_too_large")),
                );
                err.insert(
                    "message",
                    Value::String(JsString::from(
                        "Entity page exceeds the 64 MiB retained-text budget",
                    )),
                );
                if let Some(req_id) = field_text(message, "requestId") {
                    err.insert("requestId", Value::String(req_id.clone()));
                }
                let err_val = Value::Object(err);
                let err_encoded = ace_json::to_string(&err_val);
                let err_len = err_encoded.len();
                self.send_serialized("error", err_encoded, err_len, false, now_ms, socket);
                return;
            }
            if self.stream_sources >= MAX_STREAM_SOURCES
                || self.source_bytes.saturating_add(source_bytes) > MAX_STREAM_SOURCE_BYTES
            {
                self.resync(socket);
                return;
            }
            let Some(header) = stream_header(msg_type, message) else {
                self.resync(socket);
                return;
            };
            self.stream_sources += 1;
            self.source_bytes += source_bytes;
            self.pending.push_back(PendingFrame::Stream(FragmentStream {
                encoded_utf16_len,
                source_bytes,
                encoded,
                byte_offset: 0,
                utf16_offset: 0,
                header,
                index: 0,
            }));
            self.flush(now_ms, socket);
            self.tick(now_ms, socket);
            return;
        }
        self.send_serialized(msg_type, encoded, bytes, false, now_ms, socket);
    }

    fn send_events_frame(
        &mut self,
        message: &EventsMessage,
        now_ms: u64,
        socket: &mut dyn OutboxSocket,
    ) {
        if socket.ready_state() != ReadyState::Open {
            return;
        }
        if socket.buffered_amount() > self.options.soft_limit {
            let charge = self.encoder.encoded_bytes(message, self.shape);
            if charge > EVENT_FRAME_BYTES {
                self.resync(socket);
                return;
            }
            if !self.admit(charge, socket) {
                return;
            }
            let can_coalesce = matches!(
                self.pending.back(),
                Some(PendingFrame::Events(last))
                    if last.subscription_id == message.subscription_id
                        && last.through_seq == message.after_seq
                        && last.early == message.early
                        && last.charged_bytes.saturating_add(charge) <= EVENT_FRAME_BYTES
            );
            if can_coalesce && let Some(PendingFrame::Events(last)) = self.pending.back_mut() {
                append_coalesced(&mut last.events, &message.events);
                last.through_seq = message.through_seq;
                last.charged_bytes += charge;
            } else {
                self.pending.push_back(PendingFrame::Events(EventBatch {
                    charged_bytes: charge,
                    subscription_id: message.subscription_id.clone(),
                    after_seq: message.after_seq,
                    through_seq: message.through_seq,
                    early: message.early,
                    events: coalesce_events(&message.events),
                }));
            }
            self.bytes += charge;
            self.tick(now_ms, socket);
            return;
        }
        let encoded = self.encoder.encode(message, self.shape);
        let charge = encoded.len();
        let hold = may_hold_events(&message.events);
        self.send_serialized("events", encoded, charge, hold, now_ms, socket);
    }

    fn send_serialized(
        &mut self,
        msg_type: &str,
        encoded: String,
        charge: usize,
        hold: bool,
        now_ms: u64,
        socket: &mut dyn OutboxSocket,
    ) {
        if socket.ready_state() != ReadyState::Open {
            return;
        }
        let limit = if msg_type == "events" {
            EVENT_FRAME_BYTES
        } else {
            REPLY_FRAME_BYTES
        };
        if charge > limit {
            self.resync(socket);
            return;
        }
        if !self.admit(charge, socket) {
            return;
        }
        self.pending
            .push_back(PendingFrame::Serialized(SerializedFrame {
                charged_bytes: charge,
                encoded,
                compress: may_compress(msg_type),
                hold,
            }));
        self.bytes += charge;
        self.flush(now_ms, socket);
        self.tick(now_ms, socket);
    }

    fn admit(&mut self, bytes: usize, socket: &mut dyn OutboxSocket) -> bool {
        let held = self.held_bytes();
        let total = self
            .bytes
            .saturating_add(held)
            .saturating_add(socket.buffered_amount())
            .saturating_add(bytes);
        if total <= self.options.max_queued_bytes {
            return true;
        }
        self.resync(socket);
        false
    }

    /// Flush queued frames while the socket is open and below `soft_limit`. Call this when a
    /// transport send completes or `buffered_amount` drains.
    pub fn flush(&mut self, now_ms: u64, socket: &mut dyn OutboxSocket) {
        while !self.pending.is_empty()
            && socket.ready_state() == ReadyState::Open
            && socket.buffered_amount() <= self.options.soft_limit
        {
            let is_stream = matches!(self.pending.front(), Some(PendingFrame::Stream(_)));
            let (encoded, bytes, compress, hold) = if is_stream {
                let Some(PendingFrame::Stream(stream)) = self.pending.front_mut() else {
                    break;
                };
                let (chunk, done) = next_utf16_slice(
                    &stream.encoded,
                    &mut stream.byte_offset,
                    &mut stream.utf16_offset,
                    stream.encoded_utf16_len,
                    STREAM_FRAGMENT_UTF16_UNITS,
                );
                let index = stream.index;
                stream.index += 1;
                let frame_value = build_part_frame(&stream.header, index, done, chunk);
                let encoded = ace_json::to_string(&frame_value);
                let bytes = encoded.len();
                if done {
                    let source_bytes = stream.source_bytes;
                    self.pending.pop_front();
                    self.stream_sources = self.stream_sources.saturating_sub(1);
                    self.source_bytes = self.source_bytes.saturating_sub(source_bytes);
                }
                (encoded, bytes, true, false)
            } else {
                let Some(frame) = self.pending.pop_front() else {
                    break;
                };
                self.bytes = self.bytes.saturating_sub(frame.charged_bytes());
                match frame {
                    PendingFrame::Serialized(frame) => (
                        frame.encoded,
                        frame.charged_bytes,
                        frame.compress,
                        frame.hold,
                    ),
                    PendingFrame::Events(batch) => {
                        let hold = may_hold_events(&batch.events);
                        let msg = EventsMessage {
                            subscription_id: batch.subscription_id,
                            after_seq: batch.after_seq,
                            through_seq: batch.through_seq,
                            early: batch.early,
                            events: batch.events,
                        };
                        let encoded = self.encoder.encode(&msg, self.shape);
                        let bytes = encoded.len();
                        (encoded, bytes, true, hold)
                    }
                    PendingFrame::Stream(_) => unreachable!(),
                }
            };
            if bytes > REPLY_FRAME_BYTES {
                self.resync(socket);
                return;
            }
            if !self.admit(bytes, socket) {
                return;
            }
            if self.holder.is_none() {
                self.transmit(encoded, compress, socket);
            } else if compress {
                let hold_ms = self
                    .link
                    .map_or(crate::frame_holder::FRAME_HOLD_MS, |link| {
                        link.hold_ms(socket.buffered_amount())
                    });
                let frames = self
                    .holder
                    .as_mut()
                    .map(|holder| holder.add(encoded, bytes, hold, now_ms, hold_ms))
                    .unwrap_or_default();
                for frame in frames {
                    self.transmit(frame, true, socket);
                }
            } else {
                self.release_held(socket);
                self.transmit(encoded, false, socket);
            }
        }
    }

    /// Periodic pressure check and hold-deadline flush.
    pub fn tick(&mut self, now_ms: u64, socket: &mut dyn OutboxSocket) {
        if let Some(frame) = self.holder.as_mut().and_then(|h| h.flush_due(now_ms)) {
            self.transmit(frame, true, socket);
        }
        if socket.buffered_amount() > self.options.hard_limit {
            let since = *self.above_hard_since.get_or_insert(now_ms);
            if now_ms.saturating_sub(since) >= self.options.hard_timeout_ms {
                self.resync(socket);
                return;
            }
        } else {
            self.above_hard_since = None;
        }
        if socket.buffered_amount() <= self.options.soft_limit {
            self.flush(now_ms, socket);
        }
    }

    fn transmit(&mut self, encoded: String, compress: bool, socket: &mut dyn OutboxSocket) {
        if socket.ready_state() != ReadyState::Open {
            return;
        }
        socket.send(encoded, compress);
        if let Some(link) = self.link.as_mut() {
            link.sample(socket.buffered_amount());
        }
    }

    fn resync(&mut self, socket: &mut dyn OutboxSocket) {
        self.clear();
        socket.close(RESYNC_CLOSE_CODE, RESYNC_CLOSE_REASON);
    }

    /// Drop all queued and held frames without closing the socket.
    pub fn clear(&mut self) {
        if let Some(holder) = self.holder.as_mut() {
            holder.clear();
        }
        self.pending.clear();
        self.bytes = 0;
        self.stream_sources = 0;
        self.source_bytes = 0;
        self.above_hard_since = None;
    }
}

fn stream_header(msg_type: &str, message: &Value) -> Option<StreamHeader> {
    if msg_type == "snapshot" {
        Some(StreamHeader::Snapshot {
            subscription_id: field_text(message, "subscriptionId")?.clone(),
            seq: number(field(message, "seq")?)?,
        })
    } else if msg_type == "entities.page" {
        let page = field(message, "page")?;
        Some(StreamHeader::EntitiesPage {
            request_id: field_text(message, "requestId")?.clone(),
            thread_id: field_text(page, "threadId")?.clone(),
            seq: number(field(page, "seq")?)?,
        })
    } else {
        None
    }
}

fn build_part_frame(header: &StreamHeader, index: u64, done: bool, data: &str) -> Value {
    let mut map = Map::with_capacity(7);
    match header {
        StreamHeader::Snapshot {
            subscription_id,
            seq,
        } => {
            map.insert("type", Value::String(JsString::from("snapshot.part")));
            map.insert("subscriptionId", Value::String(subscription_id.clone()));
            map.insert(
                "seq",
                Value::Number(Number::from_f64(*seq).unwrap_or(Number::from(0_u64))),
            );
        }
        StreamHeader::EntitiesPage {
            request_id,
            thread_id,
            seq,
        } => {
            map.insert("type", Value::String(JsString::from("entities.page.part")));
            map.insert("requestId", Value::String(request_id.clone()));
            map.insert("threadId", Value::String(thread_id.clone()));
            map.insert(
                "seq",
                Value::Number(Number::from_f64(*seq).unwrap_or(Number::from(0_u64))),
            );
        }
    }
    map.insert("index", Value::Number(Number::from(index)));
    map.insert("done", Value::Bool(done));
    map.insert("data", Value::String(JsString::from(data)));
    Value::Object(map)
}

/// Slice up to `max_utf16` UTF-16 code units from `text` starting at `*byte_offset`. Keeps whole
/// UTF-8 scalar values so a surrogate pair is never split mid-character.
fn next_utf16_slice<'a>(
    text: &'a str,
    byte_offset: &mut usize,
    utf16_offset: &mut usize,
    total_utf16: usize,
    max_utf16: usize,
) -> (&'a str, bool) {
    let start = *byte_offset;
    let mut used = 0;
    let mut end = start;
    for ch in text[start..].chars() {
        let w = ch.len_utf16();
        if used > 0 && used + w > max_utf16 {
            break;
        }
        used += w;
        end += ch.len_utf8();
    }
    *byte_offset = end;
    *utf16_offset += used;
    let done = end >= text.len() || *utf16_offset >= total_utf16;
    (&text[start..end], done)
}
