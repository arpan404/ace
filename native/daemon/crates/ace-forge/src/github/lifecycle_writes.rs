// SPDX-License-Identifier: Apache-2.0
//! Lifecycle planning, extra-facts mapping and non-`updatePullRequest` writes
//! (`lifecycle-plan.ts`, `github-lifecycle-extras.ts`, `github-lifecycle-writes.ts`).

use std::collections::HashSet;
use std::sync::Arc;

use ace_json::{Map, Value};
use serde::Serialize;

use crate::github::merge_state::is_sha;
use crate::pure::{ForgePrRef, ForgeRepository};
use crate::transport::command::Cancellation;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::mutation::MutationDispatch;

/// Repository roles that may triage: label, set milestones, lock conversations.
pub const TRIAGE_ROLES: [&str; 4] = ["TRIAGE", "WRITE", "MAINTAIN", "ADMIN"];
/// Repository roles that may push and comment on locked conversations.
pub const WRITE_ROLES: [&str; 3] = ["WRITE", "MAINTAIN", "ADMIN"];

/// GraphQL mutation name for each lifecycle action.
pub const LIFECYCLE_MUTATIONS: [(&str, &str); 9] = [
    ("ready", "markPullRequestReadyForReview"),
    ("draft", "convertPullRequestToDraft"),
    ("close", "closePullRequest"),
    ("reopen", "reopenPullRequest"),
    ("update.merge", "updatePullRequestBranch"),
    ("update.rebase", "updatePullRequestBranch"),
    ("revert", "revertPullRequest"),
    ("issue.link", "addCloseIssueReferences"),
    ("issue.unlink", "removeCloseIssueReferences"),
];

pub fn lifecycle_mutation_name(kind: &str) -> Option<&'static str> {
    LIFECYCLE_MUTATIONS
        .iter()
        .find_map(|(k, v)| (*k == kind).then_some(*v))
}

/// Lock reason (`ForgeLockReason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LockReason {
    OffTopic,
    TooHeated,
    Resolved,
    Spam,
}

impl LockReason {
    pub fn from_graphql(value: &str) -> Option<Self> {
        match value {
            "OFF_TOPIC" => Some(Self::OffTopic),
            "TOO_HEATED" => Some(Self::TooHeated),
            "RESOLVED" => Some(Self::Resolved),
            "SPAM" => Some(Self::Spam),
            _ => None,
        }
    }

    pub fn rest_name(self) -> &'static str {
        match self {
            Self::OffTopic => "off-topic",
            Self::TooHeated => "too heated",
            Self::Resolved => "resolved",
            Self::Spam => "spam",
        }
    }
}

