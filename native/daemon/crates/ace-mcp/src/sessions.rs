// SPDX-License-Identifier: Apache-2.0
//! 2025 transport sessions, ported from `legacy-sessions.ts`: a lease keeps at most four, a
//! reinitializing client supersedes its oldest, and the server-wide cap serves a new client
//! statelessly rather than failing it. A session ends with `DELETE`, with its lease, or when a
//! newer one from the same lease replaces it.
//!
//! The ids are the one thing the transport generates; they are injected so a test or the daemon
//! owns the randomness.

use std::sync::Arc;

use indexmap::IndexMap;

use crate::credentials::Principal;
use crate::limits::LEGACY_SESSIONS_PER_LEASE;

/// The id generator a server uses (`randomUUID` today).
pub type SessionIds = Arc<dyn Fn() -> String + Send + Sync>;

/// One open legacy transport session.
#[derive(Clone)]
pub struct LegacySession {
    pub id: String,
    pub principal: Principal,
    pub opened: u64,
}

/// The legacy sessions one server holds.
pub struct LegacySessions {
    entries: IndexMap<String, LegacySession>,
    next: u64,
    per_lease: usize,
    total: usize,
    generate: SessionIds,
}

impl std::fmt::Debug for LegacySessions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LegacySessions")
            .field("open", &self.entries.len())
            .finish_non_exhaustive()
    }
}

impl LegacySessions {
    pub fn new(total: usize, generate: SessionIds) -> LegacySessions {
        LegacySessions::with_per_lease(total, LEGACY_SESSIONS_PER_LEASE, generate)
    }

    /// A cap and a per-lease bound, for a test's small numbers.
    pub fn with_per_lease(total: usize, per_lease: usize, generate: SessionIds) -> LegacySessions {
        LegacySessions {
            entries: IndexMap::new(),
            next: 0,
            per_lease: per_lease.max(1),
            total: total.max(1),
            generate,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Opens a session for `principal`, superseding its oldest. `None` at the server-wide cap:
    /// the caller serves the request statelessly.
    pub fn open(&mut self, principal: &Principal) -> Option<String> {
        let owned: Vec<String> = self
            .entries
            .values()
            .filter(|session| same_lease(&session.principal, principal))
            .map(|session| session.id.clone())
            .collect();
        if owned.len() >= self.per_lease
            && let Some(oldest) = owned.first()
        {
            self.entries.shift_remove(oldest);
        }
        if self.entries.len() >= self.total {
            return None;
        }
        let id = (self.generate)();
        if id.is_empty() || self.entries.contains_key(&id) {
            return None;
        }
        self.next += 1;
        self.entries.insert(
            id.clone(),
            LegacySession {
                id: id.clone(),
                principal: principal.clone(),
                opened: self.next,
            },
        );
        Some(id)
    }

    /// The session `id` for `principal`, or `None` for an unknown id, another lease's id, or a
    /// lease that has ended.
    pub fn find(&mut self, id: &str, principal: &Principal) -> Option<&LegacySession> {
        let ended = self
            .entries
            .get(id)
            .is_some_and(|session| session.principal.lifetime.aborted());
        if ended {
            self.entries.shift_remove(id);
            return None;
        }
        self.entries
            .get(id)
            .filter(|session| same_lease(&session.principal, principal))
    }

    /// Ends `id`; false when it was not this lease's.
    pub fn close(&mut self, id: &str, principal: &Principal) -> bool {
        if self.find(id, principal).is_some() {
            self.entries.shift_remove(id);
            true
        } else {
            false
        }
    }

    pub fn close_all(&mut self) {
        self.entries.clear();
    }

    /// The sessions of one lease, in open order (`toolsChangedFor`).
    pub fn of(&self, principal: &Principal) -> Vec<String> {
        self.entries
            .values()
            .filter(|session| same_lease(&session.principal, principal))
            .map(|session| session.id.clone())
            .collect()
    }
}

/// Two principals are the same lease when they share the scope the authenticator handed out.
fn same_lease(left: &Principal, right: &Principal) -> bool {
    Arc::ptr_eq(&left.scope, &right.scope)
}

#[cfg(test)]
mod tests {
    // Ported from `legacy-lifetime.process` and the legacy handshake case of `http.process`.
    use super::*;
    use crate::credentials::{CredentialRegistry, McpScope};
    use crate::signal::Abort;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn ids() -> SessionIds {
        let next = Arc::new(AtomicU64::new(1));
        Arc::new(move || {
            let id = next.fetch_add(1, Ordering::SeqCst);
            format!("session-{id}")
        })
    }

    fn credentials(seed: u8) -> CredentialRegistry {
        let next = Arc::new(AtomicU64::new(seed as u64));
        CredentialRegistry::new(move || {
            let value = next.fetch_add(1, Ordering::SeqCst);
            format!("{value:064x}")
        })
    }

    fn lease(credentials: &CredentialRegistry, agent: &str) -> SessionLease {
        credentials
            .issue(
                McpScope::new("provider", "thread", agent, &[]),
                &Abort::new(),
            )
            .expect("lease")
    }

    use crate::credentials::SessionLease;

    #[test]
    fn a_reinitializing_client_supersedes_its_oldest_and_another_lease_cannot_use_the_id() {
        let credentials = credentials(1);
        let first = lease(&credentials, "root");
        let other = lease(&credentials, "other");
        let mut sessions = LegacySessions::with_per_lease(16, 2, ids());
        let one = sessions.open(&first.principal).expect("first");
        let two = sessions.open(&first.principal).expect("second");
        assert_eq!(sessions.len(), 2);
        let three = sessions.open(&first.principal).expect("third");
        assert_eq!(sessions.len(), 2, "a lease keeps only its bound");
        assert!(
            sessions.find(&one, &first.principal).is_none(),
            "the oldest was not superseded"
        );
        assert!(sessions.find(&two, &first.principal).is_some());
        assert!(sessions.find(&three, &first.principal).is_some());
        // The same id is not another lease's session.
        assert!(sessions.find(&two, &other.principal).is_none());
        assert!(!sessions.close(&two, &other.principal));
        assert!(sessions.close(&two, &first.principal));
        assert!(sessions.find(&two, &first.principal).is_none());
    }

    #[test]
    fn the_server_wide_cap_serves_a_new_client_without_a_session() {
        let credentials = credentials(2);
        let mut sessions = LegacySessions::with_per_lease(2, 2, ids());
        let first = lease(&credentials, "root");
        assert!(sessions.open(&first.principal).is_some());
        let second = lease(&credentials, "two");
        assert!(sessions.open(&second.principal).is_some());
        let third = lease(&credentials, "three");
        assert!(
            sessions.open(&third.principal).is_none(),
            "the cap admitted a third"
        );
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn a_lease_ending_ends_its_sessions() {
        let credentials = credentials(3);
        let lifetime = Abort::new();
        let lease = credentials
            .issue(McpScope::new("provider", "thread", "root", &[]), &lifetime)
            .expect("lease");
        let mut sessions = LegacySessions::new(16, ids());
        let id = sessions.open(&lease.principal).expect("session");
        assert!(sessions.find(&id, &lease.principal).is_some());
        lifetime.abort();
        assert!(sessions.find(&id, &lease.principal).is_none());
        assert!(sessions.is_empty());
    }
}
