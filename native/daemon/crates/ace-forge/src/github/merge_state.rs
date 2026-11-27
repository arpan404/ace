// SPDX-License-Identifier: Apache-2.0
//! GitHub merge-state read, auto-merge enable/disable and merge-queue dequeue
//! (`merge-state.ts`, `github-merge-state.ts`).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ace_json::{Map, Value};
use serde::Serialize;

use crate::pure::ForgeRepository;
use crate::transport::command::Cancellation;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::mutation::MutationDispatch;

/// Merge strategy accepted by GitHub (`MergeMethod`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

impl MergeMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            MergeMethod::Merge => "merge",
            MergeMethod::Squash => "squash",
            MergeMethod::Rebase => "rebase",
        }
    }

    pub fn graphql_upper(self) -> &'static str {
        match self {
            MergeMethod::Merge => "MERGE",
            MergeMethod::Squash => "SQUASH",
            MergeMethod::Rebase => "REBASE",
        }
    }
}

/// Auto-merge / merge-queue action (`enable` | `disable` | `dequeue`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeStateAction {
    Enable,
    Disable,
    Dequeue,
}

/// Custom commit title and body for merge/squash (`ForgeMergeCommit`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeMergeCommit {
    pub title: String,
    pub message: String,
}

impl ForgeMergeCommit {
    pub fn validate(&self) -> Result<(), ForgeError> {
        let title_len = self.title.chars().count();
        if title_len == 0 || title_len > 1_024 || self.message.chars().count() > 65_536 {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        Ok(())
    }
}

/// Auto-merge metadata returned by GitHub (`ForgeMergeState.autoMerge`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoMergeInfo {
    pub method: String,
    pub actor: Option<String>,
    pub enabled_at: String,
}

/// Merge-queue entry metadata (`ForgeMergeState.queue`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeQueueInfo {
    pub id: String,
    pub state: String,
    pub position: u64,
    pub enqueued_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_time_to_merge: Option<u64>,
}

/// Latest deployment of the PR's head commit per environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentInfo {
    pub environment: String,
    pub state: String,
    pub url: Option<String>,
}

/// Prefilled merge/squash commit messages from GitHub.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefillCommitMessages {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge: Option<ForgeMergeCommit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub squash: Option<ForgeMergeCommit>,
}

/// Full merge-state snapshot (`ForgeMergeState`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeMergeState {
    pub head_sha: String,
    pub state: String,
    pub merge_state: String,
    pub review_decision: Option<String>,
    pub checks_state: Option<String>,
    pub auto_merge: Option<AutoMergeInfo>,
    pub queue: Option<MergeQueueInfo>,
    pub rules: Vec<String>,
    pub deployments: Vec<DeploymentInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub methods: Option<Vec<MergeMethod>>,
    pub can_enable: bool,
    pub can_disable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub commit_messages: Option<PrefillCommitMessages>,
    pub can_dequeue: bool,
    pub blockers: Vec<String>,
    pub raw: Value,
}

/// Observe completion against the selected head; never infer it from CI
/// (`mergeStateChangeObserved`).
pub fn merge_state_change_observed(
    state: &ForgeMergeState,
    head_sha: &str,
    action: MergeStateAction,
    method: MergeMethod,
) -> bool {
    if state.head_sha != head_sha {
        return false;
    }
    match action {
        MergeStateAction::Enable => {
            state
                .auto_merge
                .as_ref()
                .is_some_and(|am| am.method == method.graphql_upper())
                || state.queue.is_some()
                || state.state == "MERGED"
        }
        MergeStateAction::Disable => state.auto_merge.is_none(),
        MergeStateAction::Dequeue => state.queue.is_none(),
    }
}

