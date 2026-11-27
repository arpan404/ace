// SPDX-License-Identifier: Apache-2.0
//! Leases and bearers, ported from `packages/mcp-server/src/credentials.ts`.
//!
//! A lease is a 256-bit hex bearer, stored by its SHA-256 digest, tied to one scope and one
//! lifetime: at most 1,024 live, optionally expiring (at most 24 hours), revoked by `end()`, by its
//! lifetime aborting, or by the registry closing. The authenticator is asked on every request, so a
//! revocation applies to the next one. Only the lease carries the bearer.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;
use sha2::{Digest as _, Sha256};

use crate::limits::{MAX_CREDENTIAL_AGE_MS, MAX_LEASES};
use crate::signal::{Abort, Scheduler};

/// The identity of one lease. Two leases can carry the same scope and session id; their state
/// (calls, opened families, streams) still belongs to each lease alone, as the TypeScript's
/// per-`Principal` `WeakMap`s keep it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LeaseId(pub(crate) u64);

/// A caller's scope (`McpScope`): which session, thread and agent, and what it may reach.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct McpScope {
    pub session_id: String,
    pub thread_id: String,
    pub agent_id: String,
    pub capabilities: Vec<String>,
}

/// The `McpCapability` values, in the protocol's order.
pub const CAPABILITIES: [&str; 8] = [
    "browser",
    "notify",
    "agents",
    "thread_control",
    "automations",
    "projects",
    "screen",
    "devices",
];

impl McpScope {
    /// A scope with no capability, for an internal caller.
    pub fn new(session_id: &str, thread_id: &str, agent_id: &str, capabilities: &[&str]) -> Self {
        let mut scoped: Vec<String> = Vec::new();
        for capability in capabilities {
            let name = (*capability).to_owned();
            if !scoped.contains(&name) {
                scoped.push(name);
            }
        }
        Self {
            session_id: session_id.to_owned(),
            thread_id: thread_id.to_owned(),
            agent_id: agent_id.to_owned(),
            capabilities: scoped,
        }
    }

    /// Whether this scope holds `capability` (a null capability is offered to everyone).
    pub fn holds(&self, capability: Option<&str>) -> bool {
        match capability {
            Some(capability) => self.capabilities.iter().any(|held| held == capability),
            None => true,
        }
    }
}

/// Who a bearer belongs to. The signal aborts when the lease ends.
#[derive(Clone)]
pub struct Principal {
    pub scope: Arc<McpScope>,
    /// This lease's own identity, never its session's name.
    pub lease: LeaseId,
    pub lifetime: Abort,
}

/// Why a lease could not be issued. Every message is the TypeScript's own.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CredentialError {
    #[error("Invalid MCP credential lifetime")]
    InvalidLifetime,
    #[error("Credential registry closed")]
    Closed,
    #[error("Session ended")]
    Ended,
    #[error("Credential capacity reached")]
    Capacity,
    #[error("Credential generator must supply 256-bit hex")]
    BadSecret,
    #[error("Credential collision")]
    Collision,
    #[error("Invalid MCP scope")]
    InvalidScope,
}

/// A lease: the bearer (only here), its principal, and the way to end it.
pub struct SessionLease {
    pub bearer: String,
    pub principal: Principal,
    registry: Arc<CredentialCore>,
    key: String,
}

impl Clone for SessionLease {
    fn clone(&self) -> Self {
        Self {
            bearer: self.bearer.clone(),
            principal: self.principal.clone(),
            registry: Arc::clone(&self.registry),
            key: self.key.clone(),
        }
    }
}

impl std::fmt::Debug for SessionLease {
    /// The bearer is never printed.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionLease")
            .field("session", &self.principal.scope.session_id)
            .finish_non_exhaustive()
    }
}

impl SessionLease {
    /// Revokes the bearer now; a second call does nothing.
    pub fn end(&self) {
        self.registry.end(&self.key);
    }
}

/// The in-memory authority over leases.
pub struct CredentialRegistry {
    core: Arc<CredentialCore>,
}

