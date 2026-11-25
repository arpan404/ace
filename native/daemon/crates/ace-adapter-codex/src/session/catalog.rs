// SPDX-License-Identifier: Apache-2.0
//! Codex's optional metadata surfaces (`extension-catalog.ts`): the skills, app
//! and MCP-server lists, refreshed in coalesced reads and published as
//! `catalog.runtime` notes. A frame only these APIs send is optional: it may be
//! left out without losing a question, while execution frames keep strict
//! admission.

use ace_json::{Map, Value};
use indexmap::{IndexMap, IndexSet};

use super::frames::{Effect, FrameDir};
use super::state::Session;

/// The requests whose replies an optional surface owns.
const REQUESTS: [&str; 3] = ["skills/list", "app/list", "mcpServerStatus/list"];
/// The notifications that only ever announce an optional surface.
const NOTIFICATIONS: [&str; 3] = ["skills/changed", "app/list/updated", "mcpServer/updated"];
/// As many pending catalog requests as the RPC's own pending bound.
const REQUESTS_MAX: usize = 256;
/// The channel its notes travel on.
const CHANNEL: &str = "catalog.runtime";
/// How many pages one read asks for.
const PAGES: u32 = 6;
/// How many entries one surface keeps.
const ENTRIES: usize = 512;
/// One read's deadline (`{ timeoutMs: 5000 }`).
const READ_MS: f64 = 5_000.0;

/// `optionalCatalogFrames`: which sent requests name an optional surface, and
/// which received frames only it could have sent.
#[derive(Default)]
pub struct OptionalFrames {
    requests: IndexMap<String, String>,
}

impl OptionalFrames {
    /// `method(direction, data)`: the catalog method a frame is optional for,
    /// when it is one. A sent request is remembered; its reply gives the method
    /// back once.
    pub fn method(&mut self, dir: FrameDir, data: &Value) -> Option<String> {
        let id = data.get("id");
        let method = data.get("method").and_then(Value::as_str);
        if dir == FrameDir::Send {
            if let Some(method) = method.filter(|method| REQUESTS.contains(method)) {
                // Match the RPC pending-request bound, including expired
                // requests awaiting late replies.
                if self.requests.len() >= REQUESTS_MAX {
                    self.requests.shift_remove_index(0);
                }
                self.requests.insert(id_key(id), method.to_owned());
            }
            return None;
        }
        if let Some(method) = method {
            return (id.is_none() && NOTIFICATIONS.contains(&method)).then(|| method.to_owned());
        }
        self.requests.shift_remove(&id_key(id))
    }

    pub fn clear(&mut self) {
        self.requests.clear();
    }
}

/// The key a request id is remembered by: its JS-exact JSON, so `"1"` and `1`
/// stay apart.
fn id_key(id: Option<&Value>) -> String {
    id.map(ace_json::to_string)
        .unwrap_or_else(|| "undefined".to_owned())
}

/// One surface's read in flight.
struct Read {
    method: String,
    call: u64,
    /// The publication generation this read started under.
    version: u64,
    data: Vec<Value>,
    cursor: Option<String>,
    pages: u32,
}

/// The extension catalog's own state: what is being read, what still needs a
/// re-read, and what the last published snapshot was.
#[derive(Default)]
pub(crate) struct ExtensionCatalog {
    /// The session's cwd; the skills request carries it.
    pub(crate) cwd: String,
    running: IndexMap<String, Read>,
    dirty: IndexSet<String>,
    published: IndexMap<String, String>,
    pushed: IndexMap<String, u64>,
}

impl ExtensionCatalog {
    pub(crate) fn new(cwd: String) -> ExtensionCatalog {
        ExtensionCatalog {
            cwd,
            ..ExtensionCatalog::default()
        }
    }

    pub(crate) fn clear(&mut self) {
        self.running.clear();
        self.dirty.clear();
    }
}

impl Session {
    /// `optionalFrames.method(dir, data)`: the catalog method a frame is
    /// optional for, when it is one. The shell asks before the frame is emitted.
    pub fn optional_frame(&mut self, dir: FrameDir, data: &Value) -> Option<String> {
        self.optional_frames.method(dir, data)
    }

    /// `catalog.start()`: the three surfaces, read once each.
    pub fn catalog_start(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        for method in REQUESTS {
            effects.extend(self.catalog_refresh(method));
        }
        effects
    }

    /// `catalog.changed(method, params)`: a pushed list, or a surface to re-read.
    pub(crate) fn catalog_changed(&mut self, method: &str, params: Option<&Value>) -> Vec<Effect> {
        if method == "app/list/updated" {
            let Some(data) = params
                .and_then(|params| params.get("data"))
                .and_then(Value::as_array)
            else {
                return Vec::new();
            };
            let data: Vec<Value> = data.iter().take(ENTRIES).cloned().collect();
            let pushed = self
                .catalog
                .pushed
                .entry("app/list".to_owned())
                .or_insert(0);
            *pushed += 1;
            return self.publish("app/list", &data);
        }
        let surface = match method {
            "skills/changed" => "skills/list",
            "mcpServer/updated" => "mcpServerStatus/list",
            _ => return Vec::new(),
        };
        self.catalog_refresh(surface)
    }

