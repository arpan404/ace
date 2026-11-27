// SPDX-License-Identifier: Apache-2.0
//! What the daemon sends one connection, given the trims its hello asked for. Ports
//! `WireTrimmer` and `WireRestorer` from `packages/projection/src/wire-trim.ts`, with
//! `thread-list-sharing.ts`'s snapshot dictionary.
//!
//! Every change keeps the object key order JavaScript's spread gives it: a replaced field keeps
//! its place, a removed one leaves none, a new one is appended. `outgoing` takes the message
//! because one connection's copy is its own; the frames it returns are the bytes the encoder
//! sends, so `tests/trim_vectors.rs` compares them byte for byte with the TypeScript's.

use std::collections::HashMap;

use ace_json::{Array, JsString, Map, Number, Value};

use crate::js::{field, field_array, field_text, field_truth, number, object, string};
use crate::older_status::older_statuses;

/// The trims a hello can ask for (`wireTrims` in the TypeScript).
pub const TRIM_SPADE_HIDDEN: &str = "spade-hidden";
pub const TRIM_ITEM_DEFAULTS: &str = "item-defaults";
pub const TRIM_PROVIDER_CAPABILITIES: &str = "provider-capabilities";
pub const TRIM_SIDEBAR_SHARED: &str = "sidebar-shared";
pub const TRIM_RAW_ON_DEMAND: &str = "raw-on-demand";
pub const TRIM_STORAGE_HOLD: &str = "storage-hold";
pub const TRIM_MOVED_STATUS: &str = "moved-status";

/// Every trim this build can undo, as a client lists them in its hello.
pub const SUPPORTED_TRIMS: [&str; 7] = [
    TRIM_SPADE_HIDDEN,
    TRIM_ITEM_DEFAULTS,
    TRIM_PROVIDER_CAPABILITIES,
    TRIM_SIDEBAR_SHARED,
    TRIM_RAW_ON_DEMAND,
    TRIM_STORAGE_HOLD,
    TRIM_MOVED_STATUS,
];

/// More distinct capability sets than this on one connection are sent whole, not keyed.
const MAX_CAPABILITY_KEYS: usize = 64;
/// More distinct shared values than this in one thread list are sent whole.
const MAX_SHARED_VALUES: usize = 64;

/// What one connection asked for.
#[derive(Debug, Default)]
pub struct WireTrimmer {
    hidden: bool,
    items: bool,
    capabilities: bool,
    sidebar: bool,
    raw: bool,
    storage: bool,
    moved: bool,
    keys: HashMap<String, String>,
}

impl WireTrimmer {
    /// `new WireTrimmer(trims)`: an unknown trim changes nothing, as it changes nothing there.
    pub fn new(trims: Option<&[&str]>) -> WireTrimmer {
        let has = |wanted: &str| trims.is_some_and(|trims| trims.contains(&wanted));
        WireTrimmer {
            hidden: has(TRIM_SPADE_HIDDEN),
            items: has(TRIM_ITEM_DEFAULTS),
            capabilities: has(TRIM_PROVIDER_CAPABILITIES),
            sidebar: has(TRIM_SIDEBAR_SHARED),
            raw: has(TRIM_RAW_ON_DEMAND),
            storage: has(TRIM_STORAGE_HOLD),
            moved: has(TRIM_MOVED_STATUS),
            keys: HashMap::new(),
        }
    }

    /// `outgoing(message)`: the frames this connection receives, any capability it now needs
    /// taught first.
    pub fn outgoing(&mut self, mut message: Value) -> Vec<Value> {
        if !self.hidden {
            self.older_hidden(&mut message);
        }
        if !self.storage {
            self.older_admission(&mut message);
        }
        if !self.moved {
            older_statuses(&mut message);
        }
        if !self.items && !self.capabilities && !self.sidebar && !self.raw {
            return vec![message];
        }
        let mut before = Vec::new();
        let trimmed = self.trim(message, &mut before);
        before.push(trimmed);
        before
    }

    /// `outgoing` for a caller that keeps the message it shares with other connections.
    pub fn outgoing_cloned(&mut self, message: &Value) -> Vec<Value> {
        self.outgoing(message.clone())
    }

    /// `!hidden`: the hidden Spade code and live-end reason read as `unavailable`.
    fn older_hidden(&self, message: &mut Value) {
        let Some(map) = object_mut(message) else {
            return;
        };
        let kind = map
            .get("type")
            .and_then(string)
            .map(JsString::as_str)
            .map(str::to_owned);
        match kind.as_deref() {
            Some("spade.live.ended")
                if map
                    .get("reason")
                    .and_then(string)
                    .is_some_and(|reason| reason == "hidden") =>
            {
                map.insert("reason", Value::String(JsString::from("unavailable")));
            }
            Some("spade.http.result") => {
                let Some(result) = map.get_mut("result") else {
                    return;
                };
                if field_text(result, "kind").is_some_and(|kind| kind == "error")
                    && field_text(result, "code").is_some_and(|code| code == "hidden")
                    && let Some(result) = object_mut(result)
                {
                    result.insert("code", Value::String(JsString::from("unavailable")));
                }
            }
            _ => {}
        }
    }

