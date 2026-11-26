// SPDX-License-Identifier: Apache-2.0
//! The core reads a socket answers from the store in arrival order. Ports `readCore` from
//! `apps/daemon/src/socket-reads.ts`: subscriptions, pages, output reads, interactions, entity
//! and item pages, and command status. Returns `false` for a message another owner handles.
//!
//! The store reads are the shell's ([`CoreStore`]); a page and a subscription's creation need
//! the sidebar's ports, so they arrive as closures over the reader's [`Subscriptions`]. The
//! accept and reject rules, their wording and the reply sizes are this module's.

use ace_json::{JsString, Map, Number, Value};

use crate::command_lanes::CommandLanes;
use crate::command_status::command_state;
use crate::js::{field, field_text, number};
use crate::sidebar::{SidebarSubscription, ThreadListCursor};
use crate::subscription::Subscription;

/// The JSON a page of raw payloads may carry (`pageReplyBytes`).
pub const PAGE_REPLY_BYTES: usize = 64 * 1024;
/// Output bytes one `output.read` returns (`outputReadBytes`), even so a UTF-16 stream's reads
/// end on a code unit.
pub const OUTPUT_READ_BYTES: usize = 16 * 1024;
/// A socket may hold this many subscriptions.
pub const MAX_SUBSCRIPTIONS: usize = 64;

/// A read the store refused, or a page whose cursor moved on. The socket answers with the
/// wording [`read_core`] carries; the shell reports which case in a log, not on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadError;

/// `pageSubscription(...)`, as the shell's closure: it reaches the sidebar's ports.
pub type PageFn<'a> =
    dyn FnMut(&mut Subscriptions, &str, &ThreadListCursor, &str) -> Result<Value, ReadError> + 'a;

/// The creation of a checked subscription, as the shell's closure.
pub type SubscribeFn<'a> = dyn FnMut(&mut Subscriptions, &Value) -> Result<(), ReadError> + 'a;

/// One subscription as its socket holds it.
pub enum ManagedSubscription {
    Plain(Box<Subscription>),
    Window(Box<SidebarSubscription>),
}

/// Every subscription of one authenticated socket, by id.
#[derive(Default)]
pub struct Subscriptions {
    entries: std::collections::BTreeMap<String, ManagedSubscription>,
}

