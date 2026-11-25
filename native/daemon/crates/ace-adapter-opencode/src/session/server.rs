// SPDX-License-Identifier: Apache-2.0
//! The OpenCode server core, sans-IO: everything one server's SSE stream does
//! synchronously per event (`server.ts:146`-`:186` subscribe and recovery
//! state, `:385`-`:390` `beginRecovery`, `:399`-`:403` activity, `:409`-`:463`
//! `consumeEvents`, `:537`-`:560` `restartRecovery` and `recoverOnce`'s tail).
//!
//! One server feeds every session on it, so tenants are per server, not per
//! stream: routing, the durable sequences and the recovery buffer live here.
//! Each tenant's effects are published to its own [`EventQueue`] while the
//! caller holds the server's state lock, so one input's effects never
//! interleave with another's and each tenant sees them in TypeScript order.
//! Tenant decisions (ownership, frames, shells) are E3-opencode.2's.
//!
//! What stays TypeScript (E3-opencode.4): the fetch and the body reader, the
//! silence timer, the reconnect loop and its pause, and the awaited resync and
//! prepareReplay of a pass. [`ChunkOutcome::recover`] is how an event asks the
//! shell for it.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, SessionEvent};
use ace_json::{Map, Value};
use indexmap::IndexMap;
use std::sync::Arc;

use crate::translate::boundaries::parse_native_event;
use crate::translate::cache::RecentMap;
use crate::translate::redaction::sanitize;

use super::error::{SecretError, StreamError};
use super::routes::Routes;
use super::stream::EventStream;

/// `OpenCode session limit reached` (`server.ts:148`-`:156`).
pub const MAX_TENANTS: usize = 128;
/// The recovery buffer's bounds (`server.ts:438`-`:453`).
const MAX_BUFFERED_EVENTS: usize = 4096;
const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;
/// The durable-sequence window (`new RecentMap(1024)`).
const SEQUENCES: usize = 1024;
/// `ServerSecrets`: `z.array(z.string().min(1).max(4096)).max(32)`.
const MAX_SECRETS: usize = 32;
const MAX_SECRET_CHARS: usize = 4096;
/// The activity note's channel (`server.ts:402`).
const ACTIVITY: &str = "transport.activity";
/// The two recovery notes the server emits itself (`server.ts:447`, `:451`).
const RESTARTED: &str = "recovery.restarted";
const BUFFERED: &str = "recovery.buffered";

/// One session on a server, as the per-event path needs it. E3-opencode.2
/// implements it over the session's own state, publishing what it decides.
pub trait Tenant: Send + Sync {
    /// The tenant's ordered queue, where this core publishes its notes.
    fn queue(&self) -> &EventQueue;
    /// `routes.select`'s filter: whether this session owns the event at this
    /// watermark.
    fn accepts(&self, data: &Value, watermark: u64) -> bool;
    /// One routed event while not recovering.
    fn receive(&self, data: &Value);
    /// One routed event while recovering, replayed later at `watermark`.
    fn buffered(&self, data: &Value, watermark: u64);
    /// Recovery began at `started`.
    fn disconnected(&self, started: u64);
    /// One buffered event replayed, in the buffer's order.
    fn reconcile(&self, data: &Value, watermark: u64);
    /// The pass's snapshots are complete (`finalizeSnapshots`).
    fn finalize_snapshots(&self);
    /// The pass settled (`recovered`).
    fn recovered(&self);
}

/// A tenant's handle on its server. Distinct from another's for as long as it
/// is subscribed.
pub type TenantId = u64;

/// What one body chunk changed (`server.ts:413`-`:454`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChunkOutcome {
    /// The stream has seen `server.connected`: a later failure reconnects
    /// instead of failing the server (`server.ts:456`-`:468`).
    pub established: bool,
    /// The stream failed; the events parsed before the failure were delivered.
    pub failed: Option<StreamError>,
    /// An event asked for a recovery run (`void this.recover()`).
    pub recover: bool,
}

/// One buffered event, with the watermark it is replayed at.
struct Buffered {
    data: Value,
    watermark: u64,
}

/// One server's per-event state.
pub struct ServerCore {
    stream: EventStream,
    routes: Routes,
    secrets: Vec<String>,
    tenants: IndexMap<TenantId, Arc<dyn Tenant>>,
    next_tenant: TenantId,
    sequences: RecentMap<f64>,
    sequence: u64,
    established: bool,
    recovering: bool,
    recovery_started: u64,
    recovery_stale: bool,
    buffered: Vec<Buffered>,
    buffered_bytes: usize,
}

