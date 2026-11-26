// SPDX-License-Identifier: Apache-2.0
//! The pass's global tail (`recovery.ts:97`-`:178`): the one active read for
//! every visited session, then each directory's shell listing and the exact
//! read for every shell that listing did not cover.
//!
//! `Active` is global metadata, not a discovery list: it is read once per pass,
//! and only ids whose ancestry the walk established are considered. The shell
//! listing is per directory, and its `shell.get` is the pass's only read whose
//! 404 means an absence rather than a failure (`session.ts:533`-`:546`).

use ace_json::{Map, Value, json};
use indexmap::{IndexMap, IndexSet};

use crate::translate::boundaries::parse_pending_list;
use crate::translate::data::{fields, get, n_in, num_str, s_in, truthy};

use super::super::http::Reply;
use super::super::ownership::parse_info;
use super::{Phase, Recovery, RecoveryError, RecoveryHost, Step};

/// The active read and the shell reads, in the TypeScript's order.
pub(super) struct Shells {
    /// `started` for the active snapshots, read before `session.active`.
    started: u64,
    /// The `session.active` record.
    active: Map,
    /// `visited`, in insertion order.
    ids: Vec<String>,
    at: usize,
    directories: Vec<String>,
    directory_at: usize,
    candidates: IndexMap<String, String>,
    candidate_at: usize,
    observed: IndexSet<String>,
    /// The directory the exact read in flight names.
    read_directory: String,
    /// `listReadStarted` or `exactReadStarted` for the request in flight.
    read_started: u64,
}

impl Shells {
    pub(super) fn new() -> Self {
        Self {
            started: 0,
            active: Map::new(),
            ids: Vec::new(),
            at: 0,
            directories: Vec::new(),
            directory_at: 0,
            candidates: IndexMap::new(),
            candidate_at: 0,
            observed: IndexSet::new(),
            read_directory: String::new(),
            read_started: 0,
        }
    }

    /// `const started = p.watermark()` before `session.active` (`:99`).
    pub(super) fn begin(&mut self, started: u64) {
        *self = Self::new();
        self.started = started;
    }
}