impl std::fmt::Debug for CredentialRegistry {
    /// Bearers and principals never print; the count is the useful fact.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CredentialRegistry")
            .field("live", &self.live())
            .finish_non_exhaustive()
    }
}

/// A timer's cancel guard, kept beside its lease so ending it also cancels the expiry.
type TimerGuard = Box<dyn Fn() + Send + Sync>;

struct CredentialCore {
    entries: Mutex<IndexMap<String, Entry>>,
    secret: Box<dyn Fn() -> String + Send + Sync>,
    limit: usize,
    expiry: Option<(Arc<dyn Scheduler>, u64)>,
    next_lease: AtomicU64,
    closed: AtomicBool,
}

struct Entry {
    principal: Principal,
    expiry: Option<TimerGuard>,
    /// The bearer's digest, kept so authentication compares it in constant time.
    digest: [u8; 32],
}

impl CredentialRegistry {
    /// The registry `startMcpServer` makes when the host passes none.
    pub fn new(secret: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self::with_limit_and_expiry(secret, MAX_LEASES, None)
    }

    /// A registry with its own bound; `None` keeps the 1,024 default.
    pub fn with_limit(
        secret: impl Fn() -> String + Send + Sync + 'static,
        limit: Option<usize>,
    ) -> Self {
        Self::with_limit_and_expiry(secret, limit.unwrap_or(MAX_LEASES), None)
    }

    /// A registry whose leases expire after `max_age_ms`, using the daemon's timers.
    pub fn with_expiry(
        secret: impl Fn() -> String + Send + Sync + 'static,
        scheduler: Arc<dyn Scheduler>,
        max_age_ms: u64,
    ) -> Result<Self, CredentialError> {
        if max_age_ms == 0 || max_age_ms > MAX_CREDENTIAL_AGE_MS {
            return Err(CredentialError::InvalidLifetime);
        }
        Ok(Self::with_limit_and_expiry(
            secret,
            MAX_LEASES,
            Some((scheduler, max_age_ms)),
        ))
    }

    fn with_limit_and_expiry(
        secret: impl Fn() -> String + Send + Sync + 'static,
        limit: usize,
        expiry: Option<(Arc<dyn Scheduler>, u64)>,
    ) -> Self {
        Self {
            core: Arc::new(CredentialCore {
                entries: Mutex::new(IndexMap::new()),
                secret: Box::new(secret),
                limit,
                expiry,
                next_lease: AtomicU64::new(0),
                closed: AtomicBool::new(false),
            }),
        }
    }

    /// `issue`: a new lease for `scope`, revoked when `lifetime` aborts.
    pub fn issue(
        &self,
        scope: McpScope,
        lifetime: &Abort,
    ) -> Result<SessionLease, CredentialError> {
        let core = &self.core;
        if core.closed.load(Ordering::SeqCst) {
            return Err(CredentialError::Closed);
        }
        if lifetime.aborted() {
            return Err(CredentialError::Ended);
        }
        let mut entries = core
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if entries.len() >= core.limit {
            return Err(CredentialError::Capacity);
        }
        validate_scope(&scope)?;
        let bearer = (core.secret)();
        if !valid_bearer(&bearer) {
            return Err(CredentialError::BadSecret);
        }
        let digest = digest(&bearer);
        let key = hex(&digest);
        if entries.contains_key(&key) {
            return Err(CredentialError::Collision);
        }
        let ended = Abort::new();
        let principal = Principal {
            scope: Arc::new(scope),
            lease: LeaseId(core.next_lease.fetch_add(1, Ordering::SeqCst) + 1),
            lifetime: ended.clone(),
        };
        let expiry = core.expiry.as_ref().map(|(scheduler, max_age_ms)| {
            let registry = Arc::clone(core);
            let expired = key.clone();
            scheduler.after(*max_age_ms, Box::new(move || registry.end(&expired)))
        });
        entries.insert(
            key.clone(),
            Entry {
                principal: principal.clone(),
                expiry,
                digest,
            },
        );
        drop(entries);
        let registry = Arc::clone(core);
        let hooked = key.clone();
        lifetime.on_abort(Box::new(move || registry.end(&hooked)));
        Ok(SessionLease {
            bearer,
            principal,
            registry: Arc::clone(core),
            key,
        })
    }