impl ServerCore {
    /// A server whose sessions redact `secrets` (`ServerSecrets.parse`).
    pub fn new(secrets: Vec<String>) -> Result<Self, SecretError> {
        check_secrets(&secrets)?;
        Ok(Self {
            stream: EventStream::new(),
            routes: Routes::new(),
            secrets,
            tenants: IndexMap::new(),
            next_tenant: 0,
            sequences: RecentMap::new(SEQUENCES),
            sequence: 0,
            established: false,
            recovering: false,
            recovery_started: 0,
            recovery_stale: false,
            buffered: Vec::new(),
            buffered_bytes: 0,
        })
    }

    /// `addSecret`: the list is validated, and the secret is added to the
    /// redaction set once (`server.ts:144`-`:152`).
    pub fn add_secret(&mut self, secret: String) -> Result<(), SecretError> {
        let mut candidate = self.secrets.clone();
        candidate.push(secret.clone());
        check_secrets(&candidate)?;
        if !self.secrets.contains(&secret) {
            self.secrets.push(secret);
        }
        Ok(())
    }

    /// `subscribe`: a session joins, bounded at 128, and every cached route is
    /// invalidated. A recovering server tells the newcomer it is disconnected.
    pub fn subscribe(&mut self, tenant: Arc<dyn Tenant>) -> Result<TenantId, SubscribeError> {
        if self.tenants.len() >= MAX_TENANTS {
            return Err(SubscribeError);
        }
        self.routes.clear();
        let id = self.next_tenant;
        self.next_tenant = self.next_tenant.saturating_add(1);
        self.tenants.insert(id, tenant);
        if self.recovering
            && let Some(tenant) = self.tenants.get(&id)
        {
            tenant.disconnected(self.recovery_started);
        }
        Ok(id)
    }

    /// The unsubscribe closure `subscribe` returns: the session leaves and every
    /// cached route is invalidated, whether it was subscribed or not.
    pub fn unsubscribe(&mut self, id: TenantId) {
        self.tenants.shift_remove(&id);
        self.routes.clear();
    }

    /// `eventWatermark`: the last sequence number handed out.
    pub fn watermark(&self) -> u64 {
        self.sequence
    }

    /// `recovering`.
    pub fn recovering(&self) -> bool {
        self.recovering
    }

    /// `recoveryStale`: buffered events were dropped, so a pass must restart.
    pub fn stale(&self) -> bool {
        self.recovery_stale
    }

    /// `beginRecovery(started = this.sequence)` (`server.ts:385`-`:390`): once
    /// per pass, every tenant is told it is disconnected from `started`.
    pub fn begin_recovery(&mut self, started: u64) {
        if self.recovering {
            return;
        }
        self.recovering = true;
        self.recovery_started = started;
        for tenant in self.tenants.values() {
            tenant.disconnected(started);
        }
    }

    /// `restartRecovery` (`server.ts:537`-`:543`): a retry is a new disconnect
    /// at the current watermark, and the buffer starts empty.
    pub fn restart_recovery(&mut self) {
        self.recovery_stale = false;
        self.buffered.clear();
        self.buffered_bytes = 0;
        self.recovery_started = self.sequence;
        for tenant in self.tenants.values() {
            tenant.disconnected(self.sequence);
        }
    }

    /// `recoverOnce`'s tail, after the shell's awaited `resync` and
    /// `prepareReplay` (`server.ts:552`-`:560`). False when buffered events were
    /// dropped and the pass must start again.
    pub fn replay(&mut self) -> bool {
        if self.recovery_stale {
            return false;
        }
        for entry in std::mem::take(&mut self.buffered) {
            for tenant in self.tenants.values() {
                tenant.reconcile(&entry.data, entry.watermark);
            }
        }
        for tenant in self.tenants.values() {
            tenant.finalize_snapshots();
        }
        self.buffered_bytes = 0;
        self.recovering = false;
        for tenant in self.tenants.values() {
            tenant.recovered();
        }
        true
    }

    /// One body chunk: activity to every tenant, then each event's statements in
    /// the TypeScript's order.
    pub fn chunk(&mut self, bytes: &[u8]) -> ChunkOutcome {
        // `onActivity` runs when the chunk is read, before it is decoded.
        self.note_all(ACTIVITY, "{}".to_owned());
        let mut outcome = ChunkOutcome::default();
        let mut events = Vec::new();
        let result = self.stream.push(bytes, &mut events);
        self.deliver(events, &mut outcome);
        if outcome.failed.is_none()
            && let Err(error) = result
        {
            self.stream.reset();
            outcome.failed = Some(error);
        }
        outcome.established = self.established;
        outcome
    }

