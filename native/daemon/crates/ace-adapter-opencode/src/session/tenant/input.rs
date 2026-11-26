// SPDX-License-Identifier: Apache-2.0
//! The tenant's per-event decisions: ownership, the opening buffer, the
//! interactions and executions it records, the frames it emits, and the
//! handlers a recovery pass drives (`session.ts:336`-`:419`, `:166`-`:197`).

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{SessionErrorWire, SessionEvent};
use ace_json::{Value, json};
use std::sync::atomic::Ordering;

use crate::translate::boundaries::event_session;
use crate::translate::data::{fields, get, s_in, s_in_fb};

use super::super::ancestry::ProbeHost;
use super::super::server::TenantError;
use super::OpenCodeTenant;
use super::PendingInteraction;

use super::{
    CATALOG_TYPES, INTERACTION_LIMIT, MAX_PENDING, MAX_WAITERS, OPENING_BYTES, OPENING_EVENTS,
    PORT_ANCESTRY, PORT_CATALOG, PORT_MCP_FORGET, PORT_MOVED, PORT_RECONCILE, RECOVERY_SEND_LIMIT,
    SESSION_CLOSED, STARTUP_LIMIT, port,
};

impl OpenCodeTenant {
    /// `opening = false`: the snapshot established ownership; the held events
    /// replay through `receive` in arrival order (`:277`-`:278`).
    pub fn finish_opening(&self, watermark: u64) -> Result<(), TenantError> {
        self.opening.store(false, Ordering::SeqCst);
        let events = std::mem::take(&mut self.lock_opening().events);
        for event in events {
            self.receive_at(&event, watermark)?;
        }
        Ok(())
    }

    /// `barrier` (`:421`-`:427`): wait for the running pass, bounded at 64.
    pub fn barrier(&self, id: u64) -> Result<(), TenantError> {
        if self.closed() {
            return Err(TenantError(SESSION_CLOSED.to_owned()));
        }
        if self.recovering() {
            let mut waiters = self.lock_waiters();
            if waiters.len() >= MAX_WAITERS {
                return Err(TenantError(RECOVERY_SEND_LIMIT.to_owned()));
            }
            waiters.push(id);
        }
        Ok(())
    }

