// SPDX-License-Identifier: Apache-2.0
//! Native GitHub PR stacks (`github-stacks.ts`, `github-stack-checks.ts`,
//! `github-stack-scope.ts`, `local-stacks.ts`).
//!
//! Write safety: every stack merge reads the live stack and compares every layer against
//! `ForgeStackExpected` (`same_stack`) before sending `PUT .../merge-async` pinned to the
//! expected head SHA. An async merge never reports `"merged"` before the host confirms it.

use std::collections::HashSet;
use std::sync::Arc;

use ace_json::{Array, Map, Value};
use serde::Serialize;

use crate::github::merge_state::{MergeMethod, is_sha};
use crate::pure::ForgeRepository;
use crate::pure::stack_plan::{
    ForgeStack as PlanStack, ForgeStackExpected, ForgeStackLayer as PlanLayer, same_stack,
    stack_pr_state,
};
use crate::transport::command::Cancellation;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::http_errors::{StackMergeOperation, decode_stack_merge_operation, is_uuid};
use crate::transport::limits::ReadBudget;
use crate::transport::mutation::MutationDispatch;

const FIRST_CHECK_PAGE: usize = 20;
const NEXT_CHECK_PAGE: usize = 100;
const MAX_CHECK_FOLLOW_UPS: usize = 8;
const MAX_REQUIRED_CHECKS: usize = 100;

const MEMBER_FIELDS: &str = "number stack{id number baseRefName size} stackEntry{position}";
const LAYER_FIELDS: &str = "number title url headRefOid headRefName baseRefName state isDraft mergeStateStatus reviewDecision statusCheckRollup{state} mergeQueueEntry{state}";

/// Required check status for one stack layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackRequiredCheck {
    pub name: String,
    pub state: String,
}

/// One layer in a native GitHub stack (`ForgeStackLayer`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackLayer {
    pub number: u64,
    pub position: u64,
    pub title: String,
    pub url: String,
    pub head_sha: String,
    pub branch: String,
    pub base_branch: String,
    pub state: String,
    pub merge_state: String,
    pub review_decision: Option<String>,
    pub checks_state: Option<String>,
    pub queue_state: Option<String>,
    pub required_checks: Vec<StackRequiredCheck>,
    pub checks_truncated: bool,
}

/// Full native GitHub stack (`ForgeStack`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStack {
    pub id: String,
    pub number: u64,
    pub trunk: String,
    pub layers: Vec<StackLayer>,
    pub can_merge: bool,
    pub raw: Value,
}

impl HostStack {
    /// Projects this host stack into the pure planning representation.
    pub fn as_plan_stack(&self) -> PlanStack {
        PlanStack {
            id: self.id.clone(),
            trunk: self.trunk.clone(),
            layers: self
                .layers
                .iter()
                .map(|l| PlanLayer {
                    number: l.number,
                    branch: l.branch.clone(),
                    url: l.url.clone(),
                    state: l.state.clone(),
                    head_sha: l.head_sha.clone(),
                })
                .collect(),
        }
    }
}

/// Membership summary for one PR (`ForgeStackMembership`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackMembershipInfo {
    pub id: String,
    pub number: u64,
    pub trunk: String,
    pub size: u64,
    pub position: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackMembership {
    pub number: u64,
    pub stack: Option<StackMembershipInfo>,
    pub raw: Value,
}

/// Queue & state facts for a merge scope (`readStackMergeScope`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StackMergeScopeEntry {
    pub number: u64,
    pub state: String,
    pub queue_state: Option<String>,
    pub raw: Value,
}

/// Local rebase / push operation result (`ForgeStackOperation` for non-merge actions).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalStackOperation {
    pub action: String,
    pub state: String,
    pub message: String,
}

fn bounded_text(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    (s.chars().count() <= 65_536).then(|| s.to_owned())
}

fn pos_u64(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_f64()?;
    if !n.is_finite() || n < 1.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as u64)
}