impl Subscriptions {
    pub fn new() -> Subscriptions {
        Subscriptions::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn contains(&self, id: &str) -> bool {
        self.entries.contains_key(id)
    }

    pub fn insert(&mut self, id: &str, subscription: ManagedSubscription) {
        self.entries.insert(id.to_owned(), subscription);
    }

    pub fn remove(&mut self, id: &str) -> Option<ManagedSubscription> {
        self.entries.remove(id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut ManagedSubscription> {
        self.entries.get_mut(id)
    }

    /// Stop every subscription (the socket is closing).
    pub fn stop_all(&mut self, store: &dyn crate::subscription::SubscriptionStore) {
        for (_, subscription) in std::mem::take(&mut self.entries) {
            stop(subscription, store);
        }
    }
}

fn stop(subscription: ManagedSubscription, store: &dyn crate::subscription::SubscriptionStore) {
    match subscription {
        ManagedSubscription::Plain(mut subscription) => subscription.stop(store),
        ManagedSubscription::Window(mut subscription) => subscription.stop(),
    }
}

/// Who a failure names, so the client can match it to its request or subscription.
#[derive(Clone, Copy, Debug, Default)]
pub struct FailScope<'a> {
    pub request_id: Option<&'a str>,
    pub subscription_id: Option<&'a str>,
}

/// What a core read needs from the store.
pub trait CoreStore {
    /// `commandReceipt(commandId, device)`.
    fn command_receipt(&self, command_id: &str, device: &str) -> Option<Value>;
    /// `outputThread(streamId)`.
    fn output_thread(&self, stream_id: &str) -> Option<String>;
    /// `readOutput(streamId, offset, limit)`: the data and the next offset.
    fn read_output(&self, stream_id: &str, offset: u64, limit: usize) -> Value;
    /// `readInteractionRequest`: `Err(code)` for an unknown or too-large request.
    fn read_interaction_request(
        &self,
        thread_id: &str,
        interaction_id: &str,
        offset: u64,
    ) -> Result<Value, String>;
    /// `readThread(threadId) !== undefined`.
    fn read_thread(&self, thread_id: &str) -> bool;
    /// `readEntityPage(threadId, collection, before, limit, maxBytes)`.
    fn read_entity_page(
        &self,
        thread_id: &str,
        collection: &str,
        before: Option<&Value>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Value, ReadError>;
    /// `readBoundedItemPage(threadId, before, limit, maxBytes)`.
    fn read_bounded_item_page(
        &self,
        thread_id: &str,
        before: Option<&Value>,
        limit: usize,
        max_bytes: usize,
    ) -> Result<Value, ReadError>;
    /// Whether a command's workspace-creation draft is still active (`workspaceActions`).
    fn creation_draft_active(&self, command_id: &str, device: &str) -> bool {
        let _ = (command_id, device);
        false
    }
}

/// Everything one core read may need.
pub struct CoreReader<'a> {
    pub store: &'a dyn CoreStore,
    pub subscription_store: &'a dyn crate::subscription::SubscriptionStore,
    pub subscriptions: &'a mut Subscriptions,
    pub device: &'a str,
    pub authorize: &'a dyn Fn(&str) -> bool,
    pub can_read_thread: Option<&'a dyn Fn(&str) -> bool>,
    pub lanes: Option<&'a CommandLanes>,
    pub replay_limit: usize,
    pub send: &'a mut dyn FnMut(Value),
    pub fail: &'a mut dyn FnMut(&str, &str, bool, FailScope<'_>),
    pub page: &'a mut PageFn<'a>,
    pub subscribe: &'a mut SubscribeFn<'a>,
}

fn can_read(reader: &CoreReader<'_>, thread: &str) -> bool {
    reader
        .can_read_thread
        .is_none_or(|can_read| can_read(thread))
}

/// `readCore(message, reader)`: true when this module answered (or refused) the message.
pub fn read_core(message: &Value, reader: &mut CoreReader<'_>) -> bool {
    let Some(kind) = field_text(message, "type").map(JsString::as_str) else {
        return false;
    };
    match kind {
        "threads.page" => page(message, reader),
        "command.status" => command_status(message, reader),
        "unsubscribe" => {
            if let Some(id) = field_text(message, "subscriptionId").map(JsString::as_str)
                && let Some(subscription) = reader.subscriptions.remove(id)
            {
                stop(subscription, reader.subscription_store);
            }
        }
        "subscribe" => subscribe(message, reader),
        "output.read" => output_read(message, reader),
        "interaction.read" => interaction_read(message, reader),
        "entities.page" => entities_page(message, reader),
        "items.page" => items_page(message, reader),
        _ => return false,
    }
    true
}

fn page(message: &Value, reader: &mut CoreReader<'_>) {
    let subscription_id = field_text(message, "subscriptionId").map(JsString::as_str);
    let request_id = field_text(message, "requestId").map(JsString::as_str);
    let before = field(message, "before").and_then(ThreadListCursor::from_value);
    let usable = match (subscription_id, request_id, before) {
        (Some(id), Some(request), Some(before))
            if (reader.authorize)("read") && reader.subscriptions.contains(id) =>
        {
            Some((id, request, before))
        }
        _ => None,
    };
    let Some((subscription_id, request_id, before)) = usable else {
        (reader.fail)(
            "page_failed",
            "Unable to load this page; retry or refresh the list",
            false,
            FailScope {
                request_id: request_id.or(subscription_id),
                subscription_id,
            },
        );
        return;
    };
    match (reader.page)(reader.subscriptions, subscription_id, &before, request_id) {
        Ok(frame) => (reader.send)(frame),
        Err(ReadError) => (reader.fail)(
            "page_failed",
            "Unable to load this page; retry or refresh the list",
            false,
            FailScope {
                request_id: Some(request_id),
                subscription_id: None,
            },
        ),
    }
}

fn command_status(message: &Value, reader: &mut CoreReader<'_>) {
    let request_id = field_text(message, "requestId").map(JsString::as_str);
    let mut commands = Vec::new();
    for command in field(message, "commands")
        .and_then(|commands| match commands {
            Value::Array(items) => Some(items.as_slice()),
            _ => None,
        })
        .unwrap_or(&[])
    {
        let Some(command_id) = field_text(command, "commandId") else {
            continue;
        };
        let receipt = (reader.store).command_receipt(command_id.as_str(), reader.device);
        let in_flight = reader
            .lanes
            .is_some_and(|lanes| lanes.running(reader.device, command_id.as_str()))
            || (reader.store).creation_draft_active(command_id.as_str(), reader.device);
        let state = command_state(command_id, receipt.as_ref(), in_flight);
        if let Some(result) = state.result {
            let mut out = Map::with_capacity(4);
            out.insert("type", Value::String(JsString::from("commandResult")));
            if let Value::Object(fields) = result {
                for (key, value) in fields {
                    out.insert(key.clone(), value.clone());
                }
            }
            (reader.send)(Value::Object(out));
        }
        let mut entry = Map::with_capacity(2);
        entry.insert("commandId", Value::String(command_id.clone()));
        entry.insert("state", Value::String(JsString::from(state.state.as_str())));
        commands.push(Value::Object(entry));
    }
    let mut out = Map::with_capacity(3);
    out.insert("type", Value::String(JsString::from("command.status")));
    if let Some(request_id) = request_id {
        out.insert("requestId", Value::String(JsString::from(request_id)));
    }
    out.insert("commands", Value::Array(commands.into()));
    (reader.send)(Value::Object(out));
}

fn subscribe(message: &Value, reader: &mut CoreReader<'_>) {
    let Some(subscription_id) = field_text(message, "subscriptionId").map(JsString::as_str) else {
        return;
    };
    let fail = |reader: &mut CoreReader<'_>, code: &str, wording: &str| {
        (reader.fail)(
            code,
            wording,
            false,
            FailScope {
                request_id: None,
                subscription_id: Some(subscription_id),
            },
        );
    };
    if !(reader.authorize)("read") {
        return fail(reader, "forbidden", "Read scope required");
    }
    // A repeat id replaces the subscription it names.
    if let Some(subscription) = reader.subscriptions.remove(subscription_id) {
        stop(subscription, reader.subscription_store);
    }
    if reader.subscriptions.len() >= MAX_SUBSCRIPTIONS {
        return fail(reader, "subscription_limit", "Too many subscriptions");
    }
    let thread = field(message, "scope").and_then(|scope| {
        if field_text(scope, "kind").is_some_and(|kind| kind == "thread") {
            field_text(scope, "threadId").map(JsString::as_str)
        } else {
            None
        }
    });
    if let Some(thread) = thread
        && !can_read(reader, thread)
    {
        return fail(reader, "read_denied", "Thread is not readable");
    }
    if (reader.subscribe)(reader.subscriptions, message).is_err() {
        fail(
            reader,
            "subscribe_failed",
            "Unknown thread or invalid cursor",
        );
    }
}