    /// `!storage`: the `storage` hold reads as the person's own pause for an older reader.
    fn older_admission(&self, message: &mut Value) {
        let Some(map) = object_mut(message) else {
            return;
        };
        let kind = map
            .get("type")
            .and_then(string)
            .map(JsString::as_str)
            .map(str::to_owned);
        match kind.as_deref() {
            Some("admission.changed") => {
                if let Some(admission) = map.get_mut("admission") {
                    replace_admission(admission);
                }
            }
            Some("admission.result") => {
                if let Some(admission) = map.get_mut("admission")
                    && !matches!(admission, Value::Null)
                {
                    replace_admission(admission);
                }
            }
            _ => {}
        }
    }

    fn trim(&mut self, mut message: Value, before: &mut Vec<Value>) -> Value {
        let Some(kind) = field_text(&message, "type").map(JsString::as_str) else {
            return message;
        };
        match kind {
            "snapshot" => {
                let Some(map) = object_mut(&mut message) else {
                    return message;
                };
                let Some(view) = map.get_mut("view") else {
                    return message;
                };
                let threads = field_text(view, "kind").is_some_and(|kind| kind == "threads");
                let Some(view_map) = object_mut(view) else {
                    return message;
                };
                if !threads {
                    if let Some(thread) = view_map.get_mut("thread") {
                        *thread = self.thread(std::mem::take(thread), before);
                    }
                    if (self.items || self.raw)
                        && let Some(Value::Object(items)) = view_map.get_mut("items")
                    {
                        for (_, item) in items.iter_mut() {
                            *item = self.item(std::mem::take(item));
                        }
                    }
                    return message;
                }
                let Some(threads) = view_map.get_mut("threads") else {
                    return message;
                };
                map_record(threads, |entry| {
                    *entry = self.thread(std::mem::take(entry), before);
                });
                if self.sidebar {
                    let shaped = share_thread_list(view_map);
                    if let Value::Object(shaped) = shaped {
                        *view_map = shaped;
                    }
                }
                message
            }
            "threads.patch" => {
                if let Some(threads) = object_field_mut(&mut message, "threads") {
                    map_record(threads, |entry| {
                        *entry = self.thread(std::mem::take(entry), before);
                    });
                }
                message
            }
            "items.page" | "items.window" => {
                if self.items || self.raw {
                    map_array_field(&mut message, "items", |item| {
                        *item = self.item(std::mem::take(item));
                    });
                }
                message
            }
            "turn.steps" => {
                if self.items || self.raw {
                    map_array_field(&mut message, "steps", |step| {
                        if let Some(item) = object_field_mut(step, "item") {
                            *item = self.item(std::mem::take(item));
                        }
                    });
                }
                message
            }
            _ => message,
        }
    }

    /// `#item`: the item as this connection receives it.
    fn item(&self, item: Value) -> Value {
        let kept = if self.raw {
            crate::raw_trim::omit_raw(&item).unwrap_or(item)
        } else {
            item
        };
        if self.items { trim_item(&kept) } else { kept }
    }

    /// `#thread`: a thread naming its provider capabilities by a key sent once per connection.
    fn thread(&mut self, mut thread: Value, before: &mut Vec<Value>) -> Value {
        if !self.capabilities {
            return thread;
        }
        let Some(capabilities) = field(&thread, "capabilities") else {
            return thread;
        };
        let text = ace_json::to_string(capabilities);
        let known = self.keys.get(&text).cloned();
        let key = if let Some(key) = known {
            key
        } else {
            if self.keys.len() >= MAX_CAPABILITY_KEYS {
                return thread;
            }
            let key = format!("c{}", self.keys.len() + 1);
            self.keys.insert(text, key.clone());
            before.push(capability_frame(&key, capabilities));
            key
        };
        if let Some(map) = object_mut(&mut thread) {
            map.remove("capabilities");
            map.insert("capabilitiesRef", Value::String(JsString::from(key)));
        }
        thread
    }
}

/// `{ type: "provider.capabilities", key, capabilities }`.
fn capability_frame(key: &str, capabilities: &Value) -> Value {
    let mut frame = Map::with_capacity(3);
    frame.insert(
        "type",
        Value::String(JsString::from("provider.capabilities")),
    );
    frame.insert("key", Value::String(JsString::from(key)));
    frame.insert("capabilities", capabilities.clone());
    Value::Object(frame)
}