fn unique_positive_numbers(numbers: &[u64]) -> Result<Vec<u64>, ForgeError> {
    if numbers.len() > 100 || numbers.contains(&0) {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for &n in numbers {
        if seen.insert(n) {
            out.push(n);
        }
    }
    Ok(out)
}

fn context_fields(number: u64, page: usize, cursor: Option<&str>) -> String {
    let after = match cursor {
        Some(_) => format!(",after:$c{number}"),
        None => String::new(),
    };
    format!(
        "pr{number}:pullRequest(number:{number}){{headRefOid statusCheckRollup{{contexts(first:{page}{after}){{pageInfo{{hasNextPage endCursor}} nodes{{kind:__typename ... on CheckRun{{name status conclusion isRequired(pullRequestNumber:{number})}} ... on StatusContext{{context state isRequired(pullRequestNumber:{number})}}}}}}}}}}"
    )
}

fn extract_required_check(node: &Value) -> Option<StackRequiredCheck> {
    let obj = node.as_object()?;
    if obj.get("isRequired").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let kind = bounded_text(obj.get("kind"))?;
    let (name, state) = if kind == "CheckRun" {
        let name = bounded_text(obj.get("name"))?;
        let state = bounded_text(obj.get("conclusion"))
            .or_else(|| bounded_text(obj.get("status")))
            .unwrap_or_else(|| String::from("Unknown"));
        (name, state)
    } else {
        let name = bounded_text(obj.get("context"))?;
        let state = bounded_text(obj.get("state")).unwrap_or_else(|| String::from("Unknown"));
        (name, state)
    };
    if name.is_empty() {
        return None;
    }
    Some(StackRequiredCheck { name, state })
}

struct CheckProgress {
    layer: StackLayer,
    required: Vec<StackRequiredCheck>,
    after: Option<String>,
    truncated: bool,
}

/// Reads required checks for every layer of a stack across pages (`readStackChecks`).
pub async fn read_stack_checks(
    api: &GhApi<'_>,
    repository: &ForgeRepository,
    layers: Vec<StackLayer>,
    cancellation: Option<Arc<Cancellation>>,
) -> Result<(Vec<StackLayer>, Value), ForgeError> {
    let mut budget = ReadBudget::new();
    let mut raw_pages: Vec<Value> = Vec::new();
    let mut progress: Vec<CheckProgress> = layers
        .into_iter()
        .map(|layer| CheckProgress {
            layer,
            required: Vec::new(),
            after: None,
            truncated: false,
        })
        .collect();

    let mut pending_indices: Vec<usize> = (0..progress.len()).collect();
    let mut first = true;
    for request_idx in 0..=MAX_CHECK_FOLLOW_UPS {
        if pending_indices.is_empty() {
            break;
        }
        let mut vars = Map::new();
        vars.insert(
            String::from("owner"),
            Value::from(repository.owner.as_str()),
        );
        vars.insert(String::from("name"), Value::from(repository.name.as_str()));
        let mut declared = vec![
            String::from("$owner:String!"),
            String::from("$name:String!"),
        ];
        let mut fields = Vec::with_capacity(pending_indices.len());
        for &idx in &pending_indices {
            let entry = &progress[idx];
            if let Some(ref cursor) = entry.after {
                vars.insert(
                    format!("c{}", entry.layer.number),
                    Value::from(cursor.as_str()),
                );
                declared.push(format!("$c{}:String!", entry.layer.number));
                fields.push(context_fields(
                    entry.layer.number,
                    NEXT_CHECK_PAGE,
                    Some(cursor),
                ));
            } else {
                fields.push(context_fields(entry.layer.number, FIRST_CHECK_PAGE, None));
            }
        }
        let mut body = Map::new();
        body.insert(
            String::from("query"),
            Value::from(format!(
                "query StackChecks({}){{repository(owner:$owner,name:$name){{{}}}}}",
                declared.join(","),
                fields.join(" ")
            )),
        );
        body.insert(String::from("variables"), Value::Object(vars));
        let page = api
            .request(
                "graphql",
                Some(Value::Object(body)),
                Some("POST"),
                cancellation.clone(),
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        raw_pages.push(page.body.clone());
        let repo = match page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("repository"))
        {
            Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(r)) => r,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };

        for &idx in &pending_indices {
            let entry = &mut progress[idx];
            let pr = match repo.get(&format!("pr{}", entry.layer.number)) {
                Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
                Some(Value::Object(p)) => p,
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            let head_oid = pr
                .get("headRefOid")
                .and_then(Value::as_str)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            if head_oid != entry.layer.head_sha {
                return Err(ForgeError::new(Kind::Conflict));
            }
            let contexts = match pr.get("statusCheckRollup") {
                Some(Value::Null) => None,
                Some(Value::Object(r)) => Some(
                    r.get("contexts")
                        .and_then(Value::as_object)
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                ),
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            if let Some(ctx) = contexts {
                let nodes = ctx
                    .get("nodes")
                    .and_then(Value::as_array)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let max_nodes = if first {
                    FIRST_CHECK_PAGE
                } else {
                    NEXT_CHECK_PAGE
                };
                if nodes.len() > max_nodes {
                    return Err(ForgeError::new(Kind::InvalidData));
                }
                let page_info = ctx
                    .get("pageInfo")
                    .and_then(Value::as_object)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let has_next = page_info
                    .get("hasNextPage")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let end_cursor = match page_info.get("endCursor") {
                    None | Some(Value::Null) => None,
                    Some(v) => {
                        let s = v
                            .as_str()
                            .filter(|s| s.chars().count() <= 1_024)
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                        Some(s.to_owned())
                    }
                };
                for node in nodes {
                    if let Some(req) = extract_required_check(node) {
                        entry.required.push(req);
                    }
                }
                if has_next {
                    if let Some(cursor) = end_cursor {
                        entry.after = Some(cursor);
                    } else {
                        entry.after = None;
                        entry.truncated = true;
                    }
                } else {
                    entry.after = None;
                }
                if entry.required.len() > MAX_REQUIRED_CHECKS {
                    entry.required.truncate(MAX_REQUIRED_CHECKS);
                    entry.truncated = true;
                    entry.after = None;
                }
            } else {
                entry.after = None;
            }
        }
        first = false;
        let within_budget = budget.add(page.bytes as u64).is_ok();
        if !within_budget || request_idx == MAX_CHECK_FOLLOW_UPS {
            break;
        }
        pending_indices = progress
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.after.is_some().then_some(i))
            .collect();
    }

    let checked = progress
        .into_iter()
        .map(|mut p| {
            p.layer.required_checks = p.required;
            p.layer.checks_truncated = p.truncated || p.after.is_some();
            p.layer
        })
        .collect();
    Ok((checked, Value::Array(Array::from(raw_pages))))
}

/// Reads merge queue and state facts for a list of PR numbers (`readStackMergeScope`).
pub async fn read_stack_merge_scope(
    api: &GhApi<'_>,
    repository: &ForgeRepository,
    numbers: &[u64],
    cancellation: Option<Arc<Cancellation>>,
) -> Result<Vec<StackMergeScopeEntry>, ForgeError> {
    let unique = unique_positive_numbers(numbers)?;
    if unique.is_empty() {
        return Ok(Vec::new());
    }
    let fields: Vec<String> = unique
        .iter()
        .map(|n| {
            format!(
                "pr{n}:pullRequest(number:{n}){{number state isDraft mergeQueueEntry{{state}}}}"
            )
        })
        .collect();
    let mut vars = Map::new();
    vars.insert(
        String::from("owner"),
        Value::from(repository.owner.as_str()),
    );
    vars.insert(String::from("name"), Value::from(repository.name.as_str()));
    let mut body = Map::new();
    body.insert(
        String::from("query"),
        Value::from(format!(
            "query StackMergeScope($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{}}}}}",
            fields.join(" ")
        )),
    );
    body.insert(String::from("variables"), Value::Object(vars));
    let page = api
        .request(
            "graphql",
            Some(Value::Object(body)),
            Some("POST"),
            cancellation,
            Arc::new(MutationDispatch::default()),
        )
        .await?;
    let repo = match page
        .body
        .as_object()
        .and_then(|o| o.get("data"))
        .and_then(Value::as_object)
        .and_then(|d| d.get("repository"))
    {
        Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
        Some(Value::Object(r)) => r,
        _ => return Err(ForgeError::new(Kind::InvalidData)),
    };
    let mut out = Vec::with_capacity(unique.len());
    for n in unique {
        let Some(raw_pr) = repo.get(&format!("pr{n}")) else {
            return Err(ForgeError::new(Kind::InvalidData));
        };
        if raw_pr.is_null() {
            return Err(ForgeError::new(Kind::NotFound));
        }
        let pr = raw_pr
            .as_object()
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        if pos_u64(pr.get("number")) != Some(n) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let state_str =
            bounded_text(pr.get("state")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let is_draft = pr
            .get("isDraft")
            .and_then(Value::as_bool)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let queue_state = match pr.get("mergeQueueEntry") {
            Some(Value::Null) => None,
            Some(Value::Object(q)) => Some(
                bounded_text(q.get("state")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
            ),
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        out.push(StackMergeScopeEntry {
            number: n,
            state: stack_pr_state(&state_str, is_draft).to_owned(),
            queue_state,
            raw: raw_pr.clone(),
        });
    }
    Ok(out)
}

/// Native GitHub stack reader & async merger (`GitHubStacks`).
pub struct GitHubStacks<'a> {
    api: &'a GhApi<'a>,
    repository: ForgeRepository,
    root: String,
}

impl<'a> GitHubStacks<'a> {
    pub fn new(api: &'a GhApi<'a>, repository: ForgeRepository) -> Self {
        let root = format!("repos/{}/{}", repository.owner, repository.name);
        Self {
            api,
            repository,
            root,
        }
    }

    pub async fn memberships(
        &self,
        numbers: &[u64],
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Vec<StackMembership>, ForgeError> {
        let unique = unique_positive_numbers(numbers)?;
        if unique.is_empty() {
            return Ok(Vec::new());
        }
        let fields: Vec<String> = unique
            .iter()
            .map(|n| format!("pr{n}:pullRequest(number:{n}){{{MEMBER_FIELDS}}}"))
            .collect();
        let mut vars = Map::new();
        vars.insert(
            String::from("owner"),
            Value::from(self.repository.owner.as_str()),
        );
        vars.insert(
            String::from("name"),
            Value::from(self.repository.name.as_str()),
        );
        let mut body = Map::new();
        body.insert(
            String::from("query"),
            Value::from(format!(
                "query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{}}}}}",
                fields.join(" ")
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
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let repo = match page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("repository"))
        {
            Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(r)) => r,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let mut out = Vec::with_capacity(unique.len());
        for n in unique {
            let Some(raw_pr) = repo.get(&format!("pr{n}")) else {
                return Err(ForgeError::new(Kind::InvalidData));
            };
            if raw_pr.is_null() {
                out.push(StackMembership {
                    number: n,
                    stack: None,
                    raw: Value::Null,
                });
                continue;
            }
            let pr = raw_pr
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            if pos_u64(pr.get("number")) != Some(n) {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            let stack_info = match pr.get("stack") {
                Some(Value::Null) => None,
                Some(Value::Object(s)) => {
                    let entry = pr
                        .get("stackEntry")
                        .and_then(Value::as_object)
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                    let size = pos_u64(s.get("size"))
                        .filter(|&v| v <= 100)
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                    let position = pos_u64(entry.get("position"))
                        .filter(|&v| v <= 100)
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                    Some(StackMembershipInfo {
                        id: bounded_text(s.get("id"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                        number: pos_u64(s.get("number"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                        trunk: bounded_text(s.get("baseRefName"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                        size,
                        position,
                    })
                }
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            out.push(StackMembership {
                number: n,
                stack: stack_info,
                raw: raw_pr.clone(),
            });
        }
        Ok(out)
    }

    pub async fn merge_scope(
        &self,
        numbers: &[u64],
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Vec<StackMergeScopeEntry>, ForgeError> {
        read_stack_merge_scope(self.api, &self.repository, numbers, cancellation).await
    }

    pub async fn read(
        &self,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Option<HostStack>, ForgeError> {
        if number == 0 {
            return Err(ForgeError::new(Kind::InvalidData));
        }
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
        body.insert(
            String::from("query"),
            Value::from(format!(
                "query($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{viewerPermission pullRequest(number:$number){{number stack{{id number baseRefName size entries(first:100){{pageInfo{{hasNextPage}} nodes{{position pullRequest{{ {LAYER_FIELDS} }} }} }} }} }} }} }}"
            )),
        );
        body.insert(String::from("variables"), Value::Object(vars));
        let page = self
            .api
            .request(
                "graphql",
                Some(Value::Object(body)),
                Some("POST"),
                cancellation.clone(),
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let repo = match page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("repository"))
        {
            Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(r)) => r,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let pr_root = match repo.get("pullRequest") {
            Some(Value::Null) => return Err(ForgeError::new(Kind::NotFound)),
            Some(Value::Object(p)) => p,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        if pos_u64(pr_root.get("number")) != Some(number) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let stack = match pr_root.get("stack") {
            Some(Value::Null) => return Ok(None),
            Some(Value::Object(s)) => s,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let stack_id =
            bounded_text(stack.get("id")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let stack_num =
            pos_u64(stack.get("number")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let trunk = bounded_text(stack.get("baseRefName"))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let size = pos_u64(stack.get("size"))
            .filter(|&v| v <= 100)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let entries = stack
            .get("entries")
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        if entries
            .get("pageInfo")
            .and_then(Value::as_object)
            .and_then(|p| p.get("hasNextPage"))
            .and_then(Value::as_bool)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
        {
            return Err(ForgeError::new(Kind::Limit));
        }
        let raw_nodes = entries
            .get("nodes")
            .and_then(Value::as_array)
            .filter(|arr| arr.len() <= 100)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let mut parsed_nodes: Vec<(u64, &Map)> = Vec::with_capacity(raw_nodes.len());
        for node in raw_nodes {
            let obj = node
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let pos =
                pos_u64(obj.get("position")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let pr = obj
                .get("pullRequest")
                .and_then(Value::as_object)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            parsed_nodes.push((pos, pr));
        }
        parsed_nodes.sort_by_key(|(pos, _)| *pos);
        if parsed_nodes.len() as u64 != size {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let mut seen = HashSet::new();
        let mut layers = Vec::with_capacity(parsed_nodes.len());
        for (idx, (position, pr)) in parsed_nodes.into_iter().enumerate() {
            if position != (idx as u64) + 1 {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            let pr_num =
                pos_u64(pr.get("number")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            if !seen.insert(pr_num) {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            let url = bounded_text(pr.get("url"))
                .filter(|u| u.chars().count() <= 4096)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let expected_url = format!(
                "https://{}/{}/{}/pull/{pr_num}",
                self.repository.host, self.repository.owner, self.repository.name
            );
            if url.to_lowercase() != expected_url.to_lowercase() {
                return Err(ForgeError::new(Kind::InvalidData));
            }
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
            let review_decision = match pr.get("reviewDecision") {
                Some(Value::Null) => None,
                other => {
                    Some(bounded_text(other).ok_or_else(|| ForgeError::new(Kind::InvalidData))?)
                }
            };
            let checks_state = match pr.get("statusCheckRollup") {
                Some(Value::Null) => None,
                Some(Value::Object(r)) => Some(
                    bounded_text(r.get("state"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                ),
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            let queue_state = match pr.get("mergeQueueEntry") {
                Some(Value::Null) => None,
                Some(Value::Object(q)) => Some(
                    bounded_text(q.get("state"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                ),
                _ => return Err(ForgeError::new(Kind::InvalidData)),
            };
            layers.push(StackLayer {
                number: pr_num,
                position,
                title: bounded_text(pr.get("title"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                url,
                head_sha,
                branch: bounded_text(pr.get("headRefName"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                base_branch: bounded_text(pr.get("baseRefName"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                state: stack_pr_state(&state_raw, is_draft).to_owned(),
                merge_state: bounded_text(pr.get("mergeStateStatus"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                review_decision,
                checks_state,
                queue_state,
                required_checks: Vec::new(),
                checks_truncated: false,
            });
        }
        if !seen.contains(&number) {
            return Err(ForgeError::new(Kind::InvalidData));
        }

        let (checked_layers, checks_raw) =
            read_stack_checks(self.api, &self.repository, layers, cancellation).await?;
        let permission = match repo.get("viewerPermission") {
            Some(Value::Null) | None => None,
            other => bounded_text(other),
        };
        let mut raw = Map::new();
        raw.insert(String::from("stack"), page.body);
        raw.insert(String::from("checks"), checks_raw);
        Ok(Some(HostStack {
            id: stack_id,
            number: stack_num,
            trunk,
            layers: checked_layers,
            can_merge: matches!(permission.as_deref(), Some("WRITE" | "MAINTAIN" | "ADMIN")),
            raw: Value::Object(raw),
        }))
    }

    /// Submits a pinned-head asynchronous stack merge (`PUT .../pulls/:n/merge-async`).
    ///
    /// Never reports `"merged"` before GitHub confirms it; refuses any moved head, changed
    /// lower layer, removed layer, or non-open lower layer without dispatching a write.
    pub async fn merge(
        &self,
        number: u64,
        expected: &ForgeStackExpected,
        method: MergeMethod,
        cancellation: Option<Arc<Cancellation>>,
        allowed: impl Fn() -> bool,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<StackMergeOperation, ForgeError> {
        let Some(stack) = self.read(number, cancellation.clone()).await? else {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        };
        if !same_stack(expected, &stack.as_plan_stack()) {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        }
        let Some(position) = stack.layers.iter().position(|l| l.number == number) else {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        };
        let scope = &stack.layers[..=position];
        let Some(head) = scope.last().map(|l| l.head_sha.as_str()) else {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        };
        if !allowed() {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        if scope.iter().all(|l| l.state == "MERGED") {
            return Ok(StackMergeOperation {
                action: "merge",
                state: String::from("merged"),
                message: String::from("GitHub reports all requested layers merged."),
                uuid: None,
                raw: Value::Null,
            });
        }
        if scope
            .iter()
            .all(|l| l.state == "MERGED" || l.queue_state.is_some())
        {
            return Ok(StackMergeOperation {
                action: "merge",
                state: String::from("enqueued"),
                message: String::from("GitHub reports the requested layers already queued."),
                uuid: None,
                raw: Value::Null,
            });
        }
        if !stack.can_merge {
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        if scope
            .iter()
            .any(|l| l.state != "OPEN" && l.state != "MERGED")
        {
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        }

        let mut body = Map::new();
        body.insert(String::from("sha"), Value::from(head));
        body.insert(String::from("merge_method"), Value::from(method.as_str()));
        body.insert(String::from("merge_action"), Value::from("default"));
        body.insert(String::from("bypass_rules"), Value::Bool(false));
        let response = self
            .api
            .request(
                &format!("{}/pulls/{number}/merge-async", self.root),
                Some(Value::Object(body)),
                Some("PUT"),
                cancellation,
                dispatch,
            )
            .await?;
        if response.identity_changed {
            let mut receipt = Map::new();
            receipt.insert(String::from("dispatched"), Value::Bool(true));
            let mut err = ForgeError::new(Kind::OutcomeUncertain);
            err.receipt = Some(Value::Object(receipt));
            return Err(err);
        }
        decode_stack_merge_operation(&response.body)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))
    }

    /// Polls an asynchronous stack merge result (`GET .../pulls/:n/merge-async/:uuid`).
    pub async fn merge_result(
        &self,
        number: u64,
        uuid: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<StackMergeOperation, ForgeError> {
        if number == 0 || !is_uuid(uuid) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let response = self
            .api
            .request(
                &format!("{}/pulls/{number}/merge-async/{uuid}", self.root),
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        decode_stack_merge_operation(&response.body)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    use ace_redaction::EnvironmentMatcher;

    use super::*;
    use crate::pure::ForgeKind;
    use crate::pure::stack_plan::ExpectedLayer;
    use crate::transport::command::{CommandRequest, CommandResult, Runner};

    const UUID: &str = "4f8b2a1c-3d5e-4f6a-8b9c-0d1e2f3a4b5c";

    struct ScriptRunner {
        replies: Mutex<Vec<CommandResult>>,
        requests: Mutex<Vec<CommandRequest>>,
    }

    impl ScriptRunner {
        fn new(replies: Vec<CommandResult>) -> Self {
            Self {
                replies: Mutex::new(replies),
                requests: Mutex::new(Vec::new()),
            }
        }
    }

    impl Runner for ScriptRunner {
        fn credential_environment(&self) -> Option<EnvironmentMatcher> {
            None
        }

        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> Pin<Box<dyn Future<Output = Result<CommandResult, ForgeError>> + Send + 'a>> {
            self.requests.lock().unwrap().push(request);
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

    fn sha(ch: char) -> String {
        ch.to_string().repeat(40)
    }

    fn stack_graphql(s7: &str, s8: &str, state7: &str) -> String {
        format!(
            r#"{{"data":{{"repository":{{"viewerPermission":"WRITE","pullRequest":{{"number":8,"stack":{{"id":"STACK_42","number":42,"baseRefName":"main","size":2,"entries":{{"pageInfo":{{"hasNextPage":false}},"nodes":[{{"position":2,"pullRequest":{{"number":8,"title":"Layer 2","url":"https://github.com/octo/ace/pull/8","headRefOid":"{s8}","headRefName":"feat-2","baseRefName":"feat-1","state":"OPEN","isDraft":false,"mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":{{"state":"SUCCESS"}},"mergeQueueEntry":null}}}},{{"position":1,"pullRequest":{{"number":7,"title":"Layer 1","url":"https://github.com/octo/ace/pull/7","headRefOid":"{s7}","headRefName":"feat-1","baseRefName":"main","state":"{state7}","isDraft":false,"mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":{{"state":"SUCCESS"}},"mergeQueueEntry":null}}}}]}}}}}}}}}}}}"#
        )
    }

    fn checks_graphql(s7: &str, s8: &str) -> String {
        format!(
            r#"{{"data":{{"repository":{{"pr7":{{"headRefOid":"{s7}","statusCheckRollup":{{"contexts":{{"pageInfo":{{"hasNextPage":false,"endCursor":null}},"nodes":[{{"kind":"CheckRun","name":"CI","status":"COMPLETED","conclusion":"SUCCESS","isRequired":true}}]}}}}}},"pr8":{{"headRefOid":"{s8}","statusCheckRollup":{{"contexts":{{"pageInfo":{{"hasNextPage":false,"endCursor":null}},"nodes":[]}}}}}}}}}}}}"#
        )
    }

    fn expected(s7: &str, s8: &str) -> ForgeStackExpected {
        ForgeStackExpected {
            id: "STACK_42".into(),
            trunk: "main".into(),
            layers: vec![
                ExpectedLayer {
                    number: 7,
                    head_sha: s7.into(),
                },
                ExpectedLayer {
                    number: 8,
                    head_sha: s8.into(),
                },
            ],
            local: None,
        }
    }

    fn repo() -> ForgeRepository {
        ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", "ace").unwrap()
    }

    #[tokio::test]
    async fn merge_async_never_reports_success_before_host_confirms_and_polls_to_completion() {
        let s7 = sha('a');
        let s8 = sha('b');
        let runner = ScriptRunner::new(vec![
            http(200, &stack_graphql(&s7, &s8, "OPEN")),
            http(200, &checks_graphql(&s7, &s8)),
            // Initial PUT merge-async returns 202 pending with UUID — NOT merged!
            http(
                202,
                &format!(
                    r#"{{"status":"pending","details":{{"uuid":"{UUID}","message":"Merge requested"}}}}"#
                ),
            ),
            // First poll returns unknown future_result -> remains uncertain with raw preserved.
            http(
                200,
                r#"{"status":"future_result","details":{"message":"Still running"},"future_field":"retained"}"#,
            ),
            // Second poll confirms merged.
            http(
                200,
                r#"{"status":"merged","details":{"message":"All layers merged"}}"#,
            ),
        ]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 0.0));
        let stacks = GitHubStacks::new(&api, repo());

        let initial = stacks
            .merge(
                8,
                &expected(&s7, &s8),
                MergeMethod::Squash,
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap();
        assert_eq!(initial.state, "pending");
        assert_eq!(initial.uuid.as_deref(), Some(UUID));

        // Verify PUT sent expected head SHA and bypass_rules: false.
        {
            let requests = runner.requests.lock().unwrap();
            let put = &requests[2];
            assert!(put.args.iter().any(|a| a == "PUT"));
            let sent_body = put.input.as_deref().unwrap();
            assert!(sent_body.contains(&s8));
            assert!(sent_body.contains(r#""bypass_rules":false"#));
        }

        let mid = stacks.merge_result(8, UUID, None).await.unwrap();
        assert_eq!(mid.state, "uncertain");
        assert_eq!(mid.raw["future_field"], Value::from("retained"));

        let final_op = stacks.merge_result(8, UUID, None).await.unwrap();
        assert_eq!(final_op.state, "merged");
    }

    #[tokio::test]
    async fn merge_async_refuses_moved_head_or_closed_lower_layer_without_sending_put() {
        let s7 = sha('a');
        let s8 = sha('b');
        let moved = sha('f');
        // Case 1: lower layer head moved.
        let runner1 = ScriptRunner::new(vec![
            http(200, &stack_graphql(&moved, &s8, "OPEN")),
            http(200, &checks_graphql(&moved, &s8)),
        ]);
        let api1 = GhApi::new(&runner1, "github.com", Arc::new(|| 0.0));
        let stacks1 = GitHubStacks::new(&api1, repo());
        let err1 = stacks1
            .merge(
                8,
                &expected(&s7, &s8),
                MergeMethod::Squash,
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap_err();
        assert_eq!(err1.kind, Kind::Conflict);
        assert_eq!(err1.dispatched, Some(false));
        assert!(
            !runner1
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.args.iter().any(|a| a == "PUT"))
        );

        // Case 2: lower layer closed.
        let runner2 = ScriptRunner::new(vec![
            http(200, &stack_graphql(&s7, &s8, "CLOSED")),
            http(200, &checks_graphql(&s7, &s8)),
        ]);
        let api2 = GhApi::new(&runner2, "github.com", Arc::new(|| 0.0));
        let stacks2 = GitHubStacks::new(&api2, repo());
        let err2 = stacks2
            .merge(
                8,
                &expected(&s7, &s8),
                MergeMethod::Squash,
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap_err();
        assert_eq!(err2.kind, Kind::Conflict);
        assert_eq!(err2.dispatched, Some(false));
        assert!(
            !runner2
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.args.iter().any(|a| a == "PUT"))
        );
    }

    #[tokio::test]
    async fn merge_async_handles_409_pending_409_plain_conflict_and_400_failed() {
        let s7 = sha('a');
        let s8 = sha('b');

        // 409 with pending+UUID adopts UUID without treating it as merged.
        let r_adopt = ScriptRunner::new(vec![
            http(200, &stack_graphql(&s7, &s8, "OPEN")),
            http(200, &checks_graphql(&s7, &s8)),
            http(
                409,
                &format!(
                    r#"{{"status":"pending","details":{{"uuid":"{UUID}","message":"Already pending"}}}}"#
                ),
            ),
        ]);
        let api_adopt = GhApi::new(&r_adopt, "github.com", Arc::new(|| 0.0));
        let op = GitHubStacks::new(&api_adopt, repo())
            .merge(
                8,
                &expected(&s7, &s8),
                MergeMethod::Squash,
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap();
        assert_eq!(op.state, "pending");
        assert_eq!(op.uuid.as_deref(), Some(UUID));

        // 409 without UUID refuses as Conflict with dispatched: false.
        let r_refuse = ScriptRunner::new(vec![
            http(200, &stack_graphql(&s7, &s8, "OPEN")),
            http(200, &checks_graphql(&s7, &s8)),
            http(
                409,
                r#"{"status":"pending","details":{"message":"No UUID here"}}"#,
            ),
        ]);
        let api_refuse = GhApi::new(&r_refuse, "github.com", Arc::new(|| 0.0));
        let err = GitHubStacks::new(&api_refuse, repo())
            .merge(
                8,
                &expected(&s7, &s8),
                MergeMethod::Squash,
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, Kind::Conflict);
        assert_eq!(err.dispatched, Some(false));

        // 400 with failed result stays visible as failed (never success).
        let r_fail = ScriptRunner::new(vec![
            http(200, &stack_graphql(&s7, &s8, "OPEN")),
            http(200, &checks_graphql(&s7, &s8)),
            http(
                400,
                r#"{"status":"failed","details":{"message":"Rules rejected"}}"#,
            ),
        ]);
        let api_fail = GhApi::new(&r_fail, "github.com", Arc::new(|| 0.0));
        let failed = GitHubStacks::new(&api_fail, repo())
            .merge(
                8,
                &expected(&s7, &s8),
                MergeMethod::Squash,
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap();
        assert_eq!(failed.state, "failed");
        assert_eq!(failed.message, "Rules rejected");
    }
}