fn output_read(message: &Value, reader: &mut CoreReader<'_>) {
    let request_id = field_text(message, "requestId").map(JsString::as_str);
    let stream = field_text(message, "streamId").map(JsString::as_str);
    if !(reader.authorize)("read") {
        (reader.fail)(
            "forbidden",
            "Read scope required",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        );
        return;
    }
    let readable = stream.is_some_and(|stream| {
        (reader.store)
            .output_thread(stream)
            .is_some_and(|thread| can_read(reader, &thread))
    });
    let Some(stream) = stream.filter(|_| readable) else {
        (reader.fail)(
            "read_denied",
            "Output stream is not readable",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        );
        return;
    };
    let offset = field(message, "offset").and_then(number).unwrap_or(0.0) as u64;
    let limit = field(message, "limit").and_then(number).unwrap_or(0.0) as usize;
    let data = (reader.store).read_output(stream, offset, limit.min(OUTPUT_READ_BYTES));
    let mut out = Map::with_capacity(5);
    out.insert("type", Value::String(JsString::from("output.data")));
    if let Some(request_id) = request_id {
        out.insert("requestId", Value::String(JsString::from(request_id)));
    }
    out.insert("streamId", Value::String(JsString::from(stream)));
    out.insert("offset", Value::Number(Number::from(offset)));
    if let Value::Object(fields) = data {
        for (key, value) in fields {
            out.insert(key, value);
        }
    }
    (reader.send)(Value::Object(out));
}