    /// One catalog reply: the next page, the publication, or the re-read an
    /// invalidation during the read asked for.
    pub(crate) fn catalog_settled(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Option<Vec<Effect>> {
        let method = self
            .catalog
            .running
            .iter()
            .find(|(_, read)| read.call == call)
            .map(|(method, _)| method.clone())?;
        let mut read = self.catalog.running.shift_remove(&method)?;
        let body = match reply {
            Ok(result) => result.as_object().cloned().unwrap_or_default(),
            // An optional API preserves the last successful snapshot when it is
            // unavailable.
            Err(_) => return Some(self.catalog_finish(read, None)),
        };
        let Some(data) = body.get("data").and_then(Value::as_array) else {
            return Some(self.catalog_finish(read, None));
        };
        let room = ENTRIES.saturating_sub(read.data.len());
        read.data.extend(data.iter().take(room).cloned());
        let cursor = body
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|cursor| !cursor.is_empty())
            .map(|cursor| cursor.to_owned());
        match cursor {
            Some(cursor) if read.data.len() < ENTRIES && read.pages + 1 < PAGES => {
                read.cursor = Some(cursor);
                read.pages += 1;
                let effect = self.catalog_page(&method, &mut read);
                self.catalog.running.insert(method, read);
                Some(effect)
            }
            _ => {
                let data = std::mem::take(&mut read.data);
                Some(self.catalog_finish(read, Some(data)))
            }
        }
    }

    /// One surface's read, or a mark that it needs another once the running one
    /// lands.
    fn catalog_refresh(&mut self, method: &str) -> Vec<Effect> {
        if self.catalog.running.contains_key(method) {
            self.catalog.dirty.insert(method.to_owned());
            return Vec::new();
        }
        if self.is_closed() {
            return Vec::new();
        }
        let version = self.catalog.pushed.get(method).copied().unwrap_or(0);
        let mut read = Read {
            method: method.to_owned(),
            call: 0,
            version,
            data: Vec::new(),
            cursor: None,
            pages: 0,
        };
        let effect = self.catalog_page(method, &mut read);
        self.catalog.running.insert(method.to_owned(), read);
        effect
    }

    /// One page's request, with the params its surface takes.
    fn catalog_page(&mut self, method: &str, read: &mut Read) -> Vec<Effect> {
        let call = self.calls.take();
        read.call = call;
        let mut params = match method {
            "skills/list" => {
                let mut params = Map::new();
                params.insert(
                    "cwds",
                    Value::Array(vec![Value::from(self.catalog.cwd.clone())].into()),
                );
                params.insert("forceReload", Value::Bool(true));
                params
            }
            "app/list" => {
                let mut params = Map::new();
                params.insert("threadId", Value::from(self.root.clone()));
                params.insert("limit", Value::from(100.0));
                params
            }
            _ => {
                let mut params = Map::new();
                params.insert("limit", Value::from(100.0));
                params
            }
        };
        if let Some(cursor) = &read.cursor {
            params.insert("cursor", Value::from(cursor.clone()));
        }
        vec![Effect::Request {
            call,
            method: method.to_owned(),
            params: Value::Object(params),
            timeout_ms: Some(READ_MS),
        }]
    }

    /// A read's end: publish unless a push overtook it, then start the re-read
    /// an invalidation asked for.
    fn catalog_finish(&mut self, read: Read, data: Option<Vec<Value>>) -> Vec<Effect> {
        let method = read.method;
        let mut effects = Vec::new();
        if let Some(data) = data
            && self.catalog.pushed.get(&method).copied().unwrap_or(0) == read.version
        {
            effects.extend(self.publish(&method, &data));
        }
        if self.catalog.dirty.shift_remove(&method) {
            effects.extend(self.catalog_refresh(&method));
        }
        effects
    }

    /// An unchanged snapshot costs neither a frame nor a client fan-out.
    fn publish(&mut self, method: &str, data: &[Value]) -> Vec<Effect> {
        if self.is_closed() {
            return Vec::new();
        }
        let encoded = Value::Array(data.to_vec().into()).to_json();
        if self.catalog.published.get(method) == Some(&encoded) {
            return Vec::new();
        }
        self.catalog.published.insert(method.to_owned(), encoded);
        let mut result = Map::new();
        result.insert("data", Value::Array(data.to_vec().into()));
        let mut note = Map::new();
        note.insert("method", Value::from(method.to_owned()));
        note.insert("result", Value::Object(result));
        note.insert("cwd", Value::from(self.catalog.cwd.clone()));
        self.emit_dir(FrameDir::Note, &Value::Object(note), CHANNEL, None)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests;
