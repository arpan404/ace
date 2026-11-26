// SPDX-License-Identifier: Apache-2.0
//! The pass's walk (`recovery.ts`): the order of its reads and frames, the
//! pagination and visit bounds, the interaction staging, the settlement check
//! and the shell reads. The host is real ownership and real history; only the
//! `http` replies are scripted.

use std::cell::RefCell;

use ace_json::{Value, json};
use indexmap::{IndexMap, IndexSet};

use super::{Recovery, RecoveryError, RecoveryHost, Step};
use crate::session::history::{Failure, HistoryReader, Read, Step as HistoryStep};
use crate::session::http::Reply;
use crate::session::ownership::{Info, SessionOwnership};

/// A tenant's readable state, with the walk's effects recorded.
struct Host {
    ownership: RefCell<SessionOwnership>,
    /// `ancestry.shells()`: the probes' pending shells.
    pending: IndexMap<String, String>,
    live: IndexMap<String, Vec<String>>,
    observed: IndexSet<String>,
    watermark: u64,
    history: RefCell<HistoryReader>,
    frames: RefCell<Vec<(String, String)>>,
    receives: RefCell<Vec<String>>,
    stages: RefCell<Vec<(String, String, u64)>>,
    shells: RefCell<Vec<(String, String, u64)>>,
}

impl Host {
    fn new(root: &str) -> Self {
        let mut ownership = SessionOwnership::new("/work", "", None);
        ownership
            .establish(&info(root, None, "/work", "p1"))
            .expect("the root establishes");
        Self {
            ownership: RefCell::new(ownership),
            pending: IndexMap::new(),
            live: IndexMap::new(),
            observed: IndexSet::new(),
            watermark: 9,
            history: RefCell::new(HistoryReader::new()),
            frames: RefCell::new(Vec::new()),
            receives: RefCell::new(Vec::new()),
            stages: RefCell::new(Vec::new()),
            shells: RefCell::new(Vec::new()),
        }
    }

    fn framed(&self, channel: &str) -> Vec<String> {
        self.frames
            .borrow()
            .iter()
            .filter(|(seen, _)| seen == channel)
            .map(|(_, text)| text.clone())
            .collect()
    }
}

impl RecoveryHost for Host {
    fn watermark(&self) -> u64 {
        self.watermark
    }

    fn verify(&self, info: &Info<'_>) -> Result<(), RecoveryError> {
        self.ownership
            .borrow_mut()
            .verify(info)
            .map_err(|error| RecoveryError::Ownership(error.to_string()))
    }

    fn admit(&self, info: &Info<'_>, parent: &str) -> Result<(), RecoveryError> {
        self.ownership
            .borrow_mut()
            .admit(info, parent)
            .map_err(|error| RecoveryError::Ownership(error.to_string()))
    }

    fn direct_children(&self, id: &str) -> Vec<String> {
        self.ownership
            .borrow()
            .direct_children(id)
            .iter()
            .cloned()
            .collect()
    }

    fn session_directories(&self) -> Vec<String> {
        let ownership = self.ownership.borrow();
        let mut seen = IndexSet::new();
        let mut directories = Vec::new();
        for owner in ownership.sessions().values() {
            if seen.insert(owner.directory.clone()) {
                directories.push(owner.directory.clone());
            }
        }
        directories
    }

    fn session_directory(&self, id: &str) -> Option<String> {
        self.ownership
            .borrow()
            .sessions()
            .get(id)
            .map(|owner| owner.directory.clone())
    }

    fn shells(&self) -> IndexMap<String, String> {
        self.ownership.borrow().shells().clone()
    }

    fn pending_shells(&self) -> IndexMap<String, String> {
        self.pending.clone()
    }

    fn live_messages(&self, id: &str) -> Vec<String> {
        self.live.get(id).cloned().unwrap_or_default()
    }

    fn execution_observed(&self, id: &str) -> bool {
        self.observed.contains(id)
    }

    fn history_begin(&self, id: &str) -> (Read, HistoryStep) {
        self.history.borrow().begin(id)
    }

    fn history_step(
        &self,
        read: &mut Read,
        reply: &Reply,
        deliver: &mut dyn FnMut(&Value) -> Result<(), RecoveryError>,
    ) -> Result<HistoryStep, Failure<RecoveryError>> {
        self.history.borrow_mut().step(read, reply, deliver)
    }