/// `trimItem(item)`: an item without the fields a reader's schema fills back in.
pub fn trim_item(item: &Value) -> Value {
    let Some(map) = object(item) else {
        return item.clone();
    };
    let mut copy = map.clone();
    if field_truth(item, "complete") {
        copy.remove("complete");
    }
    if field(item, "synthetic").is_some_and(|seen| matches!(seen, Value::Bool(false))) {
        copy.remove("synthetic");
    }
    if field_array(item, "raw").is_empty() && matches!(field(item, "raw"), Some(Value::Array(_))) {
        copy.remove("raw");
    }
    Value::Object(copy)
}

/// `olderAdmission(admission)`: a `storage` hold reads as the person's own pause, once.
fn replace_admission(admission: &mut Value) {
    let Some(map) = object_mut(admission) else {
        return;
    };
    let Some(holds) = map.get("holds").and_then(|holds| match holds {
        Value::Array(items) => Some(items),
        _ => None,
    }) else {
        return;
    };
    if !holds
        .iter()
        .any(|hold| string(hold).is_some_and(|hold| hold == "storage"))
    {
        return;
    }
    let mut seen: Vec<&str> = Vec::new();
    let mut older = Vec::with_capacity(holds.len());
    for hold in holds.iter() {
        let Some(hold) = string(hold) else {
            continue;
        };
        let hold = if hold == "storage" {
            "user"
        } else {
            hold.as_str()
        };
        if seen.contains(&hold) {
            continue;
        }
        seen.push(hold);
        older.push(Value::String(JsString::from(hold)));
    }
    map.insert("holds", Value::Array(older.into()));
}

/// `mapRecord`: each own value of a record, in place.
fn map_record(record: &mut Value, mut change: impl FnMut(&mut Value)) {
    if let Value::Object(map) = record {
        for (_, entry) in map.iter_mut() {
            change(entry);
        }
    }
}

/// `mapList`: each item of an array field, in place.
fn map_array_field(value: &mut Value, key: &str, mut change: impl FnMut(&mut Value)) {
    if let Some(items) = object_field_mut(value, key)
        && let Value::Array(items) = items
    {
        for item in items.iter_mut() {
            change(item);
        }
    }
}

fn object_mut(value: &mut Value) -> Option<&mut Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

fn object_field_mut<'a>(value: &'a mut Value, key: &str) -> Option<&'a mut Value> {
    object_mut(value)?.get_mut(key)
}

/// `shareThreadList(view)`: exact workspace and effective capability values shared by index.
pub fn share_thread_list(view: &mut Map) -> Value {
    let Some(Value::Object(threads)) = view.get("threads") else {
        return Value::Object(view.clone());
    };
    if threads.len() < 2 {
        return Value::Object(view.clone());
    }
    let mut workspaces = SharedValues::new();
    let mut capabilities = SharedValues::new();
    let mut rows = Map::new();
    let mut shaped = Map::with_capacity(threads.len());
    for (id, entry) in threads.iter() {
        let workspace = entry
            .get("details")
            .and_then(|details| details.get("workspace"))
            .and_then(|workspace| workspaces.save(workspace));
        let capability = entry
            .get("effectiveCapabilities")
            .and_then(|value| capabilities.save(value));
        if workspace.is_none() && capability.is_none() {
            shaped.insert(id, entry.clone());
            continue;
        }
        let mut copy = match entry {
            Value::Object(map) => map.clone(),
            _ => {
                shaped.insert(id, entry.clone());
                continue;
            }
        };
        if workspace.is_some()
            && let Some(Value::Object(details)) = copy.get_mut("details")
        {
            let mut details = details.clone();
            details.remove("workspace");
            copy.insert("details", Value::Object(details));
        }
        if capability.is_some() {
            copy.remove("effectiveCapabilities");
        }
        let mut refs = Map::with_capacity(2);
        if let Some(index) = workspace {
            refs.insert("workspace", Value::Number(Number::from(index as u64)));
        }
        if let Some(index) = capability {
            refs.insert("capabilities", Value::Number(Number::from(index as u64)));
        }
        rows.insert(id, Value::Object(refs));
        shaped.insert(id, Value::Object(copy));
    }
    if rows.is_empty() {
        return Value::Object(view.clone());
    }
    let mut out = view.clone();
    out.insert("threads", Value::Object(shaped));
    let mut shares = Map::with_capacity(3);
    shares.insert("workspaces", Value::Array(workspaces.values.into()));
    shares.insert(
        "effectiveCapabilities",
        Value::Array(capabilities.values.into()),
    );
    shares.insert("rows", Value::Object(rows));
    out.insert("shares", Value::Object(shares));
    Value::Object(out)
}

