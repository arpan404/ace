// SPDX-License-Identifier: Apache-2.0
//! Per-lease brief, fixed session guidance, and "since your last ace call" digest, ported from
//! `packages/mcp-server/src/awareness.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use indexmap::IndexMap;

use crate::brief::{
    AccessMode, ChildSummary, DelegateTarget, SessionFacts, render_brief, render_digest,
    utf16_prefix,
};
use crate::credentials::{LeaseId, McpScope, Principal};
use crate::roles::{SessionRoles, render_roles};

/// The daemon's canonical facts for one caller, excluding groups, delegates and lastFailure
/// (which the server supplies).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CallerFacts {
    pub project: Option<String>,
    pub branch: Option<String>,
    pub worktree: bool,
    pub machine: Option<String>,
    pub access: Option<AccessMode>,
    pub live_siblings: u32,
    pub children: Vec<ChildSummary>,
    pub pending_requests: u32,
    pub notes: Vec<String>,
}

/// The daemon's canonical facts port for one caller.
pub trait AwarenessPort: Send + Sync {
    fn facts(&self, caller: &McpScope) -> Option<CallerFacts>;
    /// Only read for the brief and full facts: it may page a model catalog.
    fn delegates(&self, caller: &McpScope) -> Vec<DelegateTarget>;
    /// The person's roles from Settings, read once per session.
    fn roles(&self) -> SessionRoles {
        SessionRoles::default()
    }
}

/// What a session's guidance is rendered from, fixed at its first read so its cached prefix holds.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionGuidanceFacts {
    pub brief: Option<String>,
    pub groups: Option<Vec<String>>,
    pub roles: Option<String>,
    pub tools: Option<Vec<String>>,
    pub access: Option<AccessMode>,
}

/// One coalesced failure entry in a session's recent-failures log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailureEntry {
    pub tool: String,
    pub code: String,
    pub count: u32,
}

type GroupsFn = Arc<dyn Fn(&Principal) -> Vec<String> + Send + Sync>;
type ToolsFn = Arc<dyn Fn(&Principal) -> Vec<String> + Send + Sync>;

const MAX_FAILURE_SESSIONS: usize = 1_024;
const MAX_FAILURES_PER_SESSION: usize = 20;

#[derive(Default)]
struct State {
    seen: HashMap<LeaseId, SessionFacts>,
    failures: HashMap<LeaseId, String>,
    roles: HashMap<LeaseId, Option<String>>,
    fixed: HashMap<LeaseId, SessionGuidanceFacts>,
    /// Recent failed calls per session id, oldest session first, newest entry last.
    failure_log: IndexMap<String, Vec<FailureEntry>>,
}

/// Per-lease brief and "since your last ace call" digest. State keyed by `LeaseId` is never
/// shared between sessions, and callers should call `forget_lease` when a lease ends.
pub struct SessionAwareness {
    port: Arc<dyn AwarenessPort>,
    groups: GroupsFn,
    tools: ToolsFn,
    state: Mutex<State>,
}