/// PR lifecycle state (`ForgeLifecycleSnapshot.state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleState {
    Open,
    Draft,
    Closed,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleMilestone {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub due_on: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleConversation {
    pub locked: bool,
    pub reason: Option<LockReason>,
    pub viewer_can_comment: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleHeadBranch {
    pub name: String,
    pub exists: bool,
    pub same_repository: bool,
    pub is_default: bool,
    pub delete_on_merge: bool,
    pub used_by: Vec<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleClosingIssue {
    pub r#ref: ForgePrRef,
    pub title: String,
    pub state: String,
    pub url: String,
    pub manual: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleMetadata {
    pub title: String,
    pub body: String,
    pub base_branch: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<Option<u64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLifecycleSnapshot {
    pub pr: ForgePrRef,
    pub id: String,
    pub version: String,
    pub head_sha: String,
    pub base_sha: String,
    pub state: LifecycleState,
    pub metadata: LifecycleMetadata,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<Option<LifecycleMilestone>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation: Option<LifecycleConversation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_branch: Option<LifecycleHeadBranch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closing_issues: Option<Vec<LifecycleClosingIssue>>,
    pub actions: Vec<String>,
    pub editable_fields: Vec<String>,
    pub unsupported: Vec<String>,
}

/// Requested metadata edits (`ForgeLifecycleAction { kind: "edit" }`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LifecycleEditChanges {
    pub title: Option<String>,
    pub body: Option<String>,
    pub base_branch: Option<String>,
    pub labels: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
    /// `Some(Some(n))` sets milestone `n`; `Some(None)` clears it; `None` leaves unchanged.
    pub milestone: Option<Option<u64>>,
}

impl LifecycleEditChanges {
    pub fn field_names(&self) -> Vec<&'static str> {
        let mut names = Vec::new();
        if self.title.is_some() {
            names.push("title");
        }
        if self.body.is_some() {
            names.push("body");
        }
        if self.base_branch.is_some() {
            names.push("baseBranch");
        }
        if self.labels.is_some() {
            names.push("labels");
        }
        if self.assignees.is_some() {
            names.push("assignees");
        }
        if self.milestone.is_some() {
            names.push("milestone");
        }
        names
    }
}

/// Lifecycle action (`ForgeLifecycleAction`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ForgeLifecycleAction {
    Edit(LifecycleEditChanges),
    Ready,
    Draft,
    Close,
    Reopen,
    UpdateMerge,
    UpdateRebase,
    Revert { title: String, body: String },
    Lock { reason: Option<LockReason> },
    Unlock,
    BranchDelete,
    BranchRestore,
    IssueLink { issue: u64 },
    IssueUnlink { issue: ForgePrRef },
}

impl ForgeLifecycleAction {
    pub fn kind_name(&self) -> &'static str {
        match self {
            Self::Edit(_) => "edit",
            Self::Ready => "ready",
            Self::Draft => "draft",
            Self::Close => "close",
            Self::Reopen => "reopen",
            Self::UpdateMerge => "update.merge",
            Self::UpdateRebase => "update.rebase",
            Self::Revert { .. } => "revert",
            Self::Lock { .. } => "lock",
            Self::Unlock => "unlock",
            Self::BranchDelete => "branch.delete",
            Self::BranchRestore => "branch.restore",
            Self::IssueLink { .. } => "issue.link",
            Self::IssueUnlink { .. } => "issue.unlink",
        }
    }

    pub fn is_extra(&self) -> bool {
        matches!(
            self,
            Self::Lock { .. }
                | Self::Unlock
                | Self::BranchDelete
                | Self::BranchRestore
                | Self::IssueLink { .. }
                | Self::IssueUnlink { .. }
        )
    }
}

/// Result of applying or observing a lifecycle action (`ForgeLifecycleReceipt`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLifecycleReceipt {
    pub outcome: String,
    pub head_sha: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revert_pr: Option<ForgePrRef>,
}

/// Facts about the head branch and lock that only newer hosts report (`LifecycleExtraFacts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleExtraFacts {
    pub locked: bool,
    pub head_exists: bool,
    pub same_repository: bool,
    pub is_default: bool,
    pub delete_on_merge: bool,
    pub can_restore_head: bool,
    pub open_prs_using_branch: Vec<u64>,
}

/// Inputs to [`lifecycle_capabilities`].
pub struct LifecycleCapabilityFacts<'a> {
    pub state: LifecycleState,
    pub archived: bool,
    pub can_update: bool,
    pub can_label: bool,
    pub can_assign: bool,
    pub can_close: bool,
    pub can_reopen: bool,
    pub can_update_branch: bool,
    pub rebaseable: bool,
    pub can_revert: bool,
    pub supported: &'a HashSet<String>,
    pub permission: Option<&'a str>,
    pub extras: Option<&'a LifecycleExtraFacts>,
}