fn interaction_read(message: &Value, reader: &mut CoreReader<'_>) {
    let request_id = field_text(message, "requestId").map(JsString::as_str);
    let thread = field_text(message, "threadId").map(JsString::as_str);
    let interaction = field_text(message, "interactionId").map(JsString::as_str);
    let readable =
        thread.is_some_and(|thread| (reader.authorize)("read") && can_read(reader, thread));
    let (Some(thread), Some(interaction)) = (thread.filter(|_| readable), interaction) else {
        (reader.fail)(
            "read_denied",
            "Thread is not readable",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        );
        return;
    };
    let offset = field(message, "offset").and_then(number).unwrap_or(0.0) as u64;
    match (reader.store).read_interaction_request(thread, interaction, offset) {
        Ok(page) => {
            let mut out = Map::with_capacity(5);
            out.insert("type", Value::String(JsString::from("interaction.data")));
            if let Some(request_id) = request_id {
                out.insert("requestId", Value::String(JsString::from(request_id)));
            }
            out.insert("threadId", Value::String(JsString::from(thread)));
            out.insert("interactionId", Value::String(JsString::from(interaction)));
            if let Value::Object(fields) = page {
                for (key, value) in fields {
                    out.insert(key, value);
                }
            }
            (reader.send)(Value::Object(out));
        }
        Err(code) => {
            let wording = if code == "interaction_not_found" {
                "This thread has no such request"
            } else {
                "This request came from another machine too large to read whole here"
            };
            (reader.fail)(
                &code,
                wording,
                false,
                FailScope {
                    request_id,
                    subscription_id: None,
                },
            );
        }
    }
}

fn entities_page(message: &Value, reader: &mut CoreReader<'_>) {
    let request_id = field_text(message, "requestId").map(JsString::as_str);
    let thread = field_text(message, "threadId").map(JsString::as_str);
    let readable = thread.is_some_and(|thread| {
        (reader.authorize)("read") && (reader.store).read_thread(thread) && can_read(reader, thread)
    });
    let Some(thread) = thread.filter(|_| readable) else {
        (reader.fail)(
            "read_denied",
            "Thread is not readable",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        );
        return;
    };
    let collection = field_text(message, "collection")
        .map(JsString::as_str)
        .unwrap_or("");
    let before = field(message, "before");
    let limit = field(message, "limit").and_then(number).unwrap_or(0.0) as usize;
    let max_bytes = field(message, "maxBytes").and_then(number).unwrap_or(0.0) as usize;
    match (reader.store).read_entity_page(thread, collection, before, limit, max_bytes) {
        Ok(page) => {
            let mut out = Map::with_capacity(3);
            out.insert("type", Value::String(JsString::from("entities.page")));
            if let Some(request_id) = request_id {
                out.insert("requestId", Value::String(JsString::from(request_id)));
            }
            out.insert("page", page);
            (reader.send)(Value::Object(out));
        }
        Err(ReadError) => (reader.fail)(
            "page_failed",
            "Could not read entity page",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        ),
    }
}

fn items_page(message: &Value, reader: &mut CoreReader<'_>) {
    let request_id = field_text(message, "requestId").map(JsString::as_str);
    let thread = field_text(message, "threadId").map(JsString::as_str);
    if !(reader.authorize)("read") {
        (reader.fail)(
            "forbidden",
            "Read scope required",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        );
        return;
    }
    let readable =
        thread.is_some_and(|thread| (reader.store).read_thread(thread) && can_read(reader, thread));
    let Some(thread) = thread.filter(|_| readable) else {
        (reader.fail)(
            "read_denied",
            "Thread is not readable",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        );
        return;
    };
    let before = field(message, "before");
    let limit = field(message, "limit").and_then(number).unwrap_or(0.0) as usize;
    // An item larger than the page arrives reduced or summarized, never as a failed page.
    let envelope = item_page_envelope(request_id, thread);
    let max_bytes = (1024_usize * 1024)
        .saturating_sub(envelope.len())
        .saturating_sub(128);
    match (reader.store).read_bounded_item_page(thread, before, limit, max_bytes) {
        Ok(page) => {
            let mut out = Map::with_capacity(3);
            out.insert("type", Value::String(JsString::from("items.page")));
            if let Some(request_id) = request_id {
                out.insert("requestId", Value::String(JsString::from(request_id)));
            }
            if let Value::Object(fields) = page {
                for (key, value) in fields {
                    out.insert(key, value);
                }
            }
            (reader.send)(Value::Object(out));
        }
        Err(ReadError) => (reader.fail)(
            "read_denied",
            "Invalid item cursor",
            false,
            FailScope {
                request_id,
                subscription_id: None,
            },
        ),
    }
}

/// `JSON.stringify({type:"items.page", requestId, threadId})`, the bytes a page's envelope costs.
fn item_page_envelope(request_id: Option<&str>, thread_id: &str) -> String {
    let mut envelope = Map::with_capacity(3);
    envelope.insert("type", Value::String(JsString::from("items.page")));
    if let Some(request_id) = request_id {
        envelope.insert("requestId", Value::String(JsString::from(request_id)));
    }
    envelope.insert("threadId", Value::String(JsString::from(thread_id)));
    ace_json::to_string(&Value::Object(envelope))
}