impl Recovery {
    /// One reply of the global tail.
    pub(super) fn shell_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        match self.phase {
            Phase::Active => self.active_reply(reply),
            Phase::ActiveInfo => self.active_info_reply(reply, host),
            Phase::ShellList => self.shell_list_reply(reply, host),
            Phase::ShellGet => self.shell_get_reply(reply, host),
            _ => Err(RecoveryError::Stage),
        }
    }

    /// The next request of the global tail, or the pass's end.
    pub(super) fn shell_next(&mut self, host: &dyn RecoveryHost) -> Result<Step, RecoveryError> {
        loop {
            match self.phase {
                Phase::Active => {
                    return Ok(Step::Request {
                        op: "session.active",
                        params: json!({}),
                    });
                }
                Phase::ActiveInfo => {
                    if self.shells.at < self.shells.ids.len() {
                        let id = self.shells.ids[self.shells.at].clone();
                        return Ok(Step::Request {
                            op: "session.get",
                            params: json!({ "sessionID": id }),
                        });
                    }
                    self.shells.directories = host.session_directories();
                    self.shells.directory_at = 0;
                    self.phase = Phase::ShellList;
                }
                Phase::ShellList => {
                    if self.shells.directory_at < self.shells.directories.len() {
                        let directory = self.shells.directories[self.shells.directory_at].clone();
                        self.shells.read_started = host.watermark();
                        return Ok(Step::Request {
                            op: "shell.list",
                            params: json!({ "location": { "directory": directory } }),
                        });
                    }
                    // `new Map(ownership.shells)`, then every owned pending shell.
                    let mut candidates = host.shells();
                    for (id, owner) in host.pending_shells() {
                        if host.session_directory(&owner).is_some() {
                            candidates.insert(id, owner);
                        }
                    }
                    self.shells.candidates = candidates;
                    self.shells.candidate_at = 0;
                    self.phase = Phase::ShellGet;
                }
                Phase::ShellGet => {
                    while self.shells.candidate_at < self.shells.candidates.len() {
                        let (id, owner) = {
                            let index = self.shells.candidate_at;
                            let (id, owner) = self
                                .shells
                                .candidates
                                .get_index(index)
                                .ok_or(RecoveryError::Stage)?;
                            (id.clone(), owner.clone())
                        };
                        if self.shells.observed.contains(&id) {
                            self.shells.candidate_at += 1;
                            continue;
                        }
                        // `if (!directory) throw` runs before the await (`:150`).
                        let directory = host
                            .session_directory(&owner)
                            .filter(|directory| !directory.is_empty())
                            .ok_or(RecoveryError::ShellOwner)?;
                        self.shells.read_directory = directory.clone();
                        self.shells.read_started = host.watermark();
                        return Ok(Step::Request {
                            op: "shell.get",
                            params: json!({ "id": id, "location": { "directory": directory } }),
                        });
                    }
                    self.phase = Phase::Done;
                    return Ok(Step::Done);
                }
                _ => return Err(RecoveryError::Stage),
            }
        }
    }

    /// `z.record(z.string(), z.unknown()).parse(await session.active())`.
    fn active_reply(&mut self, reply: &Reply) -> Result<(), RecoveryError> {
        let Value::Object(active) = &reply.body else {
            return Err(RecoveryError::envelope("active"));
        };
        self.shells.active = active.clone();
        self.shells.ids = self.visited.iter().cloned().collect();
        self.shells.at = 0;
        self.phase = Phase::ActiveInfo;
        Ok(())
    }

    /// One `session.get` of the global loop: `verify`, the settlement check,
    /// and the `snapshot.active` the replay is fenced with.
    fn active_info_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        let info = parse_info(&reply.body).ok_or_else(|| RecoveryError::envelope("info"))?;
        host.verify(&info)?;
        let id = info.id.to_owned();
        let map = fields(&reply.body);
        let time = fields(get(map, "time"));
        let running = s_in(fields(get(&self.shells.active, &id)), "type") == "running";
        let idle = time.get("idle");
        if !running
            && host.execution_observed(&id)
            && idle.and_then(Value::as_f64).is_none()
            && !truthy(get(map, "outcome"))
        {
            return Err(RecoveryError::Settlement);
        }
        let mut data = Map::new();
        data.insert("sessionID".to_owned(), json!(id));
        data.insert("running".to_owned(), json!(running));
        if let Some(outcome) = map.get("outcome") {
            data.insert("outcome".to_owned(), outcome.clone());
        }
        if let Some(idle) = idle {
            data.insert("idleAt".to_owned(), idle.clone());
        }
        data.insert(
            "revision".to_owned(),
            json!(format!(
                "{}:{}",
                num_str(n_in(time, "updated")),
                self.shells.started
            )),
        );
        host.stage(
            "snapshot.active",
            &Value::Object(data),
            &id,
            self.shells.started,
        )?;
        self.shells.at += 1;
        Ok(())
    }

    /// One directory's shell listing: each owned shell is received and staged.
    fn shell_list_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        let directory = self
            .shells
            .directories
            .get(self.shells.directory_at)
            .cloned()
            .ok_or(RecoveryError::Stage)?;
        let listing = fields(&reply.body);
        let Some(Value::Object(location)) = listing.get("location") else {
            return Err(RecoveryError::envelope("shell.location"));
        };
        if s_in(location, "directory") != directory {
            return Err(RecoveryError::envelope("shell.location"));
        }
        let data = parse_pending_list(get(listing, "data"))
            .map_err(|_| RecoveryError::envelope("pending"))?;
        for info in data {
            let owner = s_in(fields(get(fields(info), "metadata")), "sessionID").to_owned();
            if host.session_directory(&owner).as_deref() != Some(directory.as_str()) {
                continue;
            }
            let id = s_in(fields(info), "id").to_owned();
            let status = s_in(fields(info), "status").to_owned();
            self.shells.observed.insert(id.clone());
            host.receive(&json!({
                "id": format!("snapshot:shell:{id}:{status}"),
                "type": "shell.created",
                "location": { "directory": directory },
                "data": { "info": info },
            }))?;
            host.shell_snapshot(&id, &owner, self.shells.read_started)?;
        }
        self.shells.directory_at += 1;
        Ok(())
    }

    /// The exact read for one shell the listing missed: a 404 is its absence.
    fn shell_get_reply(
        &mut self,
        reply: &Reply,
        host: &dyn RecoveryHost,
    ) -> Result<(), RecoveryError> {
        let (id, owner) = {
            let index = self.shells.candidate_at;
            let (id, owner) = self
                .shells
                .candidates
                .get_index(index)
                .ok_or(RecoveryError::Stage)?;
            (id.clone(), owner.clone())
        };
        let directory = self.shells.read_directory.clone();
        if !reply.ok {
            if reply.status != Some(404.0) {
                return Err(RecoveryError::ShellIncomplete);
            }
            host.receive(&json!({
                "id": format!("snapshot:shell:{id}:deleted"),
                "type": "shell.deleted",
                "location": { "directory": directory },
                "data": { "id": id },
            }))?;
        } else {
            let info = shell_info(&reply.body, &id, &owner)
                .ok_or_else(|| RecoveryError::envelope("shell"))?;
            let status = s_in(fields(&info), "status").to_owned();
            host.receive(&json!({
                "id": format!("snapshot:shell:{id}:{status}"),
                "type": "shell.created",
                "location": { "directory": directory },
                "data": { "info": info },
            }))?;
        }
        host.shell_snapshot(&id, &owner, self.shells.read_started)?;
        self.shells.candidate_at += 1;
        Ok(())
    }
}

/// The exact read's check (`recovery.ts:161`-`:168`), in zod's output order:
/// `id`, `status`, `metadata` (`sessionID` first), then unknown keys.
fn shell_info(body: &Value, id: &str, owner: &str) -> Option<Value> {
    let data = match fields(body).get("data") {
        Some(Value::Object(data)) => data,
        _ => return None,
    };
    match data.get("id") {
        Some(Value::String(text)) if text.as_str() == id => {}
        _ => return None,
    }
    if !matches!(data.get("status"), Some(Value::String(_))) {
        return None;
    }
    let metadata = match data.get("metadata") {
        Some(Value::Object(metadata)) => metadata,
        _ => return None,
    };
    match metadata.get("sessionID") {
        Some(Value::String(text)) if text.as_str() == owner => {}
        _ => return None,
    }
    let mut ordered_metadata = Map::new();
    for (key, value) in metadata.iter() {
        ordered_metadata.insert(key.clone(), value.clone());
    }
    let mut out = Map::new();
    for key in ["id", "status"] {
        if let Some(value) = data.get(key) {
            out.insert(key.to_owned(), value.clone());
        }
    }
    out.insert("metadata".to_owned(), Value::Object(ordered_metadata));
    for (key, value) in data.iter() {
        if !out.contains_key(key) {
            out.insert(key.clone(), value.clone());
        }
    }
    Some(Value::Object(out))
}