    fn frame(&self, channel: &'static str, data: &Value) -> Result<(), RecoveryError> {
        self.frames
            .borrow_mut()
            .push((channel.to_owned(), ace_json::to_string(data)));
        Ok(())
    }

    fn receive(&self, data: &Value) -> Result<(), RecoveryError> {
        self.receives.borrow_mut().push(ace_json::to_string(data));
        // The tenant's own receive keeps the shell the event names.
        let envelope = crate::translate::data::fields(data);
        let typ = crate::translate::data::s_in(envelope, "type");
        if typ == "shell.created" {
            let payload =
                crate::translate::data::fields(crate::translate::data::get(envelope, "data"));
            let info = crate::translate::data::fields(crate::translate::data::get(payload, "info"));
            let id = crate::translate::data::s_in(info, "id").to_owned();
            let owner = crate::translate::data::s_in(
                crate::translate::data::fields(crate::translate::data::get(info, "metadata")),
                "sessionID",
            )
            .to_owned();
            if !id.is_empty() {
                self.ownership.borrow_mut().shells_mut().insert(id, owner);
            }
        }
        Ok(())
    }

    fn stage(
        &self,
        channel: &'static str,
        _data: &Value,
        session: &str,
        started: u64,
    ) -> Result<(), RecoveryError> {
        self.stages
            .borrow_mut()
            .push((channel.to_owned(), session.to_owned(), started));
        Ok(())
    }

    fn shell_snapshot(&self, id: &str, owner: &str, started: u64) -> Result<(), RecoveryError> {
        self.shells
            .borrow_mut()
            .push((id.to_owned(), owner.to_owned(), started));
        Ok(())
    }
}

fn info(id: &str, parent: Option<&str>, directory: &str, project: &str) -> Value {
    let mut value = json!({
        "id": id,
        "projectID": project,
        "location": { "directory": directory },
    });
    if let (Some(parent), Value::Object(map)) = (parent, &mut value) {
        map.insert("parentID".to_owned(), json!(parent));
    }
    value
}

fn reply(body: Value) -> Reply {
    Reply::parse(true, &ace_json::to_string(&body))
}

fn page(ids: &[&str], next: Option<&str>) -> Value {
    json!({
        "data": ids.iter().map(|id| info(id, Some("root"), "/work", "p1")).collect::<Vec<_>>(),
        "cursor": { "next": next },
    })
}

/// One `session.list` reply: the children of the page it was asked for.
fn children(ids: &[&str], next: Option<&str>) -> Reply {
    reply(page(ids, next))
}

/// The default reply for a request the test does not script.
fn answer(op: &str, params: &Value) -> Reply {
    match op {
        "session.get" => {
            let id = params
                .get("sessionID")
                .and_then(Value::as_str)
                .unwrap_or("");
            if id == "root" {
                reply(info("root", None, "/work", "p1"))
            } else {
                reply(info(id, Some("root"), "/work", "p1"))
            }
        }
        "session.list" => children(&[], None),
        "message.list" => reply(json!({ "data": [], "cursor": { "next": null } })),
        "session.active" => reply(json!({})),
        "shell.list" => {
            let directory = params
                .get("location")
                .and_then(|location| location.get("directory"))
                .and_then(Value::as_str)
                .unwrap_or("");
            reply(json!({ "location": { "directory": directory }, "data": [] }))
        }
        "session.message.get" => reply(json!({ "id": "m1", "type": "assistant" })),
        _ => reply(json!([])),
    }
}

/// Runs the walk to its end, answering every request through `respond`.
fn drive(
    mut machine: Recovery,
    host: &Host,
    first: Step,
    respond: &mut dyn FnMut(&str, &Value) -> Reply,
) -> Result<Vec<(String, Value)>, RecoveryError> {
    let mut requests = Vec::new();
    let mut step = first;
    for _ in 0..256 {
        match step {
            Step::Request { op, params } => {
                let answer = respond(op, &params);
                requests.push((op.to_owned(), params));
                step = machine.step(&answer, host)?;
            }
            Step::Done => return Ok(requests),
        }
    }
    panic!("the pass did not finish: {requests:?}");
}

fn ops(requests: &[(String, Value)]) -> Vec<String> {
    requests
        .iter()
        .map(
            |(op, params)| match params.get("sessionID").and_then(Value::as_str) {
                Some(id) if op != "session.active" && op != "shell.list" => format!("{op} {id}"),
                _ => op.clone(),
            },
        )
        .collect()
}

mod shells;
mod walk;
