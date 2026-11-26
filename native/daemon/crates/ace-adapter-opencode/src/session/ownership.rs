// SPDX-License-Identifier: Apache-2.0
//! Session tree ownership (`packages/adapter-opencode/src/ownership.ts` whole).
//!
//! A session ID alone is never evidence of ancestry or location ownership: a
//! session is owned once its `SessionInfo` proves its parent, directory and
//! project, and an event is accepted only for an owned session there. Children
//! join through `session.created`, shells through `shell.created` and tool
//! progress; the tree holds 1,024 sessions and 2,048 shells.
//!
//! `SessionInfo`'s bounds count code points (rule 17), and maps keep the
//! TypeScript's insertion order, which the tree walk reads.

use ace_json::Value;
use indexmap::{IndexMap, IndexSet};
use std::sync::LazyLock;

mod info;

pub use info::{Info, order_info, parse_info, parse_session_info};

/// One session's facts, as `put` stores them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Owner {
    pub parent: String,
    pub directory: String,
    pub project: String,
}

use crate::translate::boundaries::{NativeEvent, event_session, parse_native_event};
use crate::translate::data::{fields, get, s_in};

/// `this.sessions.size >= 1024` (`ownership.ts:96`).
const MAX_SESSIONS: usize = 1024;
/// `this.shells.size >= 2048` (`ownership.ts:139`, `:146`).
const MAX_SHELLS: usize = 2048;

static NO_IDS: LazyLock<IndexSet<String>> = LazyLock::new(IndexSet::new);

/// Told each child session once, when it first joins the tree.
type Admitted = Box<dyn Fn(&str) + Send + Sync>;

/// Why ownership refused an admission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OwnershipError {
    /// `SessionInfo.parse` refused the value (a ZodError there).
    #[error("OpenCode session info failed its check")]
    Info,
    #[error("OpenCode root ownership mismatch")]
    RootMismatch,
    #[error("Inconsistent OpenCode ancestry")]
    Inconsistent,
    #[error("OpenCode child ownership mismatch")]
    ChildMismatch,
    #[error("OpenCode tree limit")]
    TreeLimit,
    #[error("OpenCode shell limit")]
    ShellLimit,
    #[error("OpenCode ancestry cycle")]
    Cycle,
}

/// `SessionOwnership`: the root, its sessions and its shells.
pub struct SessionOwnership {
    root: String,
    directory: String,
    sessions: IndexMap<String, Owner>,
    shells: IndexMap<String, String>,
    children: IndexMap<String, IndexSet<String>>,
    locations: IndexMap<String, IndexSet<String>>,
    admitted: Option<Admitted>,
}

impl SessionOwnership {
    pub fn new(directory: &str, root: &str, admitted: Option<Admitted>) -> Self {
        Self {
            root: root.to_owned(),
            directory: directory.to_owned(),
            sessions: IndexMap::new(),
            shells: IndexMap::new(),
            children: IndexMap::new(),
            locations: IndexMap::new(),
            admitted,
        }
    }

    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn directory(&self) -> &str {
        &self.directory
    }

    pub fn sessions(&self) -> &IndexMap<String, Owner> {
        &self.sessions
    }

    pub fn shells(&self) -> &IndexMap<String, String> {
        &self.shells
    }

    /// `this.shells`: the tenant's shell bookkeeping (`session.ts:406`-`:410`).
    pub fn shells_mut(&mut self) -> &mut IndexMap<String, String> {
        &mut self.shells
    }

    /// `atLocation(directory)`.
    pub fn at_location(&self, directory: &str) -> &IndexSet<String> {
        self.locations.get(directory).unwrap_or(&NO_IDS)
    }

    /// `directChildren(id)`.
    pub fn direct_children(&self, id: &str) -> &IndexSet<String> {
        self.children.get(id).unwrap_or(&NO_IDS)
    }

    /// `put`: the location index follows the session when it moves.
    fn put(&mut self, id: &str, owner: Owner) {
        if let Some(previous) = self.sessions.get(id)
            && previous.directory != owner.directory
        {
            let remove_location = if let Some(located) = self.locations.get_mut(&previous.directory)
            {
                located.shift_remove(id);
                located.is_empty()
            } else {
                false
            };
            if remove_location {
                self.locations.shift_remove(&previous.directory);
            }
        }
        self.locations
            .entry(owner.directory.clone())
            .or_default()
            .insert(id.to_owned());
        self.sessions.insert(id.to_owned(), owner);
    }

    /// `establish`: the root's snapshot must name this directory and its id.
    pub fn establish(&mut self, value: &Value) -> Result<(), OwnershipError> {
        let info = parse_info(value).ok_or(OwnershipError::Info)?;
        if (!self.root.is_empty() && info.id != self.root) || info.directory != self.directory {
            return Err(OwnershipError::RootMismatch);
        }
        self.root = info.id.to_owned();
        self.put(
            info.id,
            Owner {
                parent: info.parent_id.to_owned(),
                directory: info.directory.to_owned(),
                project: info.project_id.to_owned(),
            },
        );
        Ok(())
    }