/// Computes allowed actions, editable fields and unsupported actions (`lifecycleCapabilities`).
pub fn lifecycle_capabilities(
    facts: &LifecycleCapabilityFacts<'_>,
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let unsupported: Vec<String> = LIFECYCLE_MUTATIONS
        .iter()
        .filter(|(_, mutation)| !facts.supported.contains(*mutation))
        .map(|(kind, _)| (*kind).to_owned())
        .collect();
    if facts.archived {
        return (Vec::new(), Vec::new(), unsupported);
    }
    let mut actions: Vec<&'static str> = Vec::new();
    let mut editable_fields: Vec<String> = Vec::new();
    let active = matches!(facts.state, LifecycleState::Open | LifecycleState::Draft);

    if facts.supported.contains("updatePullRequest") {
        if facts.can_update {
            editable_fields.push(String::from("title"));
            editable_fields.push(String::from("body"));
            if active {
                editable_fields.push(String::from("baseBranch"));
            }
        }
        if facts.can_label {
            editable_fields.push(String::from("labels"));
        }
        if facts.can_assign {
            editable_fields.push(String::from("assignees"));
        }
    }
    let triage = facts.permission.is_some_and(|p| TRIAGE_ROLES.contains(&p));
    if facts.extras.is_some() && triage {
        editable_fields.push(String::from("milestone"));
    }
    if facts.state == LifecycleState::Draft && facts.can_update {
        actions.push("ready");
    }
    if facts.state == LifecycleState::Open && facts.can_update {
        actions.push("draft");
    }
    if active && facts.can_close {
        actions.push("close");
    }
    if facts.state == LifecycleState::Closed && facts.can_reopen {
        actions.push("reopen");
    }
    if active && facts.can_update_branch {
        actions.push("update.merge");
        if facts.rebaseable {
            actions.push("update.rebase");
        }
    }
    if facts.state == LifecycleState::Merged && facts.can_revert {
        actions.push("revert");
    }
    if let Some(extras) = facts.extras {
        if triage {
            actions.push(if extras.locked { "unlock" } else { "lock" });
        }
        if !active && extras.same_repository && extras.can_restore_head {
            let github_deletes = facts.state == LifecycleState::Merged && extras.delete_on_merge;
            let shared = !extras.open_prs_using_branch.is_empty();
            if extras.head_exists && !extras.is_default && !github_deletes && !shared {
                actions.push("branch.delete");
            }
            if !extras.head_exists {
                actions.push("branch.restore");
            }
        }
        if active && facts.can_update {
            actions.push("issue.link");
            actions.push("issue.unlink");
        }
    }
    let actions = actions
        .into_iter()
        .filter(|kind| !unsupported.iter().any(|u| u == kind))
        .map(str::to_owned)
        .collect();
    (actions, editable_fields, unsupported)
}

