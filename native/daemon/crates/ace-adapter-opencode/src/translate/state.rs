// SPDX-License-Identifier: Apache-2.0
//! The translator's native session state
//! (`packages/adapter-opencode/src/native-state.ts`, first half). Keys stay
//! namespaced per provider process; facts carry those keys, never ace ids.

use crate::translate::cache::{OrderedMap, RecentMap, RecentSet};
use serde::Serialize;
use serde_json::value::RawValue;
use std::collections::HashSet;
use thiserror::Error;

/// What native-state work can fail with. Every failure becomes the
/// translator's disconnected fact, as the TypeScript `catch` does.
#[derive(Debug, Error)]
pub enum StateError {
    /// A bookkeeping bound tripped (`adapter.warning`, never the transcript).
    #[error("bookkeeping limit: {0}")]
    Limit(&'static str),
    /// A native envelope failed its check.
    #[error("envelope: {0}")]
    Envelope(#[from] crate::translate::boundaries::BoundaryError),
    /// A fact failed to serialize.
    #[error("fact failed to serialize")]
    Emit,
}

impl From<serde_json::Error> for StateError {
    fn from(_: serde_json::Error) -> Self {
        StateError::Emit
    }
}

/// One fact writer: facts appended to one preallocated buffer as a JSON array.
pub struct Out<'b> {
    buf: &'b mut String,
    first: bool,
}

impl<'b> Out<'b> {
    pub fn new(buf: &'b mut String) -> Self {
        Self { buf, first: true }
    }

    pub fn fact<T: Serialize>(&mut self, fact: &T) -> Result<(), StateError> {
        if !self.first {
            self.buf.push(',');
        }
        self.first = false;
        match serde_json::to_string(fact) {
            Ok(text) => {
                self.buf.push_str(&text);
                Ok(())
            }
            Err(_) => Err(StateError::Emit),
        }
    }
}

/// A file change an edit or write reported with its patch.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileChange {
    pub path: String,
    pub kind: ChangeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

/// Whether the path was added, deleted, or updated.
#[derive(Debug, PartialEq, Clone, Copy, Eq)]
pub enum ChangeKind {
    Add,
    Delete,
    Update,
}

impl Serialize for ChangeKind {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(match self {
            ChangeKind::Add => "add",
            ChangeKind::Delete => "delete",
            ChangeKind::Update => "update",
        })
    }
}

/// A tool call the session tracks, live until it settles.
#[derive(Debug)]
pub struct Tool {
    pub session: String,
    pub message: String,
    pub name: String,
    pub input: Box<RawValue>,
    pub live: bool,
    pub created: f64,
    /// The file changes an edit or write has reported with their patches.
    pub changes: Option<Vec<FileChange>>,
}

/// A known session: its parent, directory, and selected model.
#[derive(Debug)]
pub struct AgentMeta {
    pub parent: String,
    pub directory: String,
    pub model: Option<String>,
}

/// A child first learned from an ancestry read, claimed on its session.
#[derive(Debug)]
pub struct ChildClaim {
    pub session: String,
    pub item: String,
    pub background: bool,
    pub created: f64,
}

/// A pending native interaction: whose, its data, and its answer if resolved.
#[derive(Debug)]
pub struct Pending {
    pub session: String,
    pub data: Box<RawValue>,
    pub typ: String,
    pub resolution: Option<Box<RawValue>>,
}

/// The translator's native session state.
#[derive(Debug)]
pub struct NativeState {
    pub root_key: String,
    pub root_native: String,
    pub disconnected: bool,
    pub agents: OrderedMap<AgentMeta>,
    pub active: OrderedMap<String>,
    pub idle: OrderedMap<f64>,
    pub execution_baseline: OrderedMap<f64>,
    pub execution_created: OrderedMap<f64>,
    pub triggers: OrderedMap<String>,
    pub ended: RecentSet,
    /// Sessions with at least one observed or settled turn.
    pub turned: RecentSet,
    pub probed_idle: OrderedMap<f64>,
    pub events: RecentSet,
    pub durable: RecentMap<f64>,
    pub child_claims: OrderedMap<ChildClaim>,
    pub tools: OrderedMap<Tool>,
    pub recent_tools: RecentMap<Tool>,
    pub live_messages: OrderedMap<OrderedMap<i64>>,
    pub inputs: OrderedMap<String>,
    pub commands: OrderedMap<String>,
    pub admitted: RecentSet,
    pub admission_pending: HashSet<String>,
    pub pending: OrderedMap<Pending>,
    pub shells: OrderedMap<String>,
    pub wake_shells: HashSet<String>,
    pub wakes: OrderedMap<f64>,
    pub backgrounds: OrderedMap<String>,
    pub completed_backgrounds: RecentSet,
    pub child_dispatches: OrderedMap<OrderedMap<f64>>,
    pub child_completed_at: RecentMap<f64>,
    pub child_dispatch_count: i64,
}