    /// `authenticate`: the principal a bearer names, reading the store each time. Every live
    /// lease's digest is compared in constant time, so how long a refusal takes says nothing
    /// about how much of the bearer matched.
    pub fn authenticate(&self, bearer: &str) -> Option<Principal> {
        if !valid_bearer(bearer) {
            return None;
        }
        let presented = digest(bearer);
        let entries = self
            .core
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut found: Option<&Entry> = None;
        for entry in entries.values() {
            if constant_time_equal(&entry.digest, &presented) && found.is_none() {
                found = Some(entry);
            }
        }
        found.map(|entry| entry.principal.clone())
    }

    /// Revokes every lease.
    pub fn close(&self) {
        self.core.closed.store(true, Ordering::SeqCst);
        let keys: Vec<String> = {
            let entries = self
                .core
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            entries.keys().cloned().collect()
        };
        for key in keys {
            self.core.end(&key);
        }
    }

    /// How many leases are live.
    pub fn live(&self) -> usize {
        self.core
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }
}

impl CredentialCore {
    fn end(&self, key: &str) {
        let entry = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shift_remove(key);
        if let Some(entry) = entry {
            if let Some(cancel) = entry.expiry {
                cancel();
            }
            entry.principal.lifetime.abort();
        }
    }
}

fn validate_scope(scope: &McpScope) -> Result<(), CredentialError> {
    let session = scope.session_id.chars().count();
    if !(1..=256).contains(&session) || scope.thread_id.is_empty() || scope.agent_id.is_empty() {
        return Err(CredentialError::InvalidScope);
    }
    if scope.capabilities.len() > CAPABILITIES.len()
        || !scope
            .capabilities
            .iter()
            .all(|capability| CAPABILITIES.contains(&capability.as_str()))
    {
        return Err(CredentialError::InvalidScope);
    }
    Ok(())
}

