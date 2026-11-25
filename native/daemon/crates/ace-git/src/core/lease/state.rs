// SPDX-License-Identifier: Apache-2.0
//! Lease facts and the rules that decide whether one fences, clears on its
//! own, or retires (`packages/git/src/mutation-state.ts`).

use ace_json::{JsString, Map, Value};

use crate::core::lease::LeaseRecord;
use crate::core::paths::within;

/// Who holds a lease: this process (`running`, or `held` once quarantined),
/// this process without any record of it (`orphaned`), or the probed owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseOwnerState {
    Running,
    Held,
    Orphaned,
    Active,
    Quarantined,
    Unknown,
    Gone,
}

impl LeaseOwnerState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Held => "held",
            Self::Orphaned => "orphaned",
            Self::Active => "active",
            Self::Quarantined => "quarantined",
            Self::Unknown => "unknown",
            Self::Gone => "gone",
        }
    }
}

/// What a lease's recorded root is now (`lease-roots.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    Gone,
    Unregistered,
    Linked,
    Other,
}

impl RootKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Gone => "gone",
            Self::Unregistered => "unregistered",
            Self::Linked => "linked",
            Self::Other => "other",
        }
    }
}

/// Everything admission needs to know about one intent.
#[derive(Debug, Clone)]
pub struct LeaseFacts {
    pub record: LeaseRecord,
    pub owner: LeaseOwnerState,
    /// One kind per entry of `record.roots`.
    pub roots: Vec<RootKind>,
    /// The live processes that may still be doing this lease's work; `None`
    /// when no such evidence exists (a cleanup supervisor owns the proof).
    pub busy: Option<Vec<String>>,
}

/// `mutationState`'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationState {
    pub status: &'static str,
    pub leases: Vec<LeaseRecord>,
}

impl MutationState {
    pub fn available() -> Self {
        Self {
            status: "available",
            leases: Vec::new(),
        }
    }

    pub fn to_json(&self) -> String {
        let mut object = Map::new();
        object.insert(JsString::from("status"), Value::from(self.status));
        object.insert(
            JsString::from("leases"),
            Value::Array(self.leases.iter().map(LeaseRecord::to_value).collect()),
        );
        ace_json::to_string(&Value::Object(object))
    }
}

/// A root that no longer is a checkout of this repository can't be touched by its mutation.
const fn settled_root(kind: RootKind) -> bool {
    matches!(kind, RootKind::Gone | RootKind::Unregistered)
}

/// Owners that can't finish the lease themselves: stopped, forgotten, or ours and quarantined.
const fn abandoned(owner: LeaseOwnerState) -> bool {
    matches!(
        owner,
        LeaseOwnerState::Gone | LeaseOwnerState::Orphaned | LeaseOwnerState::Held
    )
}

/// Retired without asking: nothing can still be doing its work.
pub fn retires_automatically(facts: &LeaseFacts) -> bool {
    if facts.owner == LeaseOwnerState::Gone && facts.roots.iter().all(|kind| settled_root(*kind)) {
        return true;
    }
    abandoned(facts.owner) && facts.busy.as_ref().is_some_and(Vec::is_empty)
}

/// Retired when a person confirms it ("Clear stale lock").
pub fn retires_on_confirmation(facts: &LeaseFacts) -> bool {
    matches!(
        facts.owner,
        LeaseOwnerState::Gone | LeaseOwnerState::Orphaned
    ) && facts.busy.as_ref().is_none_or(|busy| busy.is_empty())
}

/// Worth waiting for: a live owner will finish it, or a live process holds it
/// and the lease retires on its own once that process ends.
pub fn clears_on_its_own(facts: &LeaseFacts) -> bool {
    if matches!(
        facts.owner,
        LeaseOwnerState::Active | LeaseOwnerState::Quarantined
    ) {
        return true;
    }
    abandoned(facts.owner) && facts.busy.as_ref().is_some_and(|busy| !busy.is_empty())
}

/// Only a mutation on a main checkout or a separate repository reaches shared state.
pub fn repository_wide(facts: &LeaseFacts) -> bool {
    facts.roots.contains(&RootKind::Other)
}

/// A linked worktree has its own index and HEAD: a mutation there reaches only
/// that checkout and the paths inside it. Anything else overlaps by path.
fn overlaps(root: &str, kind: Option<&RootKind>, path: &str) -> bool {
    if matches!(kind, Some(RootKind::Linked)) {
        return within(root, path);
    }
    within(root, path) || within(path, root)
}

/// Whether a lease fences `path`. This process's running leases never do; a
/// healthy foreign owner fences only the roots it overlaps; anything uncertain
/// fences those and the whole repository when it is repository-wide.
pub fn fences(facts: &LeaseFacts, path: &str) -> bool {
    if facts.owner == LeaseOwnerState::Running {
        return false;
    }
    let touched = facts
        .record
        .roots
        .iter()
        .enumerate()
        .any(|(index, root)| overlaps(root, facts.roots.get(index), path));
    if facts.owner == LeaseOwnerState::Active {
        return touched;
    }
    touched || repository_wide(facts)
}

pub fn lease_state(facts: &[LeaseFacts], path: &str) -> MutationState {
    let leases: Vec<LeaseRecord> = facts
        .iter()
        .filter(|entry| fences(entry, path))
        .map(|entry| entry.record.clone())
        .collect();
    MutationState {
        status: if leases.is_empty() {
            "available"
        } else {
            "quarantined"
        },
        leases,
    }
}