/// Validates version CAS and capability gate before sending a write (`assertLifecycleAction`).
pub fn assert_lifecycle_action(
    snapshot: &ForgeLifecycleSnapshot,
    expected_version: &str,
    action: &ForgeLifecycleAction,
) -> Result<(), ForgeError> {
    if snapshot.version != expected_version {
        return Err(ForgeError::not_dispatched(Kind::Conflict));
    }
    if let ForgeLifecycleAction::Edit(changes) = action {
        let fields = changes.field_names();
        if fields.is_empty() {
            return Err(ForgeError::not_dispatched(Kind::InvalidData));
        }
        if fields
            .iter()
            .any(|f| !snapshot.editable_fields.iter().any(|e| e == f))
        {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
    } else {
        let kind = action.kind_name();
        if snapshot.unsupported.iter().any(|u| u == kind) {
            return Err(ForgeError::not_dispatched(Kind::Unsupported));
        }
        if !snapshot.actions.iter().any(|a| a == kind) {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
    }
    Ok(())
}

/// Checks whether a refreshed snapshot observes the requested metadata edits (`metadataMatches`).
pub fn metadata_matches(snapshot: &ForgeLifecycleSnapshot, changes: &LifecycleEditChanges) -> bool {
    if let Some(ref title) = changes.title
        && &snapshot.metadata.title != title
    {
        return false;
    }
    if let Some(ref body) = changes.body
        && &snapshot.metadata.body != body
    {
        return false;
    }
    if let Some(ref base) = changes.base_branch
        && &snapshot.metadata.base_branch != base
    {
        return false;
    }
    if let Some(ref labels) = changes.labels {
        let mut expected = labels.clone();
        expected.sort();
        let mut actual = snapshot.metadata.labels.clone();
        actual.sort();
        if expected != actual {
            return false;
        }
    }
    if let Some(ref assignees) = changes.assignees {
        let expected: HashSet<String> = assignees.iter().map(|s| s.to_lowercase()).collect();
        let actual: HashSet<String> = snapshot
            .metadata
            .assignees
            .iter()
            .map(|s| s.to_lowercase())
            .collect();
        if expected != actual {
            return false;
        }
    }
    if let Some(milestone) = changes.milestone
        && snapshot.metadata.milestone != Some(milestone)
    {
        return false;
    }
    true
}

/// Percent-encodes each path segment of a branch name while preserving `/` (`branchPath`).
pub fn branch_path(name: &str) -> String {
    name.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        let unreserved = byte.is_ascii_alphanumeric()
            || matches!(
                byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if unreserved {
            out.push(byte as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(&mut out, "%{byte:02X}");
        }
    }
    out
}

/// Prepared non-`updatePullRequest` lifecycle write ready to execute after the final recheck.
pub enum PreparedExtraWrite {
    Rest {
        path: String,
        method: &'static str,
        body: Option<Value>,
    },
    ClosingIssue {
        mutation: &'static str,
        issue_id: String,
        pull_request_id: String,
        operation_id: String,
    },
}

/// Extra lifecycle writes (`GitHubLifecycleWrites`): lock/unlock, head branch delete/restore,
/// and manual closing-issue link/unlink.
pub struct GitHubLifecycleWrites<'a> {
    api: &'a GhApi<'a>,
    repository: ForgeRepository,
    root: String,
}

impl<'a> GitHubLifecycleWrites<'a> {
    pub fn new(api: &'a GhApi<'a>, repository: ForgeRepository) -> Self {
        let root = format!("repos/{}/{}", repository.owner, repository.name);
        Self {
            api,
            repository,
            root,
        }
    }

    async fn issue_id(
        &self,
        owner: &str,
        name: &str,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<String, ForgeError> {
        let mut vars = Map::new();
        vars.insert(String::from("owner"), Value::from(owner));
        vars.insert(String::from("name"), Value::from(name));
        vars.insert(String::from("number"), Value::from(number));
        let mut body = Map::new();
        body.insert(
            String::from("query"),
            Value::from(
                "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id number}}}",
            ),
        );
        body.insert(String::from("variables"), Value::Object(vars));
        let page = self
            .api
            .request(
                "graphql",
                Some(Value::Object(body)),
                Some("POST"),
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let issue = match page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("repository"))
            .and_then(Value::as_object)
            .and_then(|r| r.get("issue"))
        {
            Some(Value::Null) | None => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(i)) => i,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let num = issue.get("number").and_then(Value::as_f64);
        if num != Some(number as f64) {
            return Err(ForgeError::new(Kind::NotFound));
        }
        issue
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| s.chars().count() <= 65_536)
            .map(str::to_owned)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))
    }

    async fn open_prs_onto(
        &self,
        branch: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Vec<u64>, ForgeError> {
        let path = format!(
            "{}/pulls?state=open&base={}&per_page=10",
            self.root,
            encode_uri_component(branch)
        );
        let page = self
            .api
            .request(
                &path,
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        parse_open_pr_numbers(&page.body)
    }

    async fn open_prs_from(
        &self,
        branch: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Vec<u64>, ForgeError> {
        let head = format!("{}:{branch}", self.repository.owner);
        let path = format!(
            "{}/pulls?state=open&head={}&per_page=10",
            self.root,
            encode_uri_component(&head)
        );
        let page = self
            .api
            .request(
                &path,
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        parse_open_pr_numbers(&page.body)
    }

    /// The head branch's commit now, or `None` when deleted (`headCommit`).
    pub async fn head_commit(
        &self,
        branch: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Option<String>, ForgeError> {
        let path = format!("{}/git/ref/heads/{}", self.root, branch_path(branch));
        match self
            .api
            .request(
                &path,
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await
        {
            Ok(page) => {
                let sha = page
                    .body
                    .as_object()
                    .and_then(|o| o.get("object"))
                    .and_then(Value::as_object)
                    .and_then(|o| o.get("sha"))
                    .and_then(Value::as_str)
                    .filter(|s| is_sha(s))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                Ok(Some(sha.to_owned()))
            }
            Err(err) if err.kind == Kind::NotFound => Ok(None),
            Err(err) => Err(err),
        }
    }

    /// Reads preconditions (branch commit, open PRs, issue node ID) before the caller's final recheck.
    pub async fn prepare(
        &self,
        snapshot: &ForgeLifecycleSnapshot,
        action: &ForgeLifecycleAction,
        operation_id: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<PreparedExtraWrite, ForgeError> {
        match action {
            ForgeLifecycleAction::Lock { reason } => {
                let mut body = Map::new();
                if let Some(r) = reason {
                    body.insert(String::from("lock_reason"), Value::from(r.rest_name()));
                }
                Ok(PreparedExtraWrite::Rest {
                    path: format!("{}/issues/{}/lock", self.root, snapshot.pr.number),
                    method: "PUT",
                    body: Some(Value::Object(body)),
                })
            }
            ForgeLifecycleAction::Unlock => Ok(PreparedExtraWrite::Rest {
                path: format!("{}/issues/{}/lock", self.root, snapshot.pr.number),
                method: "DELETE",
                body: None,
            }),
            ForgeLifecycleAction::BranchRestore => {
                let Some(ref head) = snapshot.head_branch else {
                    return Err(ForgeError::not_dispatched(Kind::Unsupported));
                };
                if self.head_commit(&head.name, cancellation).await?.is_some() {
                    return Err(ForgeError::not_dispatched(Kind::Conflict));
                }
                let mut body = Map::new();
                body.insert(
                    String::from("ref"),
                    Value::from(format!("refs/heads/{}", head.name)),
                );
                body.insert(String::from("sha"), Value::from(snapshot.head_sha.as_str()));
                Ok(PreparedExtraWrite::Rest {
                    path: format!("{}/git/refs", self.root),
                    method: "POST",
                    body: Some(Value::Object(body)),
                })
            }
            ForgeLifecycleAction::BranchDelete => {
                let Some(ref head) = snapshot.head_branch else {
                    return Err(ForgeError::not_dispatched(Kind::Unsupported));
                };
                let Some(current) = self.head_commit(&head.name, cancellation.clone()).await?
                else {
                    return Err(ForgeError::not_dispatched(Kind::BranchGone));
                };
                if current.to_lowercase() != snapshot.head_sha.to_lowercase() {
                    return Err(ForgeError::not_dispatched(Kind::HeadMoved));
                }
                if self
                    .open_prs_from(&head.name, cancellation.clone())
                    .await?
                    .into_iter()
                    .any(|n| n != snapshot.pr.number)
                {
                    return Err(ForgeError::not_dispatched(Kind::BranchInUse));
                }
                if snapshot.state == LifecycleState::Closed
                    && !self
                        .open_prs_onto(&head.name, cancellation)
                        .await?
                        .is_empty()
                {
                    return Err(ForgeError::not_dispatched(Kind::BranchInUse));
                }
                Ok(PreparedExtraWrite::Rest {
                    path: format!("{}/git/refs/heads/{}", self.root, branch_path(&head.name)),
                    method: "DELETE",
                    body: None,
                })
            }
            ForgeLifecycleAction::IssueLink { issue } => {
                let issue_id = self
                    .issue_id(
                        &self.repository.owner,
                        &self.repository.name,
                        *issue,
                        cancellation,
                    )
                    .await?;
                Ok(PreparedExtraWrite::ClosingIssue {
                    mutation: "addCloseIssueReferences",
                    issue_id,
                    pull_request_id: snapshot.id.clone(),
                    operation_id: operation_id.to_owned(),
                })
            }
            ForgeLifecycleAction::IssueUnlink { issue: target } => {
                let manual_match = snapshot
                    .closing_issues
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .find(|i| {
                        i.r#ref.number == target.number
                            && i.r#ref.repository.owner.to_lowercase()
                                == target.repository.owner.to_lowercase()
                            && i.r#ref.repository.name.to_lowercase()
                                == target.repository.name.to_lowercase()
                    });
                if !manual_match.is_some_and(|i| i.manual) {
                    return Err(ForgeError::not_dispatched(Kind::Forbidden));
                }
                let issue_id = self
                    .issue_id(
                        &target.repository.owner,
                        &target.repository.name,
                        target.number,
                        cancellation,
                    )
                    .await?;
                Ok(PreparedExtraWrite::ClosingIssue {
                    mutation: "removeCloseIssueReferences",
                    issue_id,
                    pull_request_id: snapshot.id.clone(),
                    operation_id: operation_id.to_owned(),
                })
            }
            _ => Err(ForgeError::not_dispatched(Kind::InvalidData)),
        }
    }

    pub async fn execute(
        &self,
        write: PreparedExtraWrite,
        cancellation: Option<Arc<Cancellation>>,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<(), ForgeError> {
        match write {
            PreparedExtraWrite::Rest { path, method, body } => {
                let page = self
                    .api
                    .request(&path, body, Some(method), cancellation, dispatch)
                    .await?;
                if page.identity_changed {
                    return Err(dispatched_uncertain());
                }
                Ok(())
            }
            PreparedExtraWrite::ClosingIssue {
                mutation,
                issue_id,
                pull_request_id,
                operation_id,
            } => {
                let mut chars = mutation.chars();
                let first = chars.next().map(|c| c.to_ascii_uppercase()).unwrap_or('A');
                let input_type = format!("{first}{}Input", chars.as_str());
                let mut input = Map::new();
                input.insert(String::from("issueId"), Value::from(issue_id.as_str()));
                input.insert(
                    String::from("pullRequestIds"),
                    Value::Array(vec![Value::from(pull_request_id.as_str())].into()),
                );
                input.insert(
                    String::from("clientMutationId"),
                    Value::from(operation_id.as_str()),
                );
                let mut vars = Map::new();
                vars.insert(String::from("input"), Value::Object(input));
                let mut body = Map::new();
                body.insert(
                    String::from("query"),
                    Value::from(format!(
                        "mutation($input:{input_type}!){{{mutation}(input:$input){{clientMutationId issue{{id}}}}}}"
                    )),
                );
                body.insert(String::from("variables"), Value::Object(vars));
                let page = self
                    .api
                    .request(
                        "graphql",
                        Some(Value::Object(body)),
                        Some("POST"),
                        cancellation,
                        dispatch,
                    )
                    .await?;
                if page.identity_changed {
                    return Err(dispatched_uncertain());
                }
                let ack = page
                    .body
                    .as_object()
                    .and_then(|o| o.get("data"))
                    .and_then(Value::as_object)
                    .and_then(|d| d.get(mutation))
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("issue"))
                    .and_then(Value::as_object)
                    .and_then(|i| i.get("id"))
                    .and_then(Value::as_str);
                if ack != Some(issue_id.as_str()) {
                    return Err(dispatched_uncertain());
                }
                Ok(())
            }
        }
    }
}

pub(crate) fn dispatched_uncertain() -> ForgeError {
    let mut receipt = Map::new();
    receipt.insert(String::from("dispatched"), Value::Bool(true));
    let mut err = ForgeError::new(Kind::OutcomeUncertain);
    err.receipt = Some(Value::Object(receipt));
    err
}

fn parse_open_pr_numbers(body: &Value) -> Result<Vec<u64>, ForgeError> {
    let arr = body
        .as_array()
        .filter(|a| a.len() <= 10)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let num = item
            .as_object()
            .and_then(|o| o.get("number"))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 1.0 && n.fract() == 0.0)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        out.push(num as u64);
    }
    Ok(out)
}