pub(crate) fn is_sha(text: &str) -> bool {
    (40..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

const FIELDS: &str = "id number headRefOid state isDraft mergeStateStatus reviewDecision statusCheckRollup{state} autoMergeRequest{mergeMethod enabledAt enabledBy{login}} viewerCanEnableAutoMerge viewerCanDisableAutoMerge";

fn wrap_query(selection: &str) -> String {
    format!(
        "query($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number:$number){{{selection}}}}}}}"
    )
}

fn base_query() -> String {
    wrap_query(&format!(
        "{FIELDS} mergeQueueEntry{{id state position enqueuedAt}}"
    ))
}

fn extended_query() -> String {
    wrap_query(&format!(
        "{FIELDS} mergeHeadline:viewerMergeHeadlineText(mergeType:MERGE) mergeBody:viewerMergeBodyText(mergeType:MERGE) squashHeadline:viewerMergeHeadlineText(mergeType:SQUASH) squashBody:viewerMergeBodyText(mergeType:SQUASH) mergeQueueEntry{{id state position enqueuedAt estimatedTimeToMerge}} baseRef{{branchProtectionRule{{requiredApprovingReviewCount requiresConversationResolution requiresCommitSignatures requiresLinearHistory}} rules(first:20){{nodes{{type}}}}}} commits(last:1){{nodes{{commit{{deployments(last:10){{nodes{{environment state latestStatus{{state environmentUrl}}}}}}}}}}}}"
    ))
}

fn bounded_text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    (s.chars().count() <= 65_536).then(|| s.to_owned())
}

fn nonneg_u64(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_f64()?;
    if !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as u64)
}

fn pos_u64(v: Option<&Value>) -> Option<u64> {
    nonneg_u64(v).filter(|&n| n >= 1)
}

fn prefill_commit(title: Option<&str>, message: Option<&str>) -> Option<ForgeMergeCommit> {
    let title = title?;
    if title.trim().is_empty() {
        return None;
    }
    let clipped: String = title.chars().take(1_024).collect();
    Some(ForgeMergeCommit {
        title: clipped,
        message: message.unwrap_or("").to_owned(),
    })
}

