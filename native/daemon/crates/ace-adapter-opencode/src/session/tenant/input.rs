// SPDX-License-Identifier: Apache-2.0
//! The tenant's per-event decisions: ownership, the opening buffer, the
//! interactions and executions it records, the frames it emits, and the
//! handlers a recovery pass drives (`session.ts:336`-`:419`, `:166`-`:197`).

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{SessionErrorWire, SessionEvent};
use ace_json::{Value, json};
use std::sync::atomic::Ordering;

use crate::translate::boundaries::{NativeEvent, event_session, parse_native_event};
use crate::translate::data::{fields, get, s_in, s_in_fb};

use super::super::ownership::parse_info;
use super::super::server::TenantError;
use super::OpenCodeTenant;
use super::PendingInteraction;

use super::{
    BARRIER_CLOSED, CATALOG_TYPES, INTERACTION_LIMIT, MAX_PENDING, MAX_WAITERS, OPENING_BYTES,
    OPENING_EVENTS, PORT_CATALOG, PORT_MCP_FORGET, PORT_MOVED, PORT_RECONCILE, RECOVERY_SEND_LIMIT,
    SESSION_CLOSED, STARTUP_LIMIT, port,
};

impl OpenCodeTenant {
    /// `opening = false`: the snapshot established ownership; the held events
    /// replay through `receive` in arrival order (`:277`-`:278`).
    pub fn finish_opening(&self, watermark: u64) -> Result<(), TenantError> {
        self.opening.store(false, Ordering::SeqCst);
        let events = std::mem::take(&mut self.lock_opening().events);
        for event in events {
            self.receive_value(&event, watermark)?;
        }
        Ok(())
    }

    /// `ownership.establish(info)` (`session.ts:277`), before any input. The
    /// facade reads `info` from `session.create`/`session.get` (E3-opencode.4).
    pub fn establish_root(&self, info: &Value) -> Result<(), TenantError> {
        self.lock_ownership()
            .establish(info)
            .map_err(|error| TenantError(error.to_string()))
    }

    /// `s.emit("recv", "snapshot.info", { info, root: true })` (`:277`): after
    /// the environment is applied, before the opening buffer replays.
    pub fn root_snapshot(&self, info: &Value) -> Result<(), TenantError> {
        self.emit(
            FrameDirection::Recv,
            "snapshot.info",
            &json!({ "info": info, "root": true }),
        )
    }

    /// `admitEnvironment`'s failure (`:105`): the child's tools stay refused
    /// and ace stops it, saying why. The message is the whole reason; only the
    /// settle reply is cut to 1,024 characters, and the facade builds that.
    pub fn admit_stopped(&self, session_id: &str, message: &str) -> Result<(), TenantError> {
        self.emit(
            FrameDirection::Note,
            "agent.environment",
            &json!({ "type": "stopped", "sessionID": session_id, "message": message }),
        )
    }

    /// The `session.moved` refetch's reply (`:345`-`:362`): a verified snapshot
    /// is stored and framed; a refusal or a failed check asks for recovery
    /// instead. Either way the session's id is released (`finally`), so a later
    /// move asks again.
    pub fn moved_reply(&self, id: &str, ok: bool, body: &Value) {
        let verified =
            ok && parse_info(body).is_some_and(|info| self.lock_ownership().verify(&info).is_ok());
        if verified {
            let _ = self.emit(
                FrameDirection::Recv,
                "snapshot.info",
                &json!({ "info": body }),
            );
        }
        self.moved_done(id);
        if !verified {
            self.reconcile_now();
        }
    }

    /// `barrier` (`:421`-`:427`): wait for the running pass, bounded at 64.
    pub fn barrier(&self, id: u64) -> Result<(), TenantError> {
        if self.closed() {
            return Err(TenantError(BARRIER_CLOSED.to_owned()));
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

    /// `owns` (`:336`-`:365`) on the event the server parsed. A shell past its
    /// bound is the TypeScript's throw, which fails the stream.
    pub fn owns(
        &self,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<bool, TenantError> {
        if self.closed() {
            return Ok(false);
        }
        if self.opening.load(Ordering::SeqCst) {
            let location = event.location;
            let directory = location.map_or("", |location| s_in(location, "directory"));
            return Ok(directory == self.cwd);
        }
        let accepted = match self.lock_ownership().accept_event(event, data) {
            Ok(accepted) => accepted,
            Err(error) => return Err(TenantError(error.to_string())),
        };
        if !accepted {
            self.prove(data, watermark);
        }
        if accepted && event.typ == "session.moved" {
            let id = event_session(data).to_owned();
            let mut moves = self.lock_moves();
            if moves.contains(&id) {
                return Ok(accepted);
            }
            moves.insert(id.clone());
            drop(moves);
            port(&self.queue, PORT_MOVED, json!({ "sessionID": id }));
        }
        Ok(accepted)
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
        self.reconcile_now();
    }

    /// `server.reconcileNow()` (`:122`, `:150`, `:359`): mark the recovery and
    /// ask for the pass. The server begins it inside the chunk when this
    /// happens during an accept or a receive, and the port serves the paths
    /// that run outside the loop.
    pub fn reconcile_now(&self) {
        if self.closed() {
            return;
        }
        self.reconcile.store(true, Ordering::SeqCst);
        port(&self.queue, PORT_RECONCILE, json!({}));
    }

    /// `receive` (`:366`-`:412`), after the server routed the event here.
    pub fn receive_at(
        &self,
        event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<(), TenantError> {
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
        if !self.owns(event, data, watermark)? {
            return Ok(());
        }
        let typ = event.typ;
        let payload = event.data;
        if CATALOG_TYPES.contains(&typ) {
            port(&self.queue, PORT_CATALOG, json!({ "type": typ }));
        }
        if typ == "location.shutdown"
            && let Some(location) = event.location
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
            self.lock_execution().insert(event_session(data).to_owned());
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

    /// `receive` on a value nobody parsed yet (the opening replay, a replay
    /// from evidence, a receipt): the envelope check runs here.
    pub(crate) fn receive_value(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        let event = parse_native_event(data).map_err(|error| TenantError(error.to_string()))?;
        self.receive_at(&event, data, watermark)
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
    pub(crate) fn covered(&self, data: &Value, watermark: u64) -> Result<bool, TenantError> {
        let envelope = fields(data);
        let typ = s_in(envelope, "type");
        let payload = fields(get(envelope, "data"));
        let created = envelope.get("created").and_then(Value::as_f64);
        self.lock_evidence()
            .covered(typ, payload, event_session(data), created, watermark)
            .map_err(|error| TenantError(error.to_string()))
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
        event_session(data).to_owned()
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
