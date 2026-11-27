// SPDX-License-Identifier: Apache-2.0
//! Issue mutation planning and post-write recovery (`issue-write-plan.ts`).

use std::collections::HashSet;

use ace_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssuePermissions {
    pub edit: bool,
    pub close: bool,
    pub reopen: bool,
    pub triage: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueSnapshot {
    pub title: String,
    pub body: String,
    pub state: String,
    pub state_reason: Option<String>,
    pub updated_at: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub milestone_number: Option<u64>,
    pub permissions: IssuePermissions,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditBase {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueChange {
    Edit {
        title: String,
        body: String,
        expected_updated_at: String,
        base: Option<EditBase>,
    },
    State {
        state: String,
        reason: Option<String>,
    },
    Labels {
        add: Vec<String>,
        remove: Vec<String>,
    },
    Assignees {
        add: Vec<String>,
        remove: Vec<String>,
    },
    Milestone {
        milestone: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum IssueWritePlan {
    Done,
    Conflict,
    Forbidden,
    Patch(Map),
    Members {
        field: &'static str,
        add: Vec<String>,
        remove: Vec<String>,
    },
}

fn unique_ci(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .iter()
        .filter(|v| seen.insert(v.to_ascii_lowercase()))
        .cloned()
        .collect()
}

/// Applies case-insensitive additions and removals while preserving order (`applyMembers`).
pub fn apply_members(current: &[String], add: &[String], remove: &[String]) -> Vec<String> {
    let lower_remove: HashSet<String> = remove.iter().map(|v| v.to_ascii_lowercase()).collect();
    let mut combined = Vec::with_capacity(current.len() + add.len());
    combined.extend_from_slice(current);
    combined.extend_from_slice(add);
    unique_ci(&combined)
        .into_iter()
        .filter(|v| !lower_remove.contains(&v.to_ascii_lowercase()))
        .collect()
}

fn plan_members(
    field: &'static str,
    current: &[String],
    add: &[String],
    remove: &[String],
    allowed: bool,
) -> IssueWritePlan {
    let next = apply_members(current, add, remove);
    if next.len() == current.len() && next.iter().all(|v| current.contains(v)) {
        return IssueWritePlan::Done;
    }
    if !allowed {
        return IssueWritePlan::Forbidden;
    }
    let kept: HashSet<String> = next.iter().map(|n| n.to_ascii_lowercase()).collect();
    let had: HashSet<String> = current.iter().map(|n| n.to_ascii_lowercase()).collect();
    IssueWritePlan::Members {
        field,
        add: next
            .into_iter()
            .filter(|n| !had.contains(&n.to_ascii_lowercase()))
            .collect(),
        remove: current
            .iter()
            .filter(|n| !kept.contains(&n.to_ascii_lowercase()))
            .cloned()
            .collect(),
    }
}

/// Plans an issue mutation against the live `current` issue (`planIssueWrite`).
pub fn plan_issue_write(current: &IssueSnapshot, change: &IssueChange) -> IssueWritePlan {
    let can = &current.permissions;
    let triage = can.triage.unwrap_or(can.edit);
    match change {
        IssueChange::Edit {
            title,
            body,
            expected_updated_at,
            base,
        } => {
            if current.title == *title && current.body == *body {
                return IssueWritePlan::Done;
            }
            let patch = if let Some(base) = base {
                let mut map = Map::new();
                if *title != base.title && *title != current.title {
                    if current.title != base.title {
                        return IssueWritePlan::Conflict;
                    }
                    map.insert(String::from("title"), Value::from(title.clone()));
                }
                if *body != base.body && *body != current.body {
                    if current.body != base.body {
                        return IssueWritePlan::Conflict;
                    }
                    map.insert(String::from("body"), Value::from(body.clone()));
                }
                if map.is_empty() {
                    return IssueWritePlan::Done;
                }
                map
            } else if current.updated_at == *expected_updated_at {
                let mut map = Map::new();
                map.insert(String::from("title"), Value::from(title.clone()));
                map.insert(String::from("body"), Value::from(body.clone()));
                map
            } else {
                return IssueWritePlan::Conflict;
            };
            if !can.edit {
                IssueWritePlan::Forbidden
            } else {
                IssueWritePlan::Patch(patch)
            }
        }
        IssueChange::State { state, reason } => {
            let resolved_reason = if state == "closed" {
                reason.as_deref().unwrap_or("completed")
            } else {
                "reopened"
            };
            if current.state == *state && (state == "open" || reason.is_none()) {
                return IssueWritePlan::Done;
            }
            if current.state == *state && current.state_reason.as_deref() == Some(resolved_reason) {
                return IssueWritePlan::Done;
            }
            let allowed = if state == "open" {
                can.reopen
            } else if current.state == "open" {
                can.close
            } else {
                can.edit
            };
            if !allowed {
                return IssueWritePlan::Forbidden;
            }
            let mut map = Map::new();
            map.insert(String::from("state"), Value::from(state.clone()));
            map.insert(
                String::from("state_reason"),
                Value::from(resolved_reason.to_owned()),
            );
            IssueWritePlan::Patch(map)
        }
        IssueChange::Labels { add, remove } => {
            plan_members("labels", &current.labels, add, remove, triage)
        }
        IssueChange::Assignees { add, remove } => {
            plan_members("assignees", &current.assignees, add, remove, triage)
        }
        IssueChange::Milestone { milestone } => {
            if current.milestone_number == *milestone {
                return IssueWritePlan::Done;
            }
            if !triage {
                return IssueWritePlan::Forbidden;
            }
            let mut map = Map::new();
            map.insert(
                String::from("milestone"),
                match milestone {
                    Some(n) => Value::from(*n),
                    None => Value::Null,
                },
            );
            IssueWritePlan::Patch(map)
        }
    }
}

/// Checks whether a write already landed on `current` (`issueWriteLanded`).
pub fn issue_write_landed(current: &IssueSnapshot, change: &IssueChange) -> bool {
    match change {
        IssueChange::Edit {
            title, body, base, ..
        } => {
            let title_ok =
                base.as_ref().is_some_and(|b| b.title == *title) || current.title == *title;
            let body_ok = base.as_ref().is_some_and(|b| b.body == *body) || current.body == *body;
            title_ok && body_ok
        }
        IssueChange::State { state, reason } => {
            current.state == *state
                && (state == "open"
                    || reason.is_none()
                    || current.state_reason.as_deref() == reason.as_deref())
        }
        IssueChange::Labels { add, remove } | IssueChange::Assignees { add, remove } => {
            let existing = if matches!(change, IssueChange::Labels { .. }) {
                &current.labels
            } else {
                &current.assignees
            };
            let have: HashSet<String> = existing.iter().map(|n| n.to_ascii_lowercase()).collect();
            add.iter().all(|n| have.contains(&n.to_ascii_lowercase()))
                && remove
                    .iter()
                    .all(|n| !have.contains(&n.to_ascii_lowercase()))
        }
        IssueChange::Milestone { milestone } => current.milestone_number == *milestone,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        EditBase, IssueChange, IssuePermissions, IssueSnapshot, IssueWritePlan, issue_write_landed,
        plan_issue_write,
    };

    fn sample_issue() -> IssueSnapshot {
        IssueSnapshot {
            title: String::from("Original"),
            body: String::from("Body"),
            state: String::from("open"),
            state_reason: None,
            updated_at: String::from("2026-10-01T00:00:00Z"),
            labels: vec![String::from("Bug")],
            assignees: vec![String::from("Octo")],
            milestone_number: Some(3),
            permissions: IssuePermissions {
                edit: true,
                close: true,
                reopen: true,
                triage: Some(true),
            },
        }
    }

    #[test]
    fn base_edit_merges_non_conflicting_field_and_conflicts_on_same_field() {
        let mut live = sample_issue();
        live.title = String::from("Edited by collaborator");
        let body_only = IssueChange::Edit {
            title: String::from("Original"),
            body: String::from("New body"),
            expected_updated_at: String::from("stale"),
            base: Some(EditBase {
                title: String::from("Original"),
                body: String::from("Body"),
            }),
        };
        let IssueWritePlan::Patch(map) = plan_issue_write(&live, &body_only) else {
            panic!("expected patch");
        };
        assert!(map.get("title").is_none());
        assert_eq!(map.get("body").and_then(|v| v.as_str()), Some("New body"));

        let conflicting = IssueChange::Edit {
            title: String::from("My title"),
            body: String::from("Body"),
            expected_updated_at: String::from("stale"),
            base: Some(EditBase {
                title: String::from("Original"),
                body: String::from("Body"),
            }),
        };
        assert_eq!(
            plan_issue_write(&live, &conflicting),
            IssueWritePlan::Conflict
        );

        live.body = String::from("New body");
        assert!(issue_write_landed(&live, &body_only));
    }

    #[test]
    fn label_deltas_are_case_insensitive_and_preserve_host_spelling_on_removal() {
        let live = sample_issue();
        let change = IssueChange::Labels {
            add: vec![String::from("bug"), String::from("urgent")],
            remove: vec![String::from("BUG")],
        };
        assert_eq!(
            plan_issue_write(&live, &change),
            IssueWritePlan::Members {
                field: "labels",
                add: vec![String::from("urgent")],
                remove: vec![String::from("Bug")],
            }
        );
    }
}