    /// `close`: no more frames, and a waiting barrier rejects.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let waiters = std::mem::take(&mut *self.lock_waiters());
        for id in waiters {
            self.settle(id, Err(SESSION_CLOSED));
        }
    }

    /// `owns` (`:336`-`:365`).
    pub fn owns(&self, data: &Value, watermark: u64) -> bool {
        if self.closed() {
            return false;
        }
        if self.opening.load(Ordering::SeqCst) {
            let location = fields(get(fields(data), "location"));
            return s_in(location, "directory") == self.cwd;
        }
        let accepted = self.lock_ownership().accept(data).unwrap_or(false);
        if !accepted {
            self.prove(data, watermark);
        }
        if accepted && s_in(fields(data), "type") == "session.moved" {
            let id = event_session(data);
            let mut moves = self.lock_moves();
            if moves.contains(&id) {
                return accepted;
            }
            moves.insert(id.clone());
            drop(moves);
            port(&self.queue, PORT_MOVED, json!({ "sessionID": id }));
        }
        accepted
    }

    /// `reconcileLocation` (`:413`-`:419`).
    pub(crate) fn reconcile_location(&self) {
        if self.closed() {
            return;
        }
        self.recovering.store(true, Ordering::SeqCst);
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "disconnected", "reason": "location rebuilt" }),
        );
        port(&self.queue, PORT_RECONCILE, json!({}));
    }

    /// `receive` (`:366`-`:412`), after the server routed the event here.
    pub fn receive_at(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        if self.opening.load(Ordering::SeqCst) {
            let bytes = ace_json::to_string(data).len();
            let mut opening = self.lock_opening();
            opening.bytes += bytes;
            if opening.events.len() >= OPENING_EVENTS || opening.bytes > OPENING_BYTES {
                return Err(TenantError(STARTUP_LIMIT.to_owned()));
            }
            opening.events.push(data.clone());
            return Ok(());
        }
        if !self.owns(data, watermark) {
            return Ok(());
        }
        let envelope = fields(data);
        let typ = s_in(envelope, "type");
        let payload = fields(get(envelope, "data"));
        if CATALOG_TYPES.contains(&typ) {
            port(&self.queue, PORT_CATALOG, json!({ "type": typ }));
        }
        if typ == "location.shutdown"
            && let Some(Value::Object(location)) = envelope.get("location")
        {
            let directory = s_in(location, "directory").to_owned();
            port(
                &self.queue,
                PORT_MCP_FORGET,
                json!({ "directory": directory }),
            );
            let owners = self.lock_ownership().at_location(&directory).clone();
            self.lock_pending()
                .retain(|_, entry| !owners.contains(&entry.session));
        }
        match typ {
            "permission.asked" | "form.created" => {
                let value = if typ == "form.created" {
                    get(payload, "form").clone()
                } else {
                    Value::Object(payload.clone())
                };
                let interaction = fields(&value);
                let session = s_in(interaction, "sessionID").to_owned();
                let prefix = if typ == "permission.asked" {
                    "permission"
                } else {
                    "form"
                };
                let key = format!("{prefix}:{session}:{}", s_in(interaction, "id"));
                let mut pending = self.lock_pending();
                if pending.len() >= MAX_PENDING && !pending.contains_key(&key) {
                    return Err(TenantError(INTERACTION_LIMIT.to_owned()));
                }
                pending.insert(
                    key,
                    PendingInteraction {
                        session,
                        data: value,
                        kind: typ.to_owned(),
                    },
                );
            }
            "permission.replied" | "form.replied" | "form.cancelled" => {
                let prefix = if typ == "permission.replied" {
                    "permission"
                } else {
                    "form"
                };
                let id = s_in_fb(payload, "requestID", s_in(payload, "id"));
                self.lock_pending()
                    .shift_remove(&format!("{prefix}:{}:{id}", s_in(payload, "sessionID")));
            }
            _ => {}
        }
        if typ.starts_with("session.execution.") || typ.starts_with("session.step.") {
            self.lock_execution().insert(event_session(data));
        }
        self.emit(FrameDirection::Recv, "sse", data)?;
        if typ == "location.shutdown" {
            self.reconcile_location();
        }
        if typ == "shell.exited" || typ == "shell.deleted" {
            self.lock_ownership()
                .shells_mut()
                .shift_remove(s_in(payload, "id"));
        }
        if typ == "shell.created" {
            let info = fields(get(payload, "info"));
            if s_in(info, "status") != "running" {
                self.lock_ownership()
                    .shells_mut()
                    .shift_remove(s_in(info, "id"));
            }
        }
        Ok(())
    }

    /// `evidence.observe`: one event buffered while recovering.
    pub(crate) fn observe_buffered(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        let envelope = fields(data);
        let typ = s_in(envelope, "type");
        let payload = fields(get(envelope, "data"));
        self.lock_evidence()
            .observe(typ, payload, watermark)
            .map_err(|error| TenantError(error.to_string()))
    }

    /// `evidence.covered` for one replay.
    pub(crate) fn covered(&self, data: &Value, watermark: u64) -> bool {
        let envelope = fields(data);
        let typ = s_in(envelope, "type");
        let payload = fields(get(envelope, "data"));
        let created = envelope.get("created").and_then(Value::as_f64);
        self.lock_evidence()
            .covered(typ, payload, &event_session(data), created, watermark)
    }

    /// `ancestry.prove`: an unowned session's facts wait for a lookup.
    pub(crate) fn prove(&self, data: &Value, watermark: u64) {
        self.lock_ancestry().prove(data, watermark, self);
    }

    /// `object(data).type`, for the closed filter's callers.
    pub fn type_of(data: &Value) -> &str {
        s_in(fields(data), "type")
    }

    /// The session an event names (`eventSession`, read on the value).
    pub fn session_of(data: &Value) -> String {
        event_session(data)
    }

    /// The session's last seeing watermark, for a port's reply.
    pub fn recovery_started(&self) -> u64 {
        self.recovery_started.load(Ordering::SeqCst)
    }

    /// Clear a `session.moved` id once its refetch answered (`:359`).
    pub fn moved_done(&self, id: &str) {
        self.lock_moves().shift_remove(id);
    }

    pub(crate) fn settle(&self, id: u64, result: Result<&'static str, &'static str>) {
        self.queue.publish(vec![SessionEvent::Settle {
            id,
            result: result
                .map(str::to_owned)
                .map_err(|message| SessionErrorWire {
                    code: "ACE_SESSION_CLOSED",
                    message: message.to_owned(),
                }),
        }]);
    }
}

impl ProbeHost for OpenCodeTenant {
    fn owns_session(&self, id: &str) -> bool {
        self.has_session(id)
    }

    fn directory(&self) -> String {
        OpenCodeTenant::directory(self)
    }

    fn recovering(&self) -> bool {
        self.recovering()
    }

    fn info(&self, info: &Value) {
        let _ = self.emit(
            FrameDirection::Recv,
            "snapshot.info",
            &json!({ "info": info }),
        );
    }

    fn receive(&self, data: &Value, watermark: u64) {
        let _ = self.receive_at(data, watermark);
    }

    fn buffered(&self, data: &Value, watermark: u64) {
        let _ = self.observe_buffered(data, watermark);
    }

    fn pending(&self, guard: &str) {
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "ancestry.pending", "id": guard }),
        );
    }

    fn settled(&self, guard: &str) {
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "ancestry.settled", "id": guard }),
        );
    }

    fn failed(&self, data: &Value) {
        if self.closed() {
            return;
        }
        self.recovering.store(true, Ordering::SeqCst);
        let _ = self.emit(FrameDirection::Note, "ancestry.unverified", data);
        let _ = self.emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "disconnected", "reason": "ancestry verification incomplete" }),
        );
        port(&self.queue, PORT_RECONCILE, json!({}));
    }

    fn lookup(&self, id: &str, guard: &str) {
        port(
            &self.queue,
            PORT_ANCESTRY,
            json!({ "id": id, "guard": guard }),
        );
    }
}
