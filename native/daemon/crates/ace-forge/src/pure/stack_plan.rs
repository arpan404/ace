// SPDX-License-Identifier: Apache-2.0
//! Stack matching, publication planning, leased-push reconciliation and collaborator sync
//! (`stack-plan.ts`, `stack-publish.ts`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const STACK_REBASED_LOCALLY: &str = "Local branches are rebased and not yet pushed. Publish the stack to update GitHub; each layer moves only if GitHub still has the revision reviewed before the rebase.";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalBranchPr {
    pub number: u64,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLocalBranch {
    pub name: String,
    pub head: String,
    pub base: String,
    pub pr: Option<LocalBranchPr>,
    pub is_current: bool,
    pub is_merged: bool,
    pub is_queued: bool,
    pub needs_rebase: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLocalStack {
    pub trunk: String,
    pub current_branch: String,
    pub branches: Vec<ForgeLocalBranch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStackLayer {
    pub number: u64,
    pub branch: String,
    pub url: String,
    pub state: String,
    pub head_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStack {
    pub id: String,
    pub trunk: String,
    pub layers: Vec<ForgeStackLayer>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedLayer {
    pub number: u64,
    pub head_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeStackExpected {
    pub id: String,
    pub trunk: String,
    pub layers: Vec<ExpectedLayer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local: Option<ForgeLocalStack>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackPublishUpdate {
    pub number: u64,
    pub branch: String,
    pub lease: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StackLayerMove {
    pub number: u64,
    pub branch: String,
    pub reviewed: String,
    pub current: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StackPublishRefusal {
    Membership,
    Moved,
    Unrestacked,
    Unchanged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StackSyncRefusal {
    Membership,
    Changed,
    Unrestacked,
    Unmoved,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefPushStatus {
    Updated,
    UpToDate,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefPushEntry {
    pub git_ref: String,
    pub status: RefPushStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StackPublishReport {
    pub exit_code: i32,
    pub refs: Vec<RefPushEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    Published,
    Refused,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReconcileOutcome {
    Published,
    Unpublished,
    Unknown,
}

pub fn can_publish_stack(stack: &ForgeStack) -> bool {
    stack
        .layers
        .iter()
        .all(|layer| matches!(layer.state.as_str(), "OPEN" | "DRAFT" | "MERGED"))
}

pub fn matches_stack_branches(local: &ForgeLocalStack, stack: &ForgeStack) -> bool {
    let branches: Vec<&ForgeLocalBranch> = local.branches.iter().filter(|b| !b.is_merged).collect();
    let layers: Vec<&ForgeStackLayer> = stack
        .layers
        .iter()
        .filter(|l| l.state != "MERGED")
        .collect();
    local.trunk == stack.trunk
        && !branches.is_empty()
        && branches.len() == layers.len()
        && branches.iter().zip(layers.iter()).all(|(branch, layer)| {
            branch.pr.as_ref().is_some_and(|pr| {
                branch.name == layer.branch
                    && pr.number == layer.number
                    && pr.url.eq_ignore_ascii_case(&layer.url)
            })
        })
}

pub fn same_local_stack(a: &ForgeLocalStack, b: &ForgeLocalStack) -> bool {
    a.trunk == b.trunk
        && a.current_branch == b.current_branch
        && a.branches.len() == b.branches.len()
        && a.branches
            .iter()
            .zip(b.branches.iter())
            .all(|(branch, other)| {
                branch.name == other.name
                    && branch.head == other.head
                    && branch.base == other.base
                    && branch.pr.as_ref().map(|p| p.number) == other.pr.as_ref().map(|p| p.number)
                    && branch.is_merged == other.is_merged
                    && branch.is_queued == other.is_queued
            })
}

pub fn same_stack(expected: &ForgeStackExpected, current: &ForgeStack) -> bool {
    expected.id == current.id
        && expected.trunk == current.trunk
        && expected.layers.len() == current.layers.len()
        && expected
            .layers
            .iter()
            .zip(current.layers.iter())
            .all(|(entry, layer)| entry.number == layer.number && entry.head_sha == layer.head_sha)
}

pub fn matches_local_stack(local: &ForgeLocalStack, stack: &ForgeStack) -> bool {
    let active: Vec<&ForgeLocalBranch> = local.branches.iter().filter(|b| !b.is_merged).collect();
    matches_stack_branches(local, stack)
        && active.iter().filter(|b| b.is_current).count() == 1
        && active
            .iter()
            .any(|b| b.is_current && b.name == local.current_branch)
}

pub fn stack_pr_state(state: &str, is_draft: bool) -> String {
    if state == "OPEN" && is_draft {
        String::from("DRAFT")
    } else {
        state.to_owned()
    }
}

pub fn can_publish_after(action: &str, state: &str) -> bool {
    state == "push_partial" || (action == "push" && state == "uncertain")
}

pub fn stack_publish_updates(reviewed: &ForgeStackExpected) -> Vec<StackPublishUpdate> {
    let leases: HashMap<u64, &str> = reviewed
        .layers
        .iter()
        .map(|l| (l.number, l.head_sha.as_str()))
        .collect();
    let mut updates = Vec::new();
    if let Some(local) = &reviewed.local {
        for branch in &local.branches {
            if branch.is_merged {
                continue;
            }
            let Some(pr) = &branch.pr else {
                continue;
            };
            let Some(&lease) = leases.get(&pr.number) else {
                continue;
            };
            if lease == branch.head {
                continue;
            }
            updates.push(StackPublishUpdate {
                number: pr.number,
                branch: branch.name.clone(),
                lease: lease.to_owned(),
                target: branch.head.clone(),
            });
        }
    }
    updates
}

pub fn is_restacked(local: &ForgeLocalStack) -> bool {
    let active: Vec<&ForgeLocalBranch> = local.branches.iter().filter(|b| !b.is_merged).collect();
    active.iter().enumerate().all(|(idx, branch)| {
        !branch.needs_rebase && (idx == 0 || branch.base == active[idx - 1].head)
    })
}

pub fn plan_stack_publication(
    reviewed: &ForgeStackExpected,
    local: &ForgeLocalStack,
    stack: &ForgeStack,
) -> Result<Vec<StackPublishUpdate>, StackPublishRefusal> {
    if !matches_stack_branches(local, stack) {
        return Err(StackPublishRefusal::Membership);
    }
    if !same_stack(reviewed, stack) {
        return Err(StackPublishRefusal::Moved);
    }
    if !is_restacked(local) {
        return Err(StackPublishRefusal::Unrestacked);
    }
    let with_local = ForgeStackExpected {
        local: Some(local.clone()),
        ..reviewed.clone()
    };
    let updates = stack_publish_updates(&with_local);
    if updates.is_empty() {
        Err(StackPublishRefusal::Unchanged)
    } else {
        Ok(updates)
    }
}

pub fn stack_publish_result(
    updates: &[StackPublishUpdate],
    report: &StackPublishReport,
) -> PublishOutcome {
    let refs: HashMap<&str, &RefPushEntry> = report
        .refs
        .iter()
        .map(|r| (r.git_ref.as_str(), r))
        .collect();
    let planned: Vec<Option<&RefPushEntry>> = updates
        .iter()
        .map(|u| {
            refs.get(format!("refs/heads/{}", u.branch).as_str())
                .copied()
        })
        .collect();
    if report.exit_code == 0
        && planned
            .iter()
            .all(|entry| entry.is_some_and(|e| e.status != RefPushStatus::Rejected))
    {
        return PublishOutcome::Published;
    }
    if report.exit_code != 0
        && planned
            .iter()
            .any(|entry| entry.is_some_and(|e| e.status == RefPushStatus::Rejected))
    {
        return PublishOutcome::Refused;
    }
    PublishOutcome::Unknown
}

pub fn reconcile_stack_publication(
    updates: &[StackPublishUpdate],
    stack: &ForgeStack,
) -> ReconcileOutcome {
    if updates.is_empty() {
        return ReconcileOutcome::Unknown;
    }
    let heads: Vec<Option<&str>> = updates
        .iter()
        .map(|u| {
            stack
                .layers
                .iter()
                .find(|l| l.number == u.number)
                .map(|l| l.head_sha.as_str())
        })
        .collect();
    if updates
        .iter()
        .zip(heads.iter())
        .all(|(u, h)| *h == Some(u.target.as_str()))
    {
        return ReconcileOutcome::Published;
    }
    if updates
        .iter()
        .zip(heads.iter())
        .all(|(u, h)| *h == Some(u.lease.as_str()))
    {
        return ReconcileOutcome::Unpublished;
    }
    ReconcileOutcome::Unknown
}

pub fn stack_layers_moved_since_review(
    reviewed: &ForgeStackExpected,
    stack: &ForgeStack,
) -> Vec<StackLayerMove> {
    if reviewed.id != stack.id {
        return Vec::new();
    }
    let targets: HashMap<u64, &str> = reviewed
        .local
        .as_ref()
        .map(|local| {
            local
                .branches
                .iter()
                .filter_map(|b| b.pr.as_ref().map(|pr| (pr.number, b.head.as_str())))
                .collect()
        })
        .unwrap_or_default();
    let mut moves = Vec::new();
    for layer in &reviewed.layers {
        let Some(current) = stack.layers.iter().find(|e| e.number == layer.number) else {
            continue;
        };
        if current.state == "MERGED"
            || current.head_sha == layer.head_sha
            || targets.get(&layer.number).copied() == Some(current.head_sha.as_str())
        {
            continue;
        }
        moves.push(StackLayerMove {
            number: layer.number,
            branch: current.branch.clone(),
            reviewed: layer.head_sha.clone(),
            current: current.head_sha.clone(),
        });
    }
    moves
}

pub fn plan_stack_sync(
    reviewed: &ForgeStackExpected,
    requested: &ForgeStackExpected,
    local: &ForgeLocalStack,
    stack: &ForgeStack,
) -> Result<Vec<StackLayerMove>, StackSyncRefusal> {
    if !matches_stack_branches(local, stack) {
        return Err(StackSyncRefusal::Membership);
    }
    if reviewed.id != stack.id
        || !same_stack(requested, stack)
        || !requested
            .local
            .as_ref()
            .is_some_and(|req| same_local_stack(req, local))
    {
        return Err(StackSyncRefusal::Changed);
    }
    if !is_restacked(local) {
        return Err(StackSyncRefusal::Unrestacked);
    }
    let moves = stack_layers_moved_since_review(reviewed, stack);
    if moves.is_empty() {
        Err(StackSyncRefusal::Unmoved)
    } else {
        Ok(moves)
    }
}

pub fn review_after_sync(
    requested: &ForgeStackExpected,
    local: &ForgeLocalStack,
) -> ForgeStackExpected {
    ForgeStackExpected {
        id: requested.id.clone(),
        trunk: requested.trunk.clone(),
        layers: requested.layers.clone(),
        local: Some(local.clone()),
    }
}

pub fn same_reviewed_revisions(a: &ForgeStackExpected, b: &ForgeStackExpected) -> bool {
    a.id == b.id
        && a.trunk == b.trunk
        && a.layers.len() == b.layers.len()
        && a.layers
            .iter()
            .zip(b.layers.iter())
            .all(|(l, r)| l.number == r.number && l.head_sha == r.head_sha)
}

#[cfg(test)]
mod tests {
    use super::{
        ExpectedLayer, ForgeLocalBranch, ForgeLocalStack, ForgeStack, ForgeStackExpected,
        ForgeStackLayer, LocalBranchPr, PublishOutcome, ReconcileOutcome, RefPushEntry,
        RefPushStatus, StackPublishRefusal, StackPublishReport, plan_stack_publication,
        reconcile_stack_publication, stack_layers_moved_since_review, stack_publish_result,
    };

    fn fixture() -> (ForgeStackExpected, ForgeLocalStack, ForgeStack) {
        let reviewed = ForgeStackExpected {
            id: String::from("s1"),
            trunk: String::from("main"),
            layers: vec![
                ExpectedLayer {
                    number: 1,
                    head_sha: String::from("old1"),
                },
                ExpectedLayer {
                    number: 2,
                    head_sha: String::from("old2"),
                },
            ],
            local: None,
        };
        let local = ForgeLocalStack {
            trunk: String::from("main"),
            current_branch: String::from("feat-2"),
            branches: vec![
                ForgeLocalBranch {
                    name: String::from("feat-1"),
                    head: String::from("new1"),
                    base: String::from("main-sha"),
                    pr: Some(LocalBranchPr {
                        number: 1,
                        url: String::from("https://github.com/o/r/pull/1"),
                    }),
                    is_current: false,
                    is_merged: false,
                    is_queued: false,
                    needs_rebase: false,
                },
                ForgeLocalBranch {
                    name: String::from("feat-2"),
                    head: String::from("new2"),
                    base: String::from("new1"),
                    pr: Some(LocalBranchPr {
                        number: 2,
                        url: String::from("https://github.com/o/r/pull/2"),
                    }),
                    is_current: true,
                    is_merged: false,
                    is_queued: false,
                    needs_rebase: false,
                },
            ],
        };
        let stack = ForgeStack {
            id: String::from("s1"),
            trunk: String::from("main"),
            layers: vec![
                ForgeStackLayer {
                    number: 1,
                    branch: String::from("feat-1"),
                    url: String::from("https://github.com/o/r/pull/1"),
                    state: String::from("OPEN"),
                    head_sha: String::from("old1"),
                },
                ForgeStackLayer {
                    number: 2,
                    branch: String::from("feat-2"),
                    url: String::from("https://github.com/o/r/pull/2"),
                    state: String::from("OPEN"),
                    head_sha: String::from("old2"),
                },
            ],
        };
        (reviewed, local, stack)
    }

    #[test]
    fn stack_publication_plans_leases_and_refuses_moved_head() {
        let (reviewed, local, mut stack) = fixture();
        let updates = plan_stack_publication(&reviewed, &local, &stack).expect("plan");
        assert_eq!(updates.len(), 2);
        assert_eq!(updates[0].lease, "old1");
        assert_eq!(updates[0].target, "new1");

        let ok_report = StackPublishReport {
            exit_code: 0,
            refs: vec![
                RefPushEntry {
                    git_ref: String::from("refs/heads/feat-1"),
                    status: RefPushStatus::Updated,
                    reason: None,
                },
                RefPushEntry {
                    git_ref: String::from("refs/heads/feat-2"),
                    status: RefPushStatus::Updated,
                    reason: None,
                },
            ],
        };
        assert_eq!(
            stack_publish_result(&updates, &ok_report),
            PublishOutcome::Published
        );
        assert_eq!(
            reconcile_stack_publication(&updates, &stack),
            ReconcileOutcome::Unpublished
        );

        // Collaborator pushed to layer 2 -> publication refuses and move is detected.
        stack.layers[1].head_sha = String::from("collab2");
        assert_eq!(
            plan_stack_publication(&reviewed, &local, &stack),
            Err(StackPublishRefusal::Moved)
        );
        let moves = stack_layers_moved_since_review(&reviewed, &stack);
        assert_eq!(moves.len(), 1);
        assert_eq!(moves[0].current, "collab2");
    }
}
