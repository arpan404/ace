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
//!
//! What stays TypeScript (E3-opencode.4): the fetch and body reader, the
//! silence timer, the reconnect loop, and a pass's awaited resync and
//! prepareReplay. [`ChunkOutcome::recover`] asks the shell for that pass.

use ace_adapter_api::bridge::EventQueue;
use ace_json::Value;
use indexmap::IndexMap;
use std::sync::Arc;

use crate::translate::boundaries::parse_native_event;
use crate::translate::cache::RecentMap;
use crate::translate::redaction::sanitize;

use super::error::{SecretError, StreamError};
use super::notes::{ACTIVITY, BUFFERED, RESTARTED, publish, text as note};
use super::routes::Routes;
use super::stream::{EventStream, Step};

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

/// One session on a server, as the per-event path needs it (E3-opencode.2).
pub trait Tenant: Send + Sync {
    /// The tenant's ordered queue, where this core publishes its notes.
    fn queue(&self) -> &EventQueue;
    /// `routes.select`'s filter: whether this session owns the event at this
    /// watermark.
    fn accepts(&self, data: &Value, watermark: u64) -> bool;
    /// One routed event while not recovering. `Err` is the TypeScript's thrown
    /// body, which fails the stream.
    fn receive(&self, data: &Value, watermark: u64) -> Result<(), TenantError>;
    /// One routed event while recovering, replayed later at `watermark`.
    fn buffered(&self, data: &Value, watermark: u64) -> Result<(), TenantError>;
    /// Recovery began at `started`.
    fn disconnected(&self, started: u64);
    /// One buffered event replayed, in the buffer's order.
    fn reconcile(&self, data: &Value, watermark: u64) -> Result<(), TenantError>;
    /// The pass's snapshots are complete (`finalizeSnapshots`).
    fn finalize_snapshots(&self) -> Result<(), TenantError>;
    /// The pass settled (`recovered`).
    fn recovered(&self);
}

/// A tenant's handle on its server. Distinct from another's for as long as it
/// is subscribed.
pub type TenantId = u64;

/// Why a tenant refused an event, as the TypeScript's thrown `Error` or
/// `ZodError` text. The server fails the stream with it, so the facade
/// reconnects exactly as `consumeEvents` does when the body throws.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct TenantError(pub String);

/// What one body chunk changed (`server.ts:413`-`:454`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
    /// `options.secrets`: the list `ServerSecrets.parse` validated.
    declared: Vec<String>,
    /// The redaction set: `declared` plus the server's authorization (`server.ts:221`).
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
            declared: secrets.clone(),
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

    /// `addSecret` (`server.ts:144`-`:152`): the declared list is validated with
    /// the entry appended, duplicates included, then the redaction set takes it.
    pub fn add_secret(&mut self, secret: String) -> Result<(), SecretError> {
        let mut declared = self.declared.clone();
        declared.push(secret.clone());
        check_secrets(&declared)?;
        self.declared = declared;
        if !self.secrets.contains(&secret) {
            self.secrets.push(secret);
        }
        Ok(())
    }

    /// `this.secrets = [...options.secrets, password]` (`server.ts:221`): the
    /// authorization is redacted but never counted against `ServerSecrets`.
    pub fn add_authorization(&mut self, authorization: String) {
        if !self.secrets.contains(&authorization) {
            self.secrets.push(authorization);
        }
    }

    /// The redaction set, for a caller redacting outside a chunk.
    pub fn secrets(&self) -> &[String] {
        &self.secrets
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
                if tenant.reconcile(&entry.data, entry.watermark).is_err() {
                    // The TypeScript's per-consumer failure ends that session;
                    // this seam has no per-tenant exit, so the pass proceeds.
                }
            }
        }
        for tenant in self.tenants.values() {
            let _ = tenant.finalize_snapshots();
        }
        self.buffered_bytes = 0;
        self.recovering = false;
        for tenant in self.tenants.values() {
            tenant.recovered();
        }
        true
    }

    /// One body chunk: its elided pieces in order, each activity note before
    /// that piece's events, as the SDK reads them.
    pub fn chunk(&mut self, bytes: &[u8]) -> ChunkOutcome {
        let mut outcome = ChunkOutcome::default();
        let mut steps = Vec::new();
        let result = self.stream.push(bytes, &mut steps);
        self.deliver(steps, &mut outcome);
        if outcome.failed.is_none()
            && let Err(error) = result
        {
            self.stream.reset();
            outcome.failed = Some(error);
        }
        outcome.established = self.established;
        outcome
    }

    /// The end of the body: the elider's flush pieces, the SDK's final read,
    /// then a fresh stream for the next connection.
    pub fn end(&mut self) -> ChunkOutcome {
        let mut outcome = ChunkOutcome::default();
        let mut steps = Vec::new();
        let result = self.stream.end(&mut steps);
        self.deliver(steps, &mut outcome);
        if outcome.failed.is_none()
            && let Err(error) = result
        {
            outcome.failed = Some(error);
        }
        self.stream.reset();
        outcome.established = self.established;
        outcome
    }

    /// `activity()` (`server.ts:399`-`:403`): one read's activity, to every tenant.
    /// The facade calls it at connection start (`:407`) and per `onActivity`.
    pub fn activity(&mut self) {
        self.note_all(ACTIVITY, "{}".to_owned());
    }

    /// Delivers steps in read order, stopping at the first event the path
    /// refuses (the TypeScript's thrown body closes the iterator).
    fn deliver(&mut self, steps: Vec<Step>, outcome: &mut ChunkOutcome) {
        for step in steps {
            match step {
                Step::Activity => self.activity(),
                Step::Event(native) => {
                    if let Err(error) = self.apply(&native, outcome) {
                        self.stream.reset();
                        outcome.failed = Some(error);
                        return;
                    }
                }
            }
        }
    }

    /// `consumeEvents`' loop body, one statement at a time.
    fn apply(&mut self, native: &Value, outcome: &mut ChunkOutcome) -> Result<(), StreamError> {
        let data = sanitize(native, &self.secrets);
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
            // The buffer takes the sanitized value, moving it when the secret
            // scrub already had to copy (the last read of `event` is above).
            let text = note(&[
                ("id", Value::from(event.id)),
                ("type", Value::from(event.typ)),
                ("watermark", Value::from(watermark)),
            ]);
            self.buffered_bytes += bytes;
            self.buffered.push(Buffered {
                data: data.into_owned(),
                watermark,
            });
            let at = self.buffered.len() - 1;
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
            for tenant in &targets {
                tenant
                    .buffered(&self.buffered[at].data, watermark)
                    .map_err(fail)?;
                publish(tenant.as_ref(), BUFFERED, text.clone());
            }
        } else {
            for tenant in &targets {
                tenant.receive(value, watermark).map_err(fail)?;
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

/// A tenant's refusal as a stream failure (the TypeScript reconnects).
fn fail(error: TenantError) -> StreamError {
    StreamError::Tenant(error.0)
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

#[cfg(test)]
mod tests;