/// A bearer is 256 bits as lowercase hex.
fn valid_bearer(bearer: &str) -> bool {
    bearer.len() == 64
        && bearer
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn digest(bearer: &str) -> [u8; 32] {
    Sha256::digest(bearer.as_bytes()).into()
}

fn hex(digest: &[u8; 32]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Compares in constant time: no byte's position shortens the work.
fn constant_time_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    // Ported from the cases `lifetime.process` and `legacy-lifetime.process` pin: issue,
    // authenticate, revoke by end, by lifetime and by close, plus the bearer's shape.
    use super::*;

    fn hex(seed: u8) -> String {
        format!("{:02x}", seed.wrapping_mul(0xab)).repeat(32)
    }

    fn scope() -> McpScope {
        McpScope::new("session", "thread", "root", &["agents"])
    }

    #[test]
    fn a_lease_authenticates_its_own_bearer_and_no_other() {
        let registry = CredentialRegistry::new(|| hex(1));
        let lease = registry.issue(scope(), &Abort::new()).expect("issue");
        assert_eq!(lease.bearer, hex(1));
        let principal = registry.authenticate(&lease.bearer).expect("principal");
        assert_eq!(principal.scope.session_id, "session");
        assert!(principal.scope.holds(Some("agents")));
        assert!(!principal.scope.holds(Some("browser")));
        assert!(registry.authenticate(&hex(2)).is_none());
        assert!(registry.authenticate("not a bearer").is_none());
        assert!(registry.authenticate(&hex(1).to_uppercase()).is_none());
    }

    #[test]
    fn ending_a_lease_revokes_it_for_the_next_request_and_aborts_its_principal() {
        let registry = CredentialRegistry::new(|| hex(3));
        let lease = registry.issue(scope(), &Abort::new()).expect("issue");
        let principal = lease.principal.clone();
        lease.end();
        lease.end();
        assert!(principal.lifetime.aborted());
        assert!(registry.authenticate(&lease.bearer).is_none());
        assert_eq!(registry.live(), 0);
    }

    #[test]
    fn a_leases_lifetime_aborting_revokes_it() {
        let registry = CredentialRegistry::new(|| hex(4));
        let lifetime = Abort::new();
        let lease = registry.issue(scope(), &lifetime).expect("issue");
        lifetime.abort();
        assert!(registry.authenticate(&lease.bearer).is_none());
        assert!(lease.principal.lifetime.aborted());
    }

    #[test]
    fn the_registry_refuses_a_bad_bearer_a_collision_and_its_capacity() {
        let bad = CredentialRegistry::new(|| "secret".to_owned());
        assert_eq!(
            bad.issue(scope(), &Abort::new()).unwrap_err(),
            CredentialError::BadSecret
        );

        let repeated = CredentialRegistry::new(|| hex(5));
        let _first = repeated.issue(scope(), &Abort::new()).expect("issue");
        assert_eq!(
            repeated.issue(scope(), &Abort::new()).unwrap_err(),
            CredentialError::Collision
        );

        let seed = std::sync::atomic::AtomicU8::new(0);
        let bounded = CredentialRegistry::with_limit(
            move || {
                let next = seed.fetch_add(1, Ordering::SeqCst) + 1;
                format!("{:02x}", next).repeat(32)
            },
            Some(1),
        );
        let _only = bounded.issue(scope(), &Abort::new()).expect("issue");
        assert_eq!(
            bounded.issue(scope(), &Abort::new()).unwrap_err(),
            CredentialError::Capacity
        );
    }

    #[test]
    fn closing_revokes_every_lease_and_ends_the_registry() {
        let seed = std::sync::atomic::AtomicU8::new(0);
        let registry = CredentialRegistry::new(move || {
            let next = seed.fetch_add(1, Ordering::SeqCst) + 1;
            format!("{:02x}", next).repeat(32)
        });
        let first = registry.issue(scope(), &Abort::new()).expect("issue");
        let second = registry.issue(scope(), &Abort::new()).expect("issue");
        registry.close();
        assert!(registry.authenticate(&first.bearer).is_none());
        assert!(registry.authenticate(&second.bearer).is_none());
        assert_eq!(
            registry.issue(scope(), &Abort::new()).unwrap_err(),
            CredentialError::Closed
        );
        assert!(first.principal.lifetime.aborted());
    }

    #[test]
    fn an_expiring_lease_ends_when_its_timer_fires() {
        let scheduler = Arc::new(crate::signal::ManualScheduler::default());
        let registry = CredentialRegistry::with_expiry(|| hex(6), scheduler.clone(), 60_000)
            .expect("registry");
        let lease = registry.issue(scope(), &Abort::new()).expect("issue");
        assert_eq!(
            scheduler.armed(),
            vec![60_000],
            "the expiry is one timer of the lease's age"
        );
        scheduler.fire_all();
        assert!(registry.authenticate(&lease.bearer).is_none());
    }

    #[test]
    fn an_invalid_lifetime_is_refused() {
        let scheduler = Arc::new(crate::signal::ManualScheduler::default());
        assert_eq!(
            CredentialRegistry::with_expiry(|| hex(7), scheduler.clone(), 0).unwrap_err(),
            CredentialError::InvalidLifetime
        );
        assert_eq!(
            CredentialRegistry::with_expiry(|| hex(7), scheduler, MAX_CREDENTIAL_AGE_MS + 1,)
                .unwrap_err(),
            CredentialError::InvalidLifetime
        );
    }

    #[test]
    fn a_scope_outside_the_protocol_is_refused() {
        let registry = CredentialRegistry::new(|| hex(8));
        let mut scope = scope();
        scope.capabilities.push("telepathy".to_owned());
        assert_eq!(
            registry.issue(scope, &Abort::new()).unwrap_err(),
            CredentialError::InvalidScope
        );
    }
}