impl NativeState {
    pub fn new(root_key: String) -> Self {
        Self {
            root_key,
            root_native: String::new(),
            disconnected: false,
            agents: OrderedMap::new(),
            active: OrderedMap::new(),
            idle: OrderedMap::new(),
            execution_baseline: OrderedMap::new(),
            execution_created: OrderedMap::new(),
            triggers: OrderedMap::new(),
            ended: RecentSet::new(),
            turned: RecentSet::new(),
            probed_idle: OrderedMap::new(),
            events: RecentSet::new(),
            durable: RecentMap::new(1024),
            child_claims: OrderedMap::new(),
            tools: OrderedMap::new(),
            recent_tools: RecentMap::new(1024),
            live_messages: OrderedMap::new(),
            inputs: OrderedMap::new(),
            commands: OrderedMap::new(),
            admitted: RecentSet::new(),
            admission_pending: HashSet::new(),
            pending: OrderedMap::new(),
            shells: OrderedMap::new(),
            wake_shells: HashSet::new(),
            wakes: OrderedMap::new(),
            backgrounds: OrderedMap::new(),
            completed_backgrounds: RecentSet::new(),
            child_dispatches: OrderedMap::new(),
            child_completed_at: RecentMap::new(1024),
            child_dispatch_count: 0,
        }
    }

    /// The agent key for a native id: the root key for the root session.
    pub fn key<'a>(&'a self, id: &'a str) -> &'a str {
        if id == self.root_native {
            &self.root_key
        } else {
            id
        }
    }

    pub fn track_tool(&mut self, item: &str, current: Tool) -> Result<(), StateError> {
        if !current.live {
            let previous = self
                .tools
                .get(item)
                .map(|tool| (tool.session.clone(), tool.message.clone()));
            self.tools.delete(item);
            self.recent_tools.set(item.to_owned(), current);
            if let Some((session, message)) = previous {
                let mut remove_session = false;
                if let Some(messages) = self.live_messages.get_mut(session.as_str()) {
                    let count = messages.get(message.as_str()).copied().unwrap_or(0);
                    if count <= 1 {
                        messages.delete(message.as_str());
                    } else {
                        messages.set(message, count - 1);
                    }
                    remove_session = messages.is_empty();
                }
                if remove_session {
                    self.live_messages.delete(session.as_str());
                }
            }
            return Ok(());
        }
        if self.tools.len() >= 2048 && !self.tools.has(item) {
            return Err(StateError::Limit("tool"));
        }
        let is_new = !self.tools.has(item);
        let session = current.session.clone();
        let message = current.message.clone();
        self.tools.set(item.to_owned(), current);
        if is_new {
            if !self.live_messages.has(session.as_str()) {
                self.live_messages.set(session.clone(), OrderedMap::new());
            }
            if let Some(messages) = self.live_messages.get_mut(session.as_str()) {
                let next = messages.get(message.as_str()).copied().unwrap_or(0) + 1;
                messages.set(message, next);
            }
        }
        Ok(())
    }
}

impl NativeState {
    /// Admit a queued input durably: ownership transfers, the queue syncs.
    pub fn admit(&mut self, id: &str, session: &str, out: &mut Out<'_>) -> Result<(), StateError> {
        self.finish_background(&format!("admission:{id}"), "completed", out)?;
        if self.admitted.has(id) {
            return Ok(());
        }
        self.admitted.add(id);
        self.admission_pending.remove(id);
        let command_id = self.commands.get(id).cloned();
        let agent = self.key(session).to_owned();
        out.fact(&InputAdmitted {
            typ: "input.admitted",
            agent: &agent,
            native_input_id: id,
            command_id: command_id.as_deref(),
        })?;
        Ok(())
    }

    /// The provider queue's changed count: inputs minus pending admissions.
    pub fn queue(&self, out: &mut Out<'_>) -> Result<(), StateError> {
        let count = self.inputs.len() as i64 - self.admission_pending.len() as i64;
        out.fact(&QueueChanged {
            typ: "queue.changed",
            count,
            source: "provider",
        })?;
        Ok(())
    }

    /// Note an input for its session, syncing the provider queue.
    pub fn input(&mut self, id: &str, session: &str, out: &mut Out<'_>) -> Result<(), StateError> {
        if self.inputs.len() >= 1024 && !self.inputs.has(id) {
            return Err(StateError::Limit("inbox"));
        }
        self.inputs.set(id.to_owned(), session.to_owned());
        self.queue(out)
    }

    /// Whether the translator holds no live work.
    pub fn settled(&self) -> bool {
        !self.disconnected
            && self.active.is_empty()
            && self.inputs.is_empty()
            && self.pending.is_empty()
            && self.backgrounds.is_empty()
            && self.child_claims.is_empty()
            && self.wakes.is_empty()
    }
}

#[derive(Serialize)]
struct InputAdmitted<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    agent: &'a str,
    #[serde(rename = "nativeInputId")]
    native_input_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none", rename = "commandId")]
    command_id: Option<&'a str>,
}

#[derive(Serialize)]
struct QueueChanged {
    #[serde(rename = "type")]
    typ: &'static str,
    count: i64,
    source: &'static str,
}