/// Plain words for the first fencing lease: which repository, which checkout, and why.
pub fn quarantine_message(facts: &LeaseFacts, repository: &str, since_ms: Option<i64>) -> String {
    let started = since_ms
        .map(|ms| {
            let text = epoch_iso_minute(ms);
            format!(" (started {text} UTC)")
        })
        .unwrap_or_default();
    let where_ = format!("a Git operation in {}{started}", facts.record.root);
    let blocked = format!("Git changes in {repository} are blocked");
    if let Some(busy) = facts.busy.as_ref().filter(|busy| !busy.is_empty()) {
        return format!(
            "{blocked}: {where_} is still held by {}. ace continues on its own once that ends.",
            busy.join(", ")
        );
    }
    match facts.owner {
        LeaseOwnerState::Active => {
            format!("Another ace daemon is running {where_}. {blocked} until it finishes.")
        }
        LeaseOwnerState::Gone => format!(
            "{blocked}: {where_} was interrupted when the ace daemon running it stopped. If nothing is still writing there, use Clear stale lock."
        ),
        LeaseOwnerState::Orphaned => format!(
            "{blocked}: {where_} was stopped and ace can't confirm its processes ended. If nothing is still writing there, use Clear stale lock."
        ),
        LeaseOwnerState::Unknown => format!(
            "{blocked}: {where_} belongs to an ace daemon that isn't answering. Wait for it, or stop it and then use Clear stale lock."
        ),
        _ => format!(
            "{blocked}: {where_} was stopped, but a process it started may still be writing. Restart the ace daemon, then use Clear stale lock."
        ),
    }
}

/// `Date.prototype.toISOString().slice(0,16).replace("T"," ")`: minute precision, UTC.
fn epoch_iso_minute(milliseconds: i64) -> String {
    let seconds = milliseconds.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let of_day = seconds.rem_euclid(86_400);
    let (hour, minute) = (of_day / 3600, (of_day % 3600) / 60);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}")
}

/// Howard Hinnant's `civil_from_days`.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::lease::{LeaseRecord, OwnerEndpoint};

    fn facts(
        owner: LeaseOwnerState,
        roots: Vec<RootKind>,
        busy: Option<Vec<String>>,
    ) -> LeaseFacts {
        facts_at(owner, "/repos/ace", roots, busy)
    }

    fn facts_at(
        owner: LeaseOwnerState,
        root: &str,
        roots: Vec<RootKind>,
        busy: Option<Vec<String>>,
    ) -> LeaseFacts {
        LeaseFacts {
            record: LeaseRecord {
                version: 1,
                id: "00000000-0000-4000-8000-000000000000".to_owned(),
                root: root.to_owned(),
                owner: Some(OwnerEndpoint {
                    port: 1,
                    token: "00000000-0000-4000-8000-000000000001".to_owned(),
                }),
                roots: vec![root.to_owned()],
            },
            owner,
            roots,
            busy,
        }
    }

    #[test]
    fn our_own_running_lease_never_fences_its_own_root() {
        let running = facts(
            LeaseOwnerState::Running,
            vec![RootKind::Other],
            Some(Vec::new()),
        );
        assert!(!fences(&running, "/repos/ace"));
        assert_eq!(lease_state(&[running], "/repos/ace").status, "available");
    }

    #[test]
    fn a_healthy_foreign_owner_fences_only_its_own_checkout() {
        let active = facts_at(
            LeaseOwnerState::Active,
            "/repos/ace/.claude/worktrees/x",
            vec![RootKind::Linked],
            None,
        );
        assert!(fences(&active, "/repos/ace/.claude/worktrees/x/src"));
        assert!(!fences(&active, "/repos/ace"));
    }

    #[test]
    fn an_uncertain_repository_wide_lease_fences_every_checkout() {
        let unknown = facts(LeaseOwnerState::Unknown, vec![RootKind::Other], None);
        assert!(fences(&unknown, "/repos/ace"));
        assert_eq!(lease_state(&[unknown], "/repos/ace").status, "quarantined");
    }

    #[test]
    fn a_gone_owner_with_settled_roots_or_no_live_processes_retires_itself() {
        let settled = facts(LeaseOwnerState::Gone, vec![RootKind::Gone], None);
        assert!(retires_automatically(&settled));
        let live = facts(
            LeaseOwnerState::Gone,
            vec![RootKind::Other],
            Some(vec!["a running Git process (pid 1)".to_owned()]),
        );
        assert!(!retires_automatically(&live));
        assert!(clears_on_its_own(&live));
        let proven_gone = facts(
            LeaseOwnerState::Gone,
            vec![RootKind::Other],
            Some(Vec::new()),
        );
        assert!(retires_automatically(&proven_gone));
        assert!(retires_on_confirmation(&proven_gone));
    }

    #[test]
    fn a_quarantined_lease_of_ours_retires_once_its_processes_are_gone() {
        let held = facts(
            LeaseOwnerState::Held,
            vec![RootKind::Other],
            Some(Vec::new()),
        );
        assert!(retires_automatically(&held));
        assert!(!retires_on_confirmation(&held));
    }

    #[test]
    fn the_quarantine_message_names_the_repository_checkout_and_cause() {
        let active = facts(LeaseOwnerState::Active, vec![RootKind::Other], None);
        let message = quarantine_message(&active, "/repos/ace", None);
        assert_eq!(
            message,
            "Another ace daemon is running a Git operation in /repos/ace. Git changes in /repos/ace are blocked until it finishes."
        );
        let started = quarantine_message(&active, "/repos/ace", Some(1_763_726_400_000));
        assert!(
            started.contains("(started 2025-11-21 12:00 UTC)"),
            "{started}"
        );
    }
}