struct SharedValues {
    values: Vec<Value>,
    indices: HashMap<String, usize>,
}

impl SharedValues {
    fn new() -> SharedValues {
        SharedValues {
            values: Vec::new(),
            indices: HashMap::new(),
        }
    }

    /// `save(value)`: the value's index, or `None` past the bound (the row keeps its data).
    fn save(&mut self, value: &Value) -> Option<usize> {
        let text = ace_json::to_string(value);
        if let Some(index) = self.indices.get(&text) {
            return Some(*index);
        }
        if self.values.len() >= MAX_SHARED_VALUES {
            return None;
        }
        let index = self.values.len();
        self.indices.insert(text, index);
        self.values.push(value.clone());
        Some(index)
    }
}

/// `restoreThreadList(view)`: independent rows again, as an ordinary snapshot would carry.
pub fn restore_thread_list(view: &mut Map) {
    let Some(Value::Object(shares)) = view.remove("shares") else {
        return;
    };
    let workspaces = match shares.get("workspaces") {
        Some(Value::Array(items)) => Some(items.clone()),
        _ => None,
    };
    let capabilities = match shares.get("effectiveCapabilities") {
        Some(Value::Array(items)) => Some(items.clone()),
        _ => None,
    };
    let Some(Value::Object(rows)) = shares.get("rows").cloned() else {
        return;
    };
    for (id, refs) in rows.iter() {
        let Some(entry) = view
            .get_mut("threads")
            .and_then(object_mut)
            .and_then(|threads| threads.get_mut(id))
        else {
            continue;
        };
        let workspace = index_value(workspaces.as_ref(), refs.get("workspace"));
        let capability = index_value(capabilities.as_ref(), refs.get("capabilities"));
        if let (Some(workspace), Some(map)) = (workspace, object_mut(entry)) {
            let mut details = match map.get("details") {
                Some(Value::Object(details)) => details.clone(),
                _ => Map::new(),
            };
            details.insert("workspace", workspace.clone());
            map.insert("details", Value::Object(details));
        }
        if let (Some(capability), Some(map)) = (capability, object_mut(entry)) {
            map.insert("effectiveCapabilities", capability.clone());
        }
    }
}

fn index_value<'a>(values: Option<&'a Array>, index: Option<&Value>) -> Option<&'a Value> {
    let index = number(index?)?;
    if index < 0.0 {
        return None;
    }
    values?.get(index as usize)
}

/// What a client does with the trimmed messages of its connection. Ports `WireRestorer`.
#[derive(Clone, Debug, Default)]
pub struct WireRestorer {
    capabilities: HashMap<String, Value>,
}

impl WireRestorer {
    pub fn new() -> WireRestorer {
        WireRestorer::default()
    }

    /// The message with every trimmed thread whole again, or `None` for a message that only
    /// taught this restorer a key.
    pub fn restore(&mut self, mut message: Value) -> Option<Value> {
        match field_text(&message, "type").map(JsString::as_str) {
            Some("provider.capabilities") => {
                if let (Some(key), Some(capabilities)) =
                    (field_text(&message, "key"), field(&message, "capabilities"))
                {
                    self.capabilities
                        .insert(key.as_str().to_owned(), capabilities.clone());
                }
                None
            }
            Some("snapshot") => {
                let Some(map) = object_mut(&mut message) else {
                    return Some(message);
                };
                let Some(view) = map.get_mut("view") else {
                    return Some(message);
                };
                if field_text(view, "kind").is_some_and(|kind| kind == "threads") {
                    if let Some(view) = object_mut(view) {
                        restore_thread_list(view);
                        if let Some(Value::Object(threads)) = view.get_mut("threads") {
                            for (_, entry) in threads.iter_mut() {
                                self.thread(entry);
                            }
                        }
                    }
                } else if let Some(thread) = object_field_mut(view, "thread") {
                    self.thread(thread);
                }
                Some(message)
            }
            Some("threads.patch") => {
                if let Some(threads) = object_field_mut(&mut message, "threads")
                    && let Value::Object(threads) = threads
                {
                    for (_, entry) in threads.iter_mut() {
                        self.thread(entry);
                    }
                }
                Some(message)
            }
            _ => Some(message),
        }
    }

    fn thread(&self, thread: &mut Value) {
        let Some(map) = object_mut(thread) else {
            return;
        };
        let Some(key) = map.get("capabilitiesRef") else {
            return;
        };
        let Some(key) = string(key).map(JsString::as_str) else {
            return;
        };
        let found = self.capabilities.get(key).cloned();
        map.remove("capabilitiesRef");
        if let Some(capabilities) = found {
            map.insert("capabilities", capabilities);
        }
    }
}