    /// `verify`: a refetched snapshot must agree with the stored ancestry.
    pub fn verify(&mut self, info: &Info<'_>) -> Result<(), OwnershipError> {
        let Some(owner) = self.sessions.get(info.id).cloned() else {
            return Err(OwnershipError::Inconsistent);
        };
        if info.parent_id != owner.parent || (info.id != self.root && info.fork) {
            return Err(OwnershipError::Inconsistent);
        }
        // A GET for an already-owned ID confirms its new stored location/project.
        self.put(
            info.id,
            Owner {
                directory: info.directory.to_owned(),
                project: info.project_id.to_owned(),
                ..owner
            },
        );
        Ok(())
    }

    /// `admit`: a child joins only in its parent's directory and project.
    pub fn admit(&mut self, info: &Info<'_>, parent: &str) -> Result<(), OwnershipError> {
        let Some(owner) = self.sessions.get(parent) else {
            return Err(OwnershipError::ChildMismatch);
        };
        let joining = !self.sessions.contains_key(info.id);
        if info.parent_id != parent
            || info.fork
            || info.id == self.root
            || info.directory != owner.directory
            || info.project_id != owner.project
            || (self.sessions.contains_key(info.id)
                && self
                    .sessions
                    .get(info.id)
                    .is_some_and(|e| e.parent != parent))
        {
            return Err(OwnershipError::ChildMismatch);
        }
        if self.sessions.len() >= MAX_SESSIONS && joining {
            return Err(OwnershipError::TreeLimit);
        }
        self.put(
            info.id,
            Owner {
                parent: parent.to_owned(),
                directory: info.directory.to_owned(),
                project: info.project_id.to_owned(),
            },
        );
        self.children
            .entry(parent.to_owned())
            .or_default()
            .insert(info.id.to_owned());
        if joining && let Some(admitted) = &self.admitted {
            admitted(info.id);
        }
        Ok(())
    }

    /// `accept`: whether an event belongs to this tree, keeping what it learns.
    /// A shell past the 2,048 bound is the TypeScript's throw, which fails the
    /// stream; every other refusal is `false`.
    pub fn accept(&mut self, value: &Value) -> Result<bool, OwnershipError> {
        let Ok(event) = parse_native_event(value) else {
            return Ok(false);
        };
        self.accept_event(&event, value)
    }

    /// `accept` on the event the server already parsed: the per-event path
    /// parses each envelope once (`server.ts:415`, `ownership.ts:85`).
    pub fn accept_event(
        &mut self,
        event: &NativeEvent<'_>,
        value: &Value,
    ) -> Result<bool, OwnershipError> {
        if event.typ == "location.shutdown" {
            return Ok(event.location.is_some_and(|location| {
                !self.at_location(s_in(location, "directory")).is_empty()
            }));
        }
        if event.typ == "session.created" {
            let Some(candidate) = parse_session_info(value) else {
                return Ok(false);
            };
            if candidate.id == self.root {
                let owned = self.sessions.get(&self.root).map(|owner| &owner.directory);
                return Ok(owned == Some(&candidate.directory.to_owned()));
            }
            if self
                .admit(&candidate, s_in(event.data, "parentID"))
                .is_err()
            {
                return Ok(false);
            }
        }
        let id = event_session(value);
        if event.typ == "shell.exited" || event.typ == "shell.deleted" {
            let Some(session) = self.shells.get(s_in(event.data, "id")) else {
                return Ok(false);
            };
            return Ok(event.location.is_none_or(|location| {
                self.sessions
                    .get(session)
                    .map(|owner| owner.directory.as_str())
                    == Some(s_in(location, "directory"))
            }));
        }
        let Some(owner) = self.sessions.get(id) else {
            return Ok(false);
        };
        if event.typ == "session.moved" {
            return Ok(true);
        }
        if let Some(location) = event.location
            && s_in(location, "directory") != owner.directory
        {
            return Ok(false);
        }
        if let Some(Value::String(project)) = event.data.get("projectID")
            && project.as_str() != owner.project
        {
            return Ok(false);
        }
        if event.typ == "shell.created" {
            let info = fields(get(event.data, "info"));
            let shell = s_in(info, "id");
            if shell.is_empty() {
                return Ok(false);
            }
            self.add_shell(shell, id)?;
        }
        if event.typ == "session.tool.progress" || event.typ == "session.tool.success" {
            let shell = s_in(fields(get(event.data, "metadata")), "shellID");
            if !shell.is_empty() {
                self.add_shell(shell, id)?;
            }
        }
        Ok(true)
    }

    /// `this.shells.set`, at its 2,048-shell bound.
    fn add_shell(&mut self, shell: &str, session: &str) -> Result<(), OwnershipError> {
        if self.shells.len() >= MAX_SHELLS && !self.shells.contains_key(shell) {
            return Err(OwnershipError::ShellLimit);
        }
        self.shells.insert(shell.to_owned(), session.to_owned());
        Ok(())
    }

    /// `descendants(root)`: deepest first, refusing a cycle.
    pub fn descendants(&self, root: &str) -> Result<Vec<String>, OwnershipError> {
        let mut result = Vec::new();
        let mut visited: IndexSet<String> = IndexSet::new();
        visited.insert(root.to_owned());
        self.visit(root, &mut visited, &mut result)?;
        Ok(result)
    }

    fn visit(
        &self,
        id: &str,
        visited: &mut IndexSet<String>,
        result: &mut Vec<String>,
    ) -> Result<(), OwnershipError> {
        for child in self.direct_children(id) {
            if !visited.insert(child.clone()) {
                return Err(OwnershipError::Cycle);
            }
            self.visit(child, visited, result)?;
            result.push(child.clone());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