impl SessionAwareness {
    pub fn new(
        port: Arc<dyn AwarenessPort>,
        groups: impl Fn(&Principal) -> Vec<String> + Send + Sync + 'static,
        tools: impl Fn(&Principal) -> Vec<String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            port,
            groups: Arc::new(groups),
            tools: Arc::new(tools),
            state: Mutex::new(State::default()),
        }
    }

    fn current(
        &self,
        principal: &Principal,
        delegates: bool,
        last_failure: Option<String>,
    ) -> Option<SessionFacts> {
        let base = self.port.facts(&principal.scope)?;
        Some(SessionFacts {
            project: base.project,
            branch: base.branch,
            worktree: base.worktree,
            machine: base.machine,
            access: base.access,
            groups: (self.groups)(principal),
            delegates: if delegates {
                self.port.delegates(&principal.scope)
            } else {
                Vec::new()
            },
            live_siblings: base.live_siblings,
            children: base.children,
            pending_requests: base.pending_requests,
            last_failure,
            notes: base.notes,
        })
    }

    /// Full facts; reading them does not advance the digest.
    pub fn facts(&self, principal: &Principal) -> Option<SessionFacts> {
        let last_failure = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.failures.get(&principal.lease).cloned()
        };
        self.current(principal, true, last_failure)
    }

    /// The brief, enabled groups, roles line, callable tools and access mode, as this session
    /// first read them. Fixed for the session so the provider's cached prefix holds.
    pub fn guidance(&self, principal: &Principal) -> SessionGuidanceFacts {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(fixed) = state.fixed.get(&principal.lease) {
                return fixed.clone();
            }
        }
        let last_failure = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.failures.get(&principal.lease).cloned()
        };
        let Some(facts) = self.current(principal, true, last_failure) else {
            return SessionGuidanceFacts::default();
        };
        let roles = self.roles_line(principal);
        let tools = (self.tools)(principal);
        let guidance = SessionGuidanceFacts {
            brief: Some(render_brief(&facts)),
            groups: Some(facts.groups.clone()),
            roles,
            tools: if tools.is_empty() { None } else { Some(tools) },
            access: facts.access,
        };
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.seen.entry(principal.lease).or_insert(facts);
        state
            .fixed
            .entry(principal.lease)
            .or_insert(guidance)
            .clone()
    }

    /// This session's roles line, rendered on its first read and kept as it was.
    pub fn roles_line(&self, principal: &Principal) -> Option<String> {
        {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(cached) = state.roles.get(&principal.lease) {
                return cached.clone();
            }
        }
        let rendered = render_roles(&self.port.roles());
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .roles
            .entry(principal.lease)
            .or_insert(rendered)
            .clone()
    }

    pub fn brief(&self, principal: &Principal) -> Option<String> {
        self.guidance(principal).brief
    }

    /// What changed since this session last heard from ace, then mark it seen.
    pub fn changes(&self, principal: &Principal) -> Option<String> {
        let last_failure = {
            let state = self
                .state
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.failures.get(&principal.lease).cloned()
        };
        let facts = self.current(principal, false, last_failure)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = state.seen.insert(principal.lease, facts.clone());
        before.and_then(|previous| render_digest(&previous, &facts))
    }

    /// Record a failed call for `principal`, updating both its `last_failure` and the bounded
    /// per-session recent-failures log.
    pub fn failed(&self, principal: &Principal, tool: &str, code: &str) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let combined = format!("{tool} {code}");
        state
            .failures
            .insert(principal.lease, utf16_prefix(&combined, 120).to_owned());

        let session = principal.scope.session_id.clone();
        let mut log = state.failure_log.shift_remove(&session).unwrap_or_default();
        if let Some(last) = log.last_mut()
            && last.tool == tool
            && last.code == code
        {
            last.count = last.count.saturating_add(1);
        } else {
            log.push(FailureEntry {
                tool: utf16_prefix(tool, 128).to_owned(),
                code: utf16_prefix(code, 64).to_owned(),
                count: 1,
            });
        }
        if log.len() > MAX_FAILURES_PER_SESSION {
            log.remove(0);
        }
        state.failure_log.insert(session, log);
        if state.failure_log.len() > MAX_FAILURE_SESSIONS {
            state.failure_log.shift_remove_index(0);
        }
    }

    /// This session's failed ace calls, newest first; repeats of the same failure are counted.
    pub fn recent_failures(&self, session_id: &str) -> Vec<FailureEntry> {
        let state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .failure_log
            .get(session_id)
            .map(|entries| entries.iter().rev().cloned().collect())
            .unwrap_or_default()
    }

    /// Release per-lease cached state when a lease ends.
    pub fn forget_lease(&self, lease: LeaseId) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.seen.remove(&lease);
        state.failures.remove(&lease);
        state.roles.remove(&lease);
        state.fixed.remove(&lease);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brief::ChildState;
    use crate::roles::SessionRole;
    use crate::signal::Abort;

    struct MutablePort {
        facts: Mutex<Option<CallerFacts>>,
        roles: Mutex<SessionRoles>,
    }

    impl AwarenessPort for MutablePort {
        fn facts(&self, _caller: &McpScope) -> Option<CallerFacts> {
            self.facts.lock().ok()?.clone()
        }

        fn delegates(&self, _caller: &McpScope) -> Vec<DelegateTarget> {
            vec![DelegateTarget {
                provider: "claude".to_owned(),
                modes: vec!["full-access".to_owned()],
                accounts: None,
            }]
        }

        fn roles(&self) -> SessionRoles {
            self.roles.lock().map(|r| r.clone()).unwrap_or_default()
        }
    }

    fn principal(lease_id: u64, session: &str) -> Principal {
        Principal {
            scope: Arc::new(McpScope::new(session, "thread-1", "agent-1", &["agents"])),
            lease: LeaseId(lease_id),
            lifetime: Abort::new(),
        }
    }

    #[test]
    fn guidance_stays_fixed_for_the_lease_while_changes_reports_subsequent_diffs() {
        let port = Arc::new(MutablePort {
            facts: Mutex::new(Some(CallerFacts {
                project: Some("ace".to_owned()),
                access: Some(AccessMode::Ask),
                ..CallerFacts::default()
            })),
            roles: Mutex::new(SessionRoles {
                build: Some(SessionRole {
                    provider: "claude".to_owned(),
                    model: Some("opus".to_owned()),
                    effort: None,
                    tier: None,
                }),
                ..SessionRoles::default()
            }),
        });
        let awareness = SessionAwareness::new(
            port.clone(),
            |_| vec!["agents".to_owned()],
            |_| vec!["context".to_owned(), "delegate".to_owned()],
        );
        let p = principal(1, "s1");

        let first = awareness.guidance(&p);
        assert!(first.brief.as_deref().unwrap_or_default().contains("Ask:"));
        assert_eq!(
            first.roles.as_deref(),
            Some("Roles: build claude opus. Delegate with runRole.")
        );

        // Mutate underlying facts & roles; guidance stays cached, while changes reports the diff.
        if let Ok(mut guard) = port.facts.lock()
            && let Some(f) = guard.as_mut()
        {
            f.access = Some(AccessMode::FullAccess);
            f.children.push(ChildSummary {
                id: "child-1234567890".to_owned(),
                label: "tests".to_owned(),
                state: ChildState::ResultAvailable,
            });
        }
        if let Ok(mut roles) = port.roles.lock() {
            roles.build = None;
        }

        assert_eq!(awareness.guidance(&p), first);
        let digest = awareness.changes(&p).unwrap_or_default();
        assert!(digest.contains("access is now full-access"));
        assert!(digest.contains("child child-12 \"tests\" finished"));
        // Second call with no new mutations returns None.
        assert_eq!(awareness.changes(&p), None);
    }

    #[test]
    fn failures_coalesce_consecutive_repeats_and_bound_history_and_sessions() {
        let port = Arc::new(MutablePort {
            facts: Mutex::new(Some(CallerFacts::default())),
            roles: Mutex::new(SessionRoles::default()),
        });
        let awareness = SessionAwareness::new(port, |_| vec![], |_| vec![]);
        let p = principal(1, "session-a");

        awareness.failed(&p, "delegate", "model_unavailable");
        awareness.failed(&p, "delegate", "model_unavailable");
        awareness.failed(&p, "wait", "timed_out");

        let recent = awareness.recent_failures("session-a");
        assert_eq!(
            recent,
            vec![
                FailureEntry {
                    tool: "wait".to_owned(),
                    code: "timed_out".to_owned(),
                    count: 1,
                },
                FailureEntry {
                    tool: "delegate".to_owned(),
                    code: "model_unavailable".to_owned(),
                    count: 2,
                },
            ]
        );

        // Exceed 20 distinct entries in one session: oldest drops.
        for i in 0..25 {
            awareness.failed(&p, &format!("tool-{i}"), "err");
        }
        let capped = awareness.recent_failures("session-a");
        assert_eq!(capped.len(), MAX_FAILURES_PER_SESSION);
        assert_eq!(capped[0].tool, "tool-24");

        // Exceed 1,024 sessions: oldest session evicts.
        for i in 0..MAX_FAILURE_SESSIONS {
            let other = principal(10 + i as u64, &format!("sess-{i}"));
            awareness.failed(&other, "t", "e");
        }
        assert!(awareness.recent_failures("session-a").is_empty());
        assert_eq!(
            awareness
                .recent_failures(&format!("sess-{}", MAX_FAILURE_SESSIONS - 1))
                .len(),
            1
        );
    }
}