    /// The end of the body: the SDK's final flush, then a fresh stream for the
    /// next connection.
    pub fn end(&mut self) -> ChunkOutcome {
        let mut outcome = ChunkOutcome::default();
        let mut events = Vec::new();
        let result = self.stream.end(&mut events);
        self.deliver(events, &mut outcome);
        if outcome.failed.is_none()
            && let Err(error) = result
        {
            outcome.failed = Some(error);
        }
        self.stream.reset();
        outcome.established = self.established;
        outcome
    }

    /// Delivers events in parse order, stopping at the first the path refuses
    /// (the TypeScript's thrown body closes the iterator).
    fn deliver(&mut self, events: Vec<Value>, outcome: &mut ChunkOutcome) {
        for native in events {
            if let Err(error) = self.apply(&native, outcome) {
                self.stream.reset();
                outcome.failed = Some(error);
                return;
            }
        }
    }

    /// `consumeEvents`' loop body, one statement at a time.
    fn apply(&mut self, native: &Value, outcome: &mut ChunkOutcome) -> Result<(), StreamError> {
        let data = {
            let secrets: Vec<&str> = self.secrets.iter().map(String::as_str).collect();
            sanitize(native, &secrets)
        };
        let value: &Value = data.as_ref();
        let event = parse_native_event(value)?;
        self.sequence = self.sequence.saturating_add(1);
        let watermark = self.sequence;
        if event.typ == "server.connected" {
            self.established = true;
            if self.recovering {
                // recover() retries until the server closes.
                outcome.recover = true;
            }
            return Ok(());
        }
        let targets = self.routes.select(value, watermark, &self.tenants);
        if targets.is_empty() {
            return Ok(());
        }
        if let Some(durable) = &event.durable {
            let previous = self.sequences.get(durable.aggregate_id).copied();
            // The first seq may include an inherited fork prefix: baseline first.
            if let Some(previous) = previous
                && durable.seq > previous + 1.0
            {
                self.begin_recovery(watermark - 1);
                outcome.recover = true;
            }
            if previous.is_none_or(|previous| durable.seq > previous) {
                self.sequences
                    .set(durable.aggregate_id.to_owned(), durable.seq);
            }
        }
        if self.recovering {
            let bytes = ace_json::to_string(value).len();
            self.buffered_bytes += bytes;
            self.buffered.push(Buffered {
                data: value.clone(),
                watermark,
            });
            if self.buffered.len() > MAX_BUFFERED_EVENTS || self.buffered_bytes > MAX_BUFFERED_BYTES
            {
                // Memory stays bounded; a fresh snapshot covers what is dropped.
                self.buffered.clear();
                self.buffered_bytes = 0;
                self.recovery_stale = true;
                let text = note(&[("watermark", Value::from(watermark))]);
                for tenant in &targets {
                    publish(tenant.as_ref(), RESTARTED, text.clone());
                }
                return Ok(());
            }
            let text = note(&[
                ("id", Value::from(event.id)),
                ("type", Value::from(event.typ)),
                ("watermark", Value::from(watermark)),
            ]);
            for tenant in &targets {
                tenant.buffered(value, watermark);
                publish(tenant.as_ref(), BUFFERED, text.clone());
            }
        } else {
            for tenant in &targets {
                tenant.receive(value);
            }
        }
        Ok(())
    }

    /// `c.frame("note", channel, data)` for every tenant, in subscription order.
    fn note_all(&self, channel: &'static str, text: String) {
        for tenant in self.tenants.values() {
            publish(tenant.as_ref(), channel, text.clone());
        }
    }
}

/// Why a tenant could not join: "OpenCode session limit reached".
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("OpenCode session limit reached")]
pub struct SubscribeError;

/// `ServerSecrets.parse` over one list, in the same order and with the same
/// code-point bounds (rule 17).
fn check_secrets(secrets: &[String]) -> Result<(), SecretError> {
    if secrets.len() > MAX_SECRETS {
        return Err(SecretError::TooMany);
    }
    if secrets
        .iter()
        .any(|secret| secret.is_empty() || secret.chars().count() > MAX_SECRET_CHARS)
    {
        return Err(SecretError::Length);
    }
    Ok(())
}

/// A note's text, `JSON.stringify`d with `ace_json` so a string field escapes
/// exactly as JavaScript escapes it.
fn note(fields: &[(&str, Value)]) -> String {
    let mut map = Map::new();
    for (key, value) in fields {
        map.insert((*key).to_owned(), value.clone());
    }
    ace_json::to_string(&Value::Object(map))
}

/// One note on a tenant's queue; the queue assigns its seq.
fn publish(tenant: &dyn Tenant, channel: &'static str, text: String) {
    tenant.queue().publish(vec![SessionEvent::Frame {
        seq: 0,
        dir: FrameDirection::Note,
        channel: channel.to_owned(),
        text,
    }]);
}

#[cfg(test)]
mod tests;