fn map_state(
    pr: &Map,
    repo: &Map,
    raw: Value,
) -> Result<(String, u64, ForgeMergeState), ForgeError> {
    let id = bounded_text(pr.get("id")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let number = pos_u64(pr.get("number")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let head_sha = pr
        .get("headRefOid")
        .and_then(Value::as_str)
        .filter(|s| is_sha(s))
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
        .to_owned();
    let state_raw =
        bounded_text(pr.get("state")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let is_draft = pr
        .get("isDraft")
        .and_then(Value::as_bool)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let merge_state_status = bounded_text(pr.get("mergeStateStatus"))
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let review_decision = match pr.get("reviewDecision") {
        Some(Value::Null) => None,
        other => Some(bounded_text(other).ok_or_else(|| ForgeError::new(Kind::InvalidData))?),
    };
    let checks_state = match pr.get("statusCheckRollup") {
        Some(Value::Null) => None,
        Some(Value::Object(obj)) => {
            Some(bounded_text(obj.get("state")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?)
        }
        _ => return Err(ForgeError::new(Kind::InvalidData)),
    };
    let auto_merge = match pr.get("autoMergeRequest") {
        Some(Value::Null) => None,
        Some(Value::Object(am)) => {
            let method = bounded_text(am.get("mergeMethod"))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let enabled_at = bounded_text(am.get("enabledAt"))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let actor = match am.get("enabledBy") {
                Some(Value::Null) => None,
                Some(Value::Object(user)) => Some(
                    bounded_text(user.get("login"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                ),
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            Some(AutoMergeInfo {
                method,
                actor,
                enabled_at,
            })
        }
        _ => return Err(ForgeError::new(Kind::InvalidData)),
    };
    let queue = match pr.get("mergeQueueEntry") {
        Some(Value::Null) => None,
        Some(Value::Object(q)) => Some(MergeQueueInfo {
            id: bounded_text(q.get("id")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
            state: bounded_text(q.get("state"))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
            position: nonneg_u64(q.get("position"))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
            enqueued_at: bounded_text(q.get("enqueuedAt"))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
            estimated_time_to_merge: nonneg_u64(q.get("estimatedTimeToMerge")),
        }),
        _ => return Err(ForgeError::new(Kind::InvalidData)),
    };
    let viewer_can_enable = pr
        .get("viewerCanEnableAutoMerge")
        .and_then(Value::as_bool)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
    let viewer_can_disable = pr
        .get("viewerCanDisableAutoMerge")
        .and_then(Value::as_bool)
        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;

    let permission = match repo.get("viewerPermission") {
        Some(Value::Null) | None => None,
        other => bounded_text(other),
    };

    // Allowed merge methods when GitHub reported all three booleans.
    let methods = match (
        repo.get("mergeCommitAllowed").and_then(Value::as_bool),
        repo.get("squashMergeAllowed").and_then(Value::as_bool),
        repo.get("rebaseMergeAllowed").and_then(Value::as_bool),
    ) {
        (Some(m), Some(s), Some(r)) => {
            let mut list = Vec::new();
            if m {
                list.push(MergeMethod::Merge);
            }
            if s {
                list.push(MergeMethod::Squash);
            }
            if r {
                list.push(MergeMethod::Rebase);
            }
            (!list.is_empty()).then_some(list)
        }
        _ => None,
    };

    // Lenient branch protection & rulesets decoding.
    let bpr = pr
        .get("baseRef")
        .and_then(Value::as_object)
        .and_then(|b| b.get("branchProtectionRule"))
        .and_then(Value::as_object);
    let required_count = bpr.and_then(|r| pos_u64(r.get("requiredApprovingReviewCount")));
    let req_conv = bpr
        .and_then(|r| r.get("requiresConversationResolution"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let req_sig = bpr
        .and_then(|r| r.get("requiresCommitSignatures"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let req_linear = bpr
        .and_then(|r| r.get("requiresLinearHistory"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let rule_types: Vec<String> = pr
        .get("baseRef")
        .and_then(Value::as_object)
        .and_then(|b| b.get("rules"))
        .and_then(Value::as_object)
        .and_then(|r| r.get("nodes"))
        .and_then(Value::as_array)
        .map(|nodes| {
            nodes
                .iter()
                .filter_map(|n| bounded_text(n.as_object().and_then(|o| o.get("type"))))
                .collect()
        })
        .unwrap_or_default();

    let reviews_req = if review_decision.as_deref() == Some("REVIEW_REQUIRED") {
        Some(match required_count {
            Some(1) => String::from("1 approving review required."),
            Some(n) => format!("{n} approving reviews required."),
            None => String::from("Required reviews are outstanding."),
        })
    } else {
        None
    };

    let mut rules = Vec::new();
    if merge_state_status == "BLOCKED" {
        if let Some(ref rev) = reviews_req
            && required_count.is_some()
        {
            rules.push(rev.clone());
        }
        if req_conv
            || rule_types
                .iter()
                .any(|t| t == "REQUIRED_REVIEW_THREAD_RESOLUTION")
        {
            rules.push(String::from("Conversations must be resolved."));
        }
        if req_sig || rule_types.iter().any(|t| t == "REQUIRED_SIGNATURES") {
            rules.push(String::from("Signed commits required."));
        }
        if req_linear || rule_types.iter().any(|t| t == "REQUIRED_LINEAR_HISTORY") {
            rules.push(String::from("Linear history required."));
        }
        let explained = !rules.is_empty()
            || reviews_req.is_some()
            || review_decision.as_deref() == Some("CHANGES_REQUESTED")
            || checks_state
                .as_deref()
                .is_some_and(|state| state != "SUCCESS");
        if !explained {
            rules.push(String::from("GitHub's branch rules block this merge."));
        }
    }

    // Latest deployment per environment (up to 10), preserving first-seen environment order.
    let mut latest_deployments: Vec<DeploymentInfo> = Vec::new();
    if let Some(commit_nodes) = pr
        .get("commits")
        .and_then(Value::as_object)
        .and_then(|c| c.get("nodes"))
        .and_then(Value::as_array)
    {
        for node in commit_nodes {
            let Some(dep_nodes) = node
                .as_object()
                .and_then(|n| n.get("commit"))
                .and_then(Value::as_object)
                .and_then(|c| c.get("deployments"))
                .and_then(Value::as_object)
                .and_then(|d| d.get("nodes"))
                .and_then(Value::as_array)
            else {
                continue;
            };
            for dep in dep_nodes {
                let Some(dep_obj) = dep.as_object() else {
                    continue;
                };
                let Some(env) = bounded_text(dep_obj.get("environment")) else {
                    continue;
                };
                let latest_status = dep_obj.get("latestStatus").and_then(Value::as_object);
                let dep_state = latest_status
                    .and_then(|ls| bounded_text(ls.get("state")))
                    .or_else(|| bounded_text(dep_obj.get("state")))
                    .unwrap_or_else(|| String::from("UNKNOWN"));
                let dep_url = latest_status
                    .and_then(|ls| bounded_text(ls.get("environmentUrl")))
                    .filter(|u| !u.is_empty());
                let info = DeploymentInfo {
                    environment: env,
                    state: dep_state,
                    url: dep_url,
                };
                if let Some(existing) = latest_deployments
                    .iter_mut()
                    .find(|d| d.environment == info.environment)
                {
                    *existing = info;
                } else {
                    latest_deployments.push(info);
                }
            }
        }
    }
    latest_deployments.truncate(10);
    let deployments = latest_deployments;

    // Commit message prefills.
    let merge_prefill = prefill_commit(
        bounded_text(pr.get("mergeHeadline")).as_deref(),
        bounded_text(pr.get("mergeBody")).as_deref(),
    );
    let squash_prefill = prefill_commit(
        bounded_text(pr.get("squashHeadline")).as_deref(),
        bounded_text(pr.get("squashBody")).as_deref(),
    );
    let commit_messages = if merge_prefill.is_some() || squash_prefill.is_some() {
        Some(PrefillCommitMessages {
            merge: merge_prefill,
            squash: squash_prefill,
        })
    } else {
        None
    };

    let mut blockers = Vec::new();
    if is_draft {
        blockers.push(String::from("This pull request is a draft."));
    }
    if state_raw != "OPEN" {
        blockers.push(format!("Pull request state: {state_raw}."));
    }
    if let Some(ref rev) = reviews_req {
        blockers.push(rev.clone());
    }
    if review_decision.as_deref() == Some("CHANGES_REQUESTED") {
        blockers.push(String::from("A review requests changes."));
    }
    if let Some(ref cs) = checks_state
        && cs != "SUCCESS"
    {
        blockers.push(format!("Checks: {cs}."));
    }
    if merge_state_status == "BEHIND" {
        blockers.push(String::from("The branch is behind its base."));
    } else if merge_state_status == "BLOCKED" {
        for rule in &rules {
            if reviews_req.as_deref() != Some(rule.as_str()) {
                blockers.push(rule.clone());
            }
        }
    } else if merge_state_status != "CLEAN" {
        blockers.push(format!("GitHub merge rules: {merge_state_status}."));
    }
    if let Some(ref q) = queue {
        blockers.push(format!(
            "Merge queue: {}, position {}.",
            q.state, q.position
        ));
    }

    let can_dequeue =
        queue.is_some() && matches!(permission.as_deref(), Some("WRITE" | "MAINTAIN" | "ADMIN"));

    let can_enable = state_raw == "OPEN" && !is_draft && viewer_can_enable;
    let state = ForgeMergeState {
        head_sha,
        state: if is_draft {
            String::from("DRAFT")
        } else {
            state_raw
        },
        merge_state: merge_state_status,
        review_decision,
        checks_state,
        auto_merge,
        queue,
        rules,
        deployments,
        methods,
        can_enable,
        can_disable: viewer_can_disable,
        commit_messages,
        can_dequeue,
        blockers,
        raw,
    };
    Ok((id, number, state))
}

/// Reads and mutates GitHub pull-request merge state (`GitHubMergeState`).
pub struct GitHubMergeState<'a> {
    api: &'a GhApi<'a>,
    repository: ForgeRepository,
    extended: AtomicBool,
}

impl<'a> GitHubMergeState<'a> {
    pub fn new(api: &'a GhApi<'a>, repository: ForgeRepository) -> Self {
        Self {
            api,
            repository,
            extended: AtomicBool::new(true),
        }
    }

    async fn query(
        &self,
        document: String,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<crate::transport::http::Page, ForgeError> {
        let mut vars = Map::new();
        vars.insert(
            String::from("owner"),
            Value::from(self.repository.owner.as_str()),
        );
        vars.insert(
            String::from("name"),
            Value::from(self.repository.name.as_str()),
        );
        vars.insert(String::from("number"), Value::from(number));
        let mut body = Map::new();
        body.insert(String::from("query"), Value::from(document));
        body.insert(String::from("variables"), Value::Object(vars));
        self.api
            .request(
                "graphql",
                Some(Value::Object(body)),
                Some("POST"),
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await
    }

    async fn read_internal(
        &self,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<(String, ForgeMergeState), ForgeError> {
        if number == 0 {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let use_extended = self.extended.load(Ordering::Relaxed);
        let doc = if use_extended {
            extended_query()
        } else {
            base_query()
        };
        let page = match self.query(doc, number, cancellation.clone()).await {
            Ok(page) => page,
            Err(error) if use_extended && error.is_query_refused() => {
                let fallback = self.query(base_query(), number, cancellation).await?;
                self.extended.store(false, Ordering::Relaxed);
                fallback
            }
            Err(error) => return Err(error),
        };
        let data = page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let repo = match data.get("repository") {
            Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(r)) => r,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let pr = match repo.get("pullRequest") {
            Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(p)) => p,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let (pr_id, pr_num, state) = map_state(pr, repo, page.body.clone())?;
        if pr_num != number {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        Ok((pr_id, state))
    }

    pub async fn read(
        &self,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<ForgeMergeState, ForgeError> {
        Ok(self.read_internal(number, cancellation).await?.1)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn change(
        &self,
        number: u64,
        head_sha: &str,
        action: MergeStateAction,
        method: MergeMethod,
        cancellation: Option<Arc<Cancellation>>,
        allowed: impl Fn() -> bool,
        dispatch: Arc<MutationDispatch>,
        commit: Option<&ForgeMergeCommit>,
    ) -> Result<Option<ForgeMergeState>, ForgeError> {
        if !is_sha(head_sha) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        if let Some(c) = commit {
            c.validate()?;
        }
        let (pr_id, state) = self.read_internal(number, cancellation.clone()).await?;
        if !allowed() {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        if state.head_sha != head_sha {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        }
        // Reconcile an already-completed action before issuing another write.
        match action {
            MergeStateAction::Enable
                if state.queue.is_some()
                    || state
                        .auto_merge
                        .as_ref()
                        .is_some_and(|am| am.method == method.graphql_upper()) =>
            {
                return Ok(Some(state));
            }
            MergeStateAction::Disable if state.auto_merge.is_none() => return Ok(Some(state)),
            MergeStateAction::Dequeue if state.queue.is_none() => return Ok(Some(state)),
            _ => {}
        }
        let can_do = match action {
            MergeStateAction::Enable => state.can_enable,
            MergeStateAction::Disable => state.can_disable,
            MergeStateAction::Dequeue => state.can_dequeue,
        };
        if !can_do {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }

        let (mutation, input_type) = match action {
            MergeStateAction::Enable => (
                "enablePullRequestAutoMerge",
                "EnablePullRequestAutoMergeInput",
            ),
            MergeStateAction::Disable => (
                "disablePullRequestAutoMerge",
                "DisablePullRequestAutoMergeInput",
            ),
            MergeStateAction::Dequeue => ("dequeuePullRequest", "DequeuePullRequestInput"),
        };
        let mut input = Map::new();
        match action {
            MergeStateAction::Enable => {
                input.insert(String::from("pullRequestId"), Value::from(pr_id.as_str()));
                input.insert(String::from("expectedHeadOid"), Value::from(head_sha));
                input.insert(
                    String::from("mergeMethod"),
                    Value::from(method.graphql_upper()),
                );
                if let Some(c) = commit
                    && method != MergeMethod::Rebase
                {
                    input.insert(
                        String::from("commitHeadline"),
                        Value::from(c.title.as_str()),
                    );
                    input.insert(String::from("commitBody"), Value::from(c.message.as_str()));
                }
            }
            MergeStateAction::Disable => {
                input.insert(String::from("pullRequestId"), Value::from(pr_id.as_str()));
            }
            MergeStateAction::Dequeue => {
                input.insert(String::from("id"), Value::from(pr_id.as_str()));
            }
        }
        let mut vars = Map::new();
        vars.insert(String::from("input"), Value::Object(input));
        let mut body = Map::new();
        body.insert(
            String::from("query"),
            Value::from(format!(
                "mutation($input:{input_type}!){{{mutation}(input:$input){{pullRequest{{id}}}}}}"
            )),
        );
        body.insert(String::from("variables"), Value::Object(vars));

        let send_outcome = self
            .api
            .request(
                "graphql",
                Some(Value::Object(body)),
                Some("POST"),
                cancellation.clone(),
                dispatch.clone(),
            )
            .await;

        let failure = match send_outcome {
            Ok(page) => {
                let ack_id = page
                    .body
                    .as_object()
                    .and_then(|o| o.get("data"))
                    .and_then(Value::as_object)
                    .and_then(|d| d.get(mutation))
                    .and_then(Value::as_object)
                    .and_then(|m| m.get("pullRequest"))
                    .and_then(Value::as_object)
                    .and_then(|p| p.get("id"))
                    .and_then(Value::as_str);
                if ack_id == Some(pr_id.as_str()) && !page.identity_changed {
                    return Ok(None);
                }
                uncertain_receipt(number, head_sha)
            }
            Err(error) => {
                if dispatch.definitely_failed() {
                    return Err(error);
                }
                error
            }
        };

        // Reconcile an ambiguous mutation against a fresh read on the same head.
        let current = match self.read(number, cancellation).await {
            Ok(s) => s,
            Err(_) => return Err(failure),
        };
        if !merge_state_change_observed(&current, head_sha, action, method) {
            return Err(failure);
        }
        Ok(Some(current))
    }
}

fn uncertain_receipt(number: u64, head_sha: &str) -> ForgeError {
    let mut receipt = Map::new();
    receipt.insert(String::from("number"), Value::from(number));
    receipt.insert(String::from("headSha"), Value::from(head_sha));
    let mut err = ForgeError::new(Kind::OutcomeUncertain);
    err.receipt = Some(Value::Object(receipt));
    err
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use ace_redaction::EnvironmentMatcher;

    use super::*;
    use crate::pure::ForgeKind;
    use crate::transport::command::{CommandRequest, CommandResult, Runner};

    struct QueueRunner {
        replies: Mutex<Vec<CommandResult>>,
        seen: Mutex<Vec<CommandRequest>>,
    }

    impl QueueRunner {
        fn new(replies: Vec<CommandResult>) -> Self {
            Self {
                replies: Mutex::new(replies),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl Runner for QueueRunner {
        fn credential_environment(&self) -> Option<EnvironmentMatcher> {
            None
        }

        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>,
        > {
            self.seen.lock().unwrap().push(request);
            let next = self.replies.lock().unwrap().remove(0);
            Box::pin(async move { Ok(next) })
        }
    }

    fn http(status: u16, json: &str) -> CommandResult {
        CommandResult {
            code: Some(if status < 400 { 0 } else { 1 }),
            stdout: format!("HTTP/2 {status}\r\ncontent-type: application/json\r\n\r\n{json}"),
            truncated: false,
            identity_changed: false,
            http: None,
            unreachable: false,
        }
    }

    fn pr_json(head_sha: &str, auto_merge: &str) -> String {
        format!(
            r#"{{"data":{{"repository":{{"viewerPermission":"WRITE","mergeCommitAllowed":true,"squashMergeAllowed":true,"rebaseMergeAllowed":false,"pullRequest":{{"id":"PR_1","number":8,"headRefOid":"{head_sha}","state":"OPEN","isDraft":false,"mergeStateStatus":"BLOCKED","reviewDecision":"REVIEW_REQUIRED","statusCheckRollup":{{"state":"SUCCESS"}},"autoMergeRequest":{auto_merge},"mergeQueueEntry":null,"viewerCanEnableAutoMerge":true,"viewerCanDisableAutoMerge":true,"baseRef":{{"branchProtectionRule":{{"requiredApprovingReviewCount":2,"requiresConversationResolution":true,"requiresCommitSignatures":false,"requiresLinearHistory":true}},"rules":{{"nodes":[]}}}}}}}}}}}}"#
        )
    }

    #[tokio::test]
    async fn falls_back_from_extended_query_on_schema_refusal_and_refuses_moved_head() {
        let sha_old = "a".repeat(40);
        let sha_new = "b".repeat(40);
        let runner = QueueRunner::new(vec![
            http(
                200,
                r#"{"errors":[{"message":"Field 'viewerMergeHeadlineText' doesn't exist","extensions":{"code":"undefinedField"}}]}"#,
            ),
            http(200, &pr_json(&sha_new, "null")),
        ]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 0.0));
        let repo =
            ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", "ace").unwrap();
        let ms = GitHubMergeState::new(&api, repo);
        let dispatch = Arc::new(MutationDispatch::default());

        let err = ms
            .change(
                8,
                &sha_old,
                MergeStateAction::Enable,
                MergeMethod::Squash,
                None,
                || true,
                dispatch,
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, Kind::Conflict);
        assert_eq!(err.dispatched, Some(false));
        // Only the two read queries ran; no mutation was dispatched.
        assert_eq!(runner.seen.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn enable_auto_merge_sends_expected_head_oid_and_reconciles_uncertain_reply() {
        let sha = "c".repeat(40);
        let runner = QueueRunner::new(vec![
            http(200, &pr_json(&sha, "null")),
            // Ambiguous mutation reply (missing pullRequest.id).
            http(200, r#"{"data":{"enablePullRequestAutoMerge":{}}}"#),
            // Reconciliation read observes autoMerge enabled for the same head.
            http(
                200,
                &pr_json(
                    &sha,
                    r#"{"mergeMethod":"SQUASH","enabledAt":"2026-01-01T00:00:00Z","enabledBy":{"login":"octo"}}"#,
                ),
            ),
        ]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 0.0));
        let repo =
            ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", "ace").unwrap();
        let ms = GitHubMergeState::new(&api, repo);
        let dispatch = Arc::new(MutationDispatch::default());

        let reconciled = ms
            .change(
                8,
                &sha,
                MergeStateAction::Enable,
                MergeMethod::Squash,
                None,
                || true,
                dispatch,
                Some(&ForgeMergeCommit {
                    title: "Ship it".into(),
                    message: "Details".into(),
                }),
            )
            .await
            .unwrap()
            .expect("reconciled state");
        assert_eq!(reconciled.auto_merge.as_ref().unwrap().method, "SQUASH");
        assert_eq!(
            reconciled.methods,
            Some(vec![MergeMethod::Merge, MergeMethod::Squash])
        );
        // Verify mutation input carried expectedHeadOid and commitHeadline.
        let sent_input = runner.seen.lock().unwrap()[1].input.clone().unwrap();
        assert!(sent_input.contains(&sha));
        assert!(sent_input.contains("Ship it"));
    }
}
