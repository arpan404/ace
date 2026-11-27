// SPDX-License-Identifier: Apache-2.0
//! Single GitHub lifecycle action owner (`github-lifecycle.ts`, `github-lifecycle-schemas.ts`).

use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ace_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::github::lifecycle_writes::{
    ForgeLifecycleAction, ForgeLifecycleReceipt, ForgeLifecycleSnapshot, GitHubLifecycleWrites,
    LifecycleCapabilityFacts, LifecycleClosingIssue, LifecycleConversation, LifecycleEditChanges,
    LifecycleExtraFacts, LifecycleHeadBranch, LifecycleMetadata, LifecycleMilestone,
    LifecycleState, LockReason, WRITE_ROLES, assert_lifecycle_action, dispatched_uncertain,
    lifecycle_capabilities, lifecycle_mutation_name, metadata_matches,
};
use crate::github::merge_state::is_sha;
use crate::pure::{ForgePrRef, ForgeRepository};
use crate::transport::command::Cancellation;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::limits::ReadBudget;
use crate::transport::mutation::MutationDispatch;

const LIFECYCLE_PR_FIELDS: &str = "id number title body state isDraft headRefOid baseRefOid baseRefName updatedAt mergeCommit { oid } viewerCanUpdate viewerCanClose viewerCanReopen viewerCanUpdateBranch viewerCanLabel viewerCanAssign canBeRebased labels(first:100){ nodes { id name } pageInfo { hasNextPage } } assignees(first:100){ nodes { id login } pageInfo { hasNextPage } }";
const LIFECYCLE_EXTRA_REPO_FIELDS: &str = "deleteBranchOnMerge defaultBranchRef { name }";
const CLOSING_FIELDS: &str =
    "nodes { number title state url repository { name owner { login } } } pageInfo { hasNextPage }";

fn lifecycle_extra_pr_fields() -> String {
    format!(
        "milestone {{ number title state dueOn }} locked activeLockReason headRefName headRef {{ name associatedPullRequests(states:OPEN,first:10){{ nodes {{ number }} }} }} isCrossRepository viewerCanDeleteHeadRef closingIssuesReferences(first:50){{ {CLOSING_FIELDS} }} manualClosingIssues:closingIssuesReferences(first:50,userLinkedOnly:true){{ {CLOSING_FIELDS} }}"
    )
}

fn snapshot_document(extended: bool) -> String {
    let extra_repo = if extended {
        LIFECYCLE_EXTRA_REPO_FIELDS
    } else {
        ""
    };
    let extra_pr = if extended {
        lifecycle_extra_pr_fields()
    } else {
        String::new()
    };
    format!(
        "query AceLifecycleSnapshot($owner:String!,$name:String!,$number:Int!){{repository(owner:$owner,name:$name){{isArchived viewerPermission {extra_repo} pullRequest(number:$number){{{LIFECYCLE_PR_FIELDS} {extra_pr}}}}} mutationType:__type(name:\"Mutation\"){{fields{{name}}}}}}"
    )
}

/// Marker embedded in revert PR bodies for post-write observation (`lifecycleWriteMarker`).
pub fn lifecycle_write_marker(operation_id: &str) -> String {
    let digest = Sha256::digest(operation_id.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    format!("<!-- ace-revert:{hex} -->")
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
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

fn nonneg_u64(v: Option<&Value>) -> Option<u64> {
    let n = v?.as_f64()?;
    if !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        return None;
    }
    Some(n as u64)
}

struct MappedExtras {
    milestone: Option<LifecycleMilestone>,
    conversation: LifecycleConversation,
    head_branch: LifecycleHeadBranch,
    closing_issues: Vec<LifecycleClosingIssue>,
    facts: LifecycleExtraFacts,
}

struct ParsedClosingIssue {
    owner: String,
    name: String,
    number: u64,
    title: String,
    state: String,
    url: String,
}

fn parse_closing_issues(connection: Option<&Value>) -> Option<Vec<ParsedClosingIssue>> {
    let obj = connection?.as_object()?;
    let nodes = obj.get("nodes")?.as_array()?;
    if nodes.len() > 50 {
        return None;
    }
    let _has_next = obj
        .get("pageInfo")?
        .as_object()?
        .get("hasNextPage")?
        .as_bool()?;
    let mut out = Vec::new();
    for node in nodes {
        if node.is_null() {
            continue;
        }
        let n = node.as_object()?;
        let number = pos_u64(n.get("number"))?;
        let title = bounded_text(n.get("title"))?;
        let state = bounded_text(n.get("state"))?;
        let url = bounded_text(n.get("url"))?;
        let repo = n.get("repository")?.as_object()?;
        let name = bounded_text(repo.get("name"))?;
        let owner = bounded_text(repo.get("owner")?.as_object()?.get("login"))?;
        out.push(ParsedClosingIssue {
            owner,
            name,
            number,
            title,
            state,
            url,
        });
    }
    Some(out)
}

fn parse_extras(
    repository: &ForgeRepository,
    repo_obj: &Map,
    pr_obj: &Map,
    permission: Option<&str>,
    number: u64,
) -> Option<MappedExtras> {
    let delete_on_merge = repo_obj.get("deleteBranchOnMerge")?.as_bool()?;
    let default_branch = match repo_obj.get("defaultBranchRef")? {
        Value::Null => None,
        Value::Object(d) => Some(bounded_text(d.get("name"))?),
        _ => return None,
    };
    let milestone = match pr_obj.get("milestone")? {
        Value::Null => None,
        Value::Object(m) => Some(LifecycleMilestone {
            number: pos_u64(m.get("number"))?,
            title: bounded_text(m.get("title"))?,
            state: if bounded_text(m.get("state"))? == "CLOSED" {
                String::from("closed")
            } else {
                String::from("open")
            },
            due_on: match m.get("dueOn")? {
                Value::Null => None,
                other => Some(bounded_text(Some(other))?),
            },
        }),
        _ => return None,
    };
    let locked = pr_obj.get("locked")?.as_bool()?;
    let active_lock_reason = match pr_obj.get("activeLockReason")? {
        Value::Null => None,
        other => Some(bounded_text(Some(other))?),
    };
    let head_ref_name = bounded_text(pr_obj.get("headRefName"))?;
    let (head_exists, open_prs_using_branch) = match pr_obj.get("headRef")? {
        Value::Null => (false, Vec::new()),
        Value::Object(hr) => {
            let _name = bounded_text(hr.get("name"))?;
            let nodes = hr
                .get("associatedPullRequests")?
                .as_object()?
                .get("nodes")?
                .as_array()?;
            if nodes.len() > 10 {
                return None;
            }
            let mut nums = Vec::new();
            for node in nodes {
                if let Some(n) = node.as_object().and_then(|o| pos_u64(o.get("number")))
                    && n != number
                {
                    nums.push(n);
                }
            }
            (true, nums)
        }
        _ => return None,
    };
    let is_cross_repo = pr_obj.get("isCrossRepository")?.as_bool()?;
    let viewer_can_delete_head = pr_obj.get("viewerCanDeleteHeadRef")?.as_bool()?;
    let closing = parse_closing_issues(pr_obj.get("closingIssuesReferences"))?;
    let manual = parse_closing_issues(pr_obj.get("manualClosingIssues"))?;

    let manual_keys: HashSet<String> = manual
        .into_iter()
        .map(|i| {
            format!(
                "{}/{}#{}",
                i.owner.to_lowercase(),
                i.name.to_lowercase(),
                i.number
            )
        })
        .collect();
    let closing_issues = closing
        .into_iter()
        .map(|i| {
            let key = format!(
                "{}/{}#{}",
                i.owner.to_lowercase(),
                i.name.to_lowercase(),
                i.number
            );
            LifecycleClosingIssue {
                r#ref: ForgePrRef {
                    repository: ForgeRepository {
                        forge: repository.forge,
                        host: repository.host.clone(),
                        owner: i.owner,
                        name: i.name,
                    },
                    number: i.number,
                },
                title: i.title,
                state: if i.state == "CLOSED" {
                    String::from("closed")
                } else {
                    String::from("open")
                },
                url: i.url,
                manual: manual_keys.contains(&key),
            }
        })
        .collect();

    let is_default = default_branch.as_deref() == Some(head_ref_name.as_str());
    let facts = LifecycleExtraFacts {
        locked,
        head_exists,
        same_repository: !is_cross_repo,
        is_default,
        delete_on_merge,
        can_restore_head: viewer_can_delete_head,
        open_prs_using_branch: open_prs_using_branch.clone(),
    };
    Some(MappedExtras {
        milestone,
        conversation: LifecycleConversation {
            locked,
            reason: if locked {
                active_lock_reason
                    .as_deref()
                    .and_then(LockReason::from_graphql)
            } else {
                None
            },
            viewer_can_comment: !locked || permission.is_some_and(|p| WRITE_ROLES.contains(&p)),
        },
        head_branch: LifecycleHeadBranch {
            name: head_ref_name,
            exists: facts.head_exists,
            same_repository: facts.same_repository,
            is_default: facts.is_default,
            delete_on_merge: facts.delete_on_merge,
            used_by: open_prs_using_branch,
        },
        closing_issues,
        facts,
    })
}

struct ResolvedNames {
    labels: Option<Vec<(String, String)>>,
    assignees: Option<Vec<(String, String)>>,
}

/// GitHub PR lifecycle manager (`GitHubLifecycle`).
pub struct GitHubLifecycle<'a> {
    api: &'a GhApi<'a>,
    repository: ForgeRepository,
    writes: GitHubLifecycleWrites<'a>,
    extended: AtomicBool,
}

impl<'a> GitHubLifecycle<'a> {
    pub fn new(api: &'a GhApi<'a>, repository: ForgeRepository) -> Self {
        let writes = GitHubLifecycleWrites::new(api, repository.clone());
        Self {
            api,
            repository,
            writes,
            extended: AtomicBool::new(true),
        }
    }

    async fn graphql(
        &self,
        query: &str,
        variables: Map,
        cancellation: Option<Arc<Cancellation>>,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<crate::transport::http::Page, ForgeError> {
        let mut body = Map::new();
        body.insert(String::from("query"), Value::from(query));
        body.insert(String::from("variables"), Value::Object(variables));
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
        Ok(page)
    }

    async fn open_prs_onto(
        &self,
        branch: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Vec<u64>, ForgeError> {
        if branch.is_empty() {
            return Ok(Vec::new());
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
        vars.insert(String::from("branch"), Value::from(branch));
        let page = self
            .graphql(
                "query AceStackedOnto($owner:String!,$name:String!,$branch:String!){repository(owner:$owner,name:$name){pullRequests(baseRefName:$branch,states:OPEN,first:10){nodes{number}}}}",
                vars,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let nodes = page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("repository"))
            .and_then(Value::as_object)
            .and_then(|r| r.get("pullRequests"))
            .and_then(Value::as_object)
            .and_then(|p| p.get("nodes"))
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 10)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let mut out = Vec::with_capacity(nodes.len());
        for node in nodes {
            let n = node
                .as_object()
                .and_then(|o| pos_u64(o.get("number")))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            out.push(n);
        }
        Ok(out)
    }

    async fn snapshot_query(
        &self,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<(crate::transport::http::Page, bool), ForgeError> {
        let make_vars = || {
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
            vars
        };
        if self.extended.load(Ordering::Relaxed) {
            match self
                .graphql(
                    &snapshot_document(true),
                    make_vars(),
                    cancellation.clone(),
                    Arc::new(MutationDispatch::default()),
                )
                .await
            {
                Ok(page) => return Ok((page, true)),
                Err(err) if err.is_query_refused() => {
                    self.extended.store(false, Ordering::Relaxed);
                }
                Err(err) => return Err(err),
            }
        }
        let page = self
            .graphql(
                &snapshot_document(false),
                make_vars(),
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        Ok((page, false))
    }

    pub async fn snapshot(
        &self,
        number: u64,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<ForgeLifecycleSnapshot, ForgeError> {
        if number == 0 {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let pr_ref = ForgePrRef {
            repository: self.repository.clone(),
            number,
        };
        let (response, extended) = self.snapshot_query(number, cancellation.clone()).await?;
        let data = response
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let repo = data
            .get("repository")
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let archived = repo
            .get("isArchived")
            .and_then(Value::as_bool)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let permission = match repo.get("viewerPermission") {
            Some(Value::Null) => None,
            other => Some(bounded_text(other).ok_or_else(|| ForgeError::new(Kind::InvalidData))?),
        };
        let pr = repo
            .get("pullRequest")
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        if pos_u64(pr.get("number")) != Some(number) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let id = bounded_text(pr.get("id")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let title =
            bounded_text(pr.get("title")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let body =
            bounded_text(pr.get("body")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let state_raw =
            bounded_text(pr.get("state")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let is_draft = pr
            .get("isDraft")
            .and_then(Value::as_bool)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let head_sha = pr
            .get("headRefOid")
            .and_then(Value::as_str)
            .filter(|s| is_sha(s))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .to_owned();
        let base_sha = pr
            .get("baseRefOid")
            .and_then(Value::as_str)
            .filter(|s| is_sha(s))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .to_owned();
        let base_branch = bounded_text(pr.get("baseRefName"))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let updated_at =
            bounded_text(pr.get("updatedAt")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let merge_commit = match pr.get("mergeCommit") {
            Some(Value::Null) => None,
            Some(Value::Object(m)) => Some(
                m.get("oid")
                    .and_then(Value::as_str)
                    .filter(|s| is_sha(s))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
                    .to_owned(),
            ),
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };

        let labels_conn = pr
            .get("labels")
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let assignees_conn = pr
            .get("assignees")
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        if labels_conn
            .get("pageInfo")
            .and_then(Value::as_object)
            .and_then(|p| p.get("hasNextPage"))
            .and_then(Value::as_bool)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            || assignees_conn
                .get("pageInfo")
                .and_then(Value::as_object)
                .and_then(|p| p.get("hasNextPage"))
                .and_then(Value::as_bool)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
        {
            return Err(ForgeError::new(Kind::Limit));
        }
        let mut labels: Vec<String> = labels_conn
            .get("nodes")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 100)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .iter()
            .map(|n| {
                let o = n
                    .as_object()
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let _id =
                    bounded_text(o.get("id")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                bounded_text(o.get("name")).ok_or_else(|| ForgeError::new(Kind::InvalidData))
            })
            .collect::<Result<Vec<_>, _>>()?;
        labels.sort();
        let mut assignees: Vec<String> = assignees_conn
            .get("nodes")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 100)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .iter()
            .map(|n| {
                let o = n
                    .as_object()
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let _id =
                    bounded_text(o.get("id")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                bounded_text(o.get("login")).ok_or_else(|| ForgeError::new(Kind::InvalidData))
            })
            .collect::<Result<Vec<_>, _>>()?;
        assignees.sort();

        let supported: HashSet<String> = data
            .get("mutationType")
            .and_then(Value::as_object)
            .and_then(|m| m.get("fields"))
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 1_000)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .iter()
            .map(|f| {
                f.as_object()
                    .and_then(|o| bounded_text(o.get("name")))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))
            })
            .collect::<Result<HashSet<_>, _>>()?;

        let state = match state_raw.as_str() {
            "MERGED" => LifecycleState::Merged,
            "CLOSED" => LifecycleState::Closed,
            "OPEN" if is_draft => LifecycleState::Draft,
            "OPEN" => LifecycleState::Open,
            _ => return Err(ForgeError::new(Kind::Unsupported)),
        };

        let mut extras = if extended {
            parse_extras(&self.repository, repo, pr, permission.as_deref(), number)
        } else {
            None
        };
        if let Some(ref mut ex) = extras
            && state_raw == "CLOSED"
            && ex.facts.head_exists
        {
            let stacked = self
                .open_prs_onto(&ex.head_branch.name, cancellation)
                .await?;
            let mut seen = HashSet::new();
            let mut using = Vec::new();
            for n in ex
                .facts
                .open_prs_using_branch
                .iter()
                .copied()
                .chain(stacked)
            {
                if n != number && seen.insert(n) {
                    using.push(n);
                }
            }
            ex.facts.open_prs_using_branch = using.clone();
            ex.head_branch.used_by = using.into_iter().take(10).collect();
        }

        let metadata = LifecycleMetadata {
            title,
            body,
            base_branch,
            labels,
            assignees,
            milestone: extras
                .as_ref()
                .map(|ex| ex.milestone.as_ref().map(|m| m.number)),
        };

        let version_input = format!(
            "{id}|{}|{head_sha}|{base_sha}|{state:?}|{is_draft}|{updated_at}|{merge_commit:?}|{}",
            ace_json::ser::to_string(&metadata).unwrap_or_default(),
            extras
                .as_ref()
                .map(|ex| ace_json::ser::to_string(&(
                    &ex.milestone,
                    &ex.conversation,
                    &ex.head_branch,
                    &ex.closing_issues
                ))
                .unwrap_or_default())
                .unwrap_or_default()
        );
        let version = sha256_hex(&version_input);

        let bool_field = |k: &str| {
            pr.get(k)
                .and_then(Value::as_bool)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))
        };
        let can_revert = merge_commit.is_some()
            && permission
                .as_deref()
                .is_some_and(|p| WRITE_ROLES.contains(&p));
        let (actions, editable_fields, unsupported) =
            lifecycle_capabilities(&LifecycleCapabilityFacts {
                state,
                archived,
                can_update: bool_field("viewerCanUpdate")?,
                can_label: bool_field("viewerCanLabel")?,
                can_assign: bool_field("viewerCanAssign")?,
                can_close: bool_field("viewerCanClose")?,
                can_reopen: bool_field("viewerCanReopen")?,
                can_update_branch: bool_field("viewerCanUpdateBranch")?,
                rebaseable: bool_field("canBeRebased")?,
                can_revert,
                supported: &supported,
                permission: permission.as_deref(),
                extras: extras.as_ref().map(|e| &e.facts),
            });

        Ok(ForgeLifecycleSnapshot {
            pr: pr_ref,
            id,
            version,
            head_sha,
            base_sha,
            state,
            metadata,
            milestone: extras.as_ref().map(|e| e.milestone.clone()),
            conversation: extras.as_ref().map(|e| e.conversation.clone()),
            head_branch: extras.as_ref().map(|e| e.head_branch.clone()),
            closing_issues: extras.map(|e| e.closing_issues),
            actions,
            editable_fields,
            unsupported,
        })
    }

    async fn resolve_names(
        &self,
        changes: &LifecycleEditChanges,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<ResolvedNames, ForgeError> {
        let labels = changes.labels.as_deref().unwrap_or(&[]);
        let assignees = changes.assignees.as_deref().unwrap_or(&[]);
        if labels.is_empty() && assignees.is_empty() {
            return Ok(ResolvedNames {
                labels: changes.labels.as_ref().map(|_| Vec::new()),
                assignees: changes.assignees.as_ref().map(|_| Vec::new()),
            });
        }
        let label_q: String = labels
            .iter()
            .enumerate()
            .map(|(i, l)| {
                let lit = ace_json::ser::to_string(l).unwrap_or_else(|_| String::from("\"\""));
                format!("l{i}:label(name:{lit}){{id name}}")
            })
            .collect::<Vec<_>>()
            .join(" ");
        let user_q: String = assignees
            .iter()
            .enumerate()
            .map(|(i, u)| {
                let lit = ace_json::ser::to_string(u).unwrap_or_else(|_| String::from("\"\""));
                format!("u{i}:user(login:{lit}){{id login}}")
            })
            .collect::<Vec<_>>()
            .join(" ");
        let query = format!(
            "query($owner:String!,$name:String!){{repository(owner:$owner,name:$name){{{label_q} id}} {user_q}}}"
        );
        let mut vars = Map::new();
        vars.insert(
            String::from("owner"),
            Value::from(self.repository.owner.as_str()),
        );
        vars.insert(
            String::from("name"),
            Value::from(self.repository.name.as_str()),
        );
        let page = self
            .graphql(
                &query,
                vars,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let data = page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let repo = data
            .get("repository")
            .and_then(Value::as_object)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let resolved_labels = if changes.labels.is_some() {
            let mut out = Vec::with_capacity(labels.len());
            for (i, name) in labels.iter().enumerate() {
                match repo.get(&format!("l{i}")) {
                    Some(Value::Null) => {
                        return Err(ForgeError::not_dispatched(Kind::Unprocessable));
                    }
                    Some(Value::Object(l)) => {
                        let id = bounded_text(l.get("id"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                        let got = bounded_text(l.get("name"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                        if &got != name {
                            return Err(ForgeError::not_dispatched(Kind::Conflict));
                        }
                        out.push((id, got));
                    }
                    _ => return Err(ForgeError::new(Kind::InvalidData)),
                }
            }
            Some(out)
        } else {
            None
        };
        let resolved_assignees = if changes.assignees.is_some() {
            let mut out = Vec::with_capacity(assignees.len());
            for (i, login) in assignees.iter().enumerate() {
                match data.get(&format!("u{i}")) {
                    Some(Value::Null) => {
                        return Err(ForgeError::not_dispatched(Kind::Unprocessable));
                    }
                    Some(Value::Object(u)) => {
                        let id = bounded_text(u.get("id"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                        let got = bounded_text(u.get("login"))
                            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                        if got.to_lowercase() != login.to_lowercase() {
                            return Err(ForgeError::not_dispatched(Kind::Conflict));
                        }
                        out.push((id, got));
                    }
                    _ => return Err(ForgeError::new(Kind::InvalidData)),
                }
            }
            Some(out)
        } else {
            None
        };
        Ok(ResolvedNames {
            labels: resolved_labels,
            assignees: resolved_assignees,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn apply(
        &self,
        number: u64,
        expected_version: &str,
        action: &ForgeLifecycleAction,
        operation_id: &str,
        cancellation: Option<Arc<Cancellation>>,
        allowed: impl Fn() -> bool,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<ForgeLifecycleReceipt, ForgeError> {
        let snapshot = self.snapshot(number, cancellation.clone()).await?;
        assert_lifecycle_action(&snapshot, expected_version, action)?;

        if action.is_extra() {
            let prepared = self
                .writes
                .prepare(&snapshot, action, operation_id, cancellation.clone())
                .await?;
            let latest = self.snapshot(number, cancellation.clone()).await?;
            assert_lifecycle_action(&latest, expected_version, action)?;
            if cancellation.as_ref().is_some_and(|c| c.is_cancelled()) || !allowed() {
                return Err(ForgeError::not_dispatched(Kind::Cancelled));
            }
            self.writes
                .execute(prepared, cancellation.clone(), dispatch)
                .await?;
            return match self
                .observe(number, action, &snapshot, operation_id, cancellation)
                .await
            {
                Ok(Some(receipt)) => Ok(receipt),
                Ok(None) => Ok(ForgeLifecycleReceipt {
                    outcome: String::from("pending"),
                    head_sha: snapshot.head_sha,
                    revert_pr: None,
                }),
                Err(_) => Err(dispatched_uncertain()),
            };
        }

        if let ForgeLifecycleAction::Edit(changes) = action
            && let Some(milestone) = changes.milestone
        {
            if changes.base_branch.is_some() {
                return Err(ForgeError::not_dispatched(Kind::InvalidData));
            }
            let names = self.resolve_names(changes, cancellation.clone()).await?;
            let mut body = Map::new();
            if let Some(ref title) = changes.title {
                body.insert(String::from("title"), Value::from(title.as_str()));
            }
            if let Some(ref desc) = changes.body {
                body.insert(String::from("body"), Value::from(desc.as_str()));
            }
            if let Some(labels) = names.labels {
                body.insert(
                    String::from("labels"),
                    Value::Array(
                        labels
                            .into_iter()
                            .map(|(_, n)| Value::from(n))
                            .collect::<Vec<_>>()
                            .into(),
                    ),
                );
            }
            if let Some(assignees) = names.assignees {
                body.insert(
                    String::from("assignees"),
                    Value::Array(
                        assignees
                            .into_iter()
                            .map(|(_, l)| Value::from(l))
                            .collect::<Vec<_>>()
                            .into(),
                    ),
                );
            }
            body.insert(
                String::from("milestone"),
                match milestone {
                    Some(n) => Value::from(n),
                    None => Value::Null,
                },
            );
            let latest = self.snapshot(number, cancellation.clone()).await?;
            assert_lifecycle_action(&latest, expected_version, action)?;
            if cancellation.as_ref().is_some_and(|c| c.is_cancelled()) || !allowed() {
                return Err(ForgeError::not_dispatched(Kind::Cancelled));
            }
            let page = self
                .api
                .request(
                    &format!(
                        "repos/{}/{}/issues/{number}",
                        self.repository.owner, self.repository.name
                    ),
                    Some(Value::Object(body)),
                    Some("PATCH"),
                    cancellation.clone(),
                    dispatch,
                )
                .await?;
            if page.identity_changed {
                return Err(dispatched_uncertain());
            }
            return match self
                .observe(number, action, &snapshot, operation_id, cancellation)
                .await
            {
                Ok(Some(receipt)) => Ok(receipt),
                Ok(None) => Ok(ForgeLifecycleReceipt {
                    outcome: String::from("pending"),
                    head_sha: snapshot.head_sha,
                    revert_pr: None,
                }),
                Err(_) => Err(dispatched_uncertain()),
            };
        }

        let mut input = Map::new();
        input.insert(
            String::from("pullRequestId"),
            Value::from(snapshot.id.as_str()),
        );
        input.insert(String::from("clientMutationId"), Value::from(operation_id));
        let mutation = match action {
            ForgeLifecycleAction::Edit(changes) => {
                if let Some(ref title) = changes.title {
                    input.insert(String::from("title"), Value::from(title.as_str()));
                }
                if let Some(ref body) = changes.body {
                    input.insert(String::from("body"), Value::from(body.as_str()));
                }
                if let Some(ref base) = changes.base_branch {
                    input.insert(String::from("baseRefName"), Value::from(base.as_str()));
                }
                let names = self.resolve_names(changes, cancellation.clone()).await?;
                if let Some(labels) = names.labels {
                    input.insert(
                        String::from("labelIds"),
                        Value::Array(
                            labels
                                .into_iter()
                                .map(|(id, _)| Value::from(id))
                                .collect::<Vec<_>>()
                                .into(),
                        ),
                    );
                }
                if let Some(assignees) = names.assignees {
                    input.insert(
                        String::from("assigneeIds"),
                        Value::Array(
                            assignees
                                .into_iter()
                                .map(|(id, _)| Value::from(id))
                                .collect::<Vec<_>>()
                                .into(),
                        ),
                    );
                }
                "updatePullRequest"
            }
            ForgeLifecycleAction::Revert { title, body } => {
                input.insert(String::from("title"), Value::from(title.as_str()));
                input.insert(
                    String::from("body"),
                    Value::from(format!(
                        "{body}\n\n{}",
                        lifecycle_write_marker(operation_id)
                    )),
                );
                input.insert(String::from("draft"), Value::Bool(true));
                "revertPullRequest"
            }
            ForgeLifecycleAction::UpdateMerge | ForgeLifecycleAction::UpdateRebase => {
                input.insert(
                    String::from("expectedHeadOid"),
                    Value::from(snapshot.head_sha.as_str()),
                );
                input.insert(
                    String::from("updateMethod"),
                    Value::from(if matches!(action, ForgeLifecycleAction::UpdateRebase) {
                        "REBASE"
                    } else {
                        "MERGE"
                    }),
                );
                "updatePullRequestBranch"
            }
            other => lifecycle_mutation_name(other.kind_name())
                .ok_or_else(|| ForgeError::not_dispatched(Kind::Unsupported))?,
        };

        // Recheck preconditions just before writing.
        let latest = self.snapshot(number, cancellation.clone()).await?;
        assert_lifecycle_action(&latest, expected_version, action)?;
        if cancellation.as_ref().is_some_and(|c| c.is_cancelled()) || !allowed() {
            return Err(ForgeError::not_dispatched(Kind::Cancelled));
        }

        let mut chars = mutation.chars();
        let first = chars.next().map(|c| c.to_ascii_uppercase()).unwrap_or('A');
        let input_type = format!("{first}{}Input", chars.as_str());
        let fields = if matches!(action, ForgeLifecycleAction::Revert { .. }) {
            "revertPullRequest { number }"
        } else {
            "pullRequest { headRefOid }"
        };
        let mut vars = Map::new();
        vars.insert(String::from("input"), Value::Object(input));
        let response = self
            .graphql(
                &format!(
                    "mutation($input:{input_type}!){{{mutation}(input:$input){{clientMutationId {fields}}}}}"
                ),
                vars,
                cancellation.clone(),
                dispatch,
            )
            .await?;

        let outcome = async {
            let entry = response
                .body
                .as_object()
                .and_then(|o| o.get("data"))
                .and_then(Value::as_object)
                .and_then(|d| d.get(mutation))
                .and_then(Value::as_object)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            if matches!(action, ForgeLifecycleAction::Revert { .. }) {
                let revert_num = entry
                    .get("revertPullRequest")
                    .and_then(Value::as_object)
                    .and_then(|r| pos_u64(r.get("number")))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                if revert_num == number {
                    return Err(ForgeError::new(Kind::InvalidData));
                }
                return Ok(ForgeLifecycleReceipt {
                    outcome: String::from("accepted"),
                    head_sha: snapshot.head_sha.clone(),
                    revert_pr: Some(ForgePrRef {
                        repository: self.repository.clone(),
                        number: revert_num,
                    }),
                });
            }
            let ack_head = entry
                .get("pullRequest")
                .and_then(Value::as_object)
                .and_then(|p| bounded_text(p.get("headRefOid")))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let current = self.snapshot(number, cancellation.clone()).await?;
            if matches!(
                action,
                ForgeLifecycleAction::UpdateMerge | ForgeLifecycleAction::UpdateRebase
            ) && current.head_sha != ack_head
            {
                return Ok(ForgeLifecycleReceipt {
                    outcome: String::from("head_changed"),
                    head_sha: current.head_sha,
                    revert_pr: None,
                });
            }
            let observed = self
                .observe(number, action, &snapshot, operation_id, cancellation)
                .await?;
            Ok(observed.unwrap_or(ForgeLifecycleReceipt {
                outcome: String::from("pending"),
                head_sha: current.head_sha,
                revert_pr: None,
            }))
        }
        .await;

        outcome.map_err(|_| dispatched_uncertain())
    }

    pub async fn observe(
        &self,
        number: u64,
        action: &ForgeLifecycleAction,
        before: &ForgeLifecycleSnapshot,
        operation_id: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Option<ForgeLifecycleReceipt>, ForgeError> {
        if let ForgeLifecycleAction::Revert { title, .. } = action {
            let marker = lifecycle_write_marker(operation_id);
            let path = format!(
                "repos/{}/{}/pulls?state=all&sort=created&direction=desc&per_page=100",
                self.repository.owner, self.repository.name
            );
            let mut budget = ReadBudget::new();
            let mut endpoint = Some(path.clone());
            for _ in 0..20 {
                let Some(current) = endpoint else {
                    break;
                };
                let page = self
                    .api
                    .request(
                        &current,
                        None,
                        None,
                        cancellation.clone(),
                        Arc::new(MutationDispatch::default()),
                    )
                    .await?;
                budget.add(page.bytes as u64)?;
                let prs = page
                    .body
                    .as_array()
                    .filter(|a| a.len() <= 100)
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let mut matches = Vec::new();
                for pr in prs {
                    let obj = pr
                        .as_object()
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                    let pr_num = pos_u64(obj.get("number"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                    let pr_title = bounded_text(obj.get("title"))
                        .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                    let pr_body = match obj.get("body") {
                        Some(Value::Null) => None,
                        other => Some(
                            bounded_text(other)
                                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                        ),
                    };
                    if pr_num != number
                        && &pr_title == title
                        && pr_body.as_deref().is_some_and(|b| b.contains(&marker))
                    {
                        matches.push(pr_num);
                    }
                }
                if matches.len() > 1 {
                    return Err(ForgeError::new(Kind::Conflict));
                }
                if let Some(&revert_num) = matches.first() {
                    return Ok(Some(ForgeLifecycleReceipt {
                        outcome: String::from("accepted"),
                        head_sha: before.head_sha.clone(),
                        revert_pr: Some(ForgePrRef {
                            repository: self.repository.clone(),
                            number: revert_num,
                        }),
                    }));
                }
                endpoint = self.api.next(&page, &path)?;
            }
            return Ok(None);
        }

        let current = self.snapshot(number, cancellation.clone()).await?;
        let accepted = |head: &str| ForgeLifecycleReceipt {
            outcome: String::from("accepted"),
            head_sha: head.to_owned(),
            revert_pr: None,
        };
        match action {
            ForgeLifecycleAction::Edit(changes) => {
                Ok(metadata_matches(&current, changes).then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::UpdateMerge | ForgeLifecycleAction::UpdateRebase => {
                if current.base_sha != before.base_sha {
                    return Ok(Some(ForgeLifecycleReceipt {
                        outcome: String::from("head_changed"),
                        head_sha: current.head_sha,
                        revert_pr: None,
                    }));
                }
                if current.head_sha == before.head_sha {
                    return Ok(None);
                }
                let compare_page = self
                    .api
                    .request(
                        &format!(
                            "repos/{}/{}/compare/{}...{}",
                            self.repository.owner,
                            self.repository.name,
                            before.base_sha,
                            current.head_sha
                        ),
                        None,
                        None,
                        cancellation.clone(),
                        Arc::new(MutationDispatch::default()),
                    )
                    .await?;
                let behind_by = compare_page
                    .body
                    .as_object()
                    .and_then(|o| nonneg_u64(o.get("behind_by")))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
                let latest = self.snapshot(number, cancellation).await?;
                if latest.head_sha != current.head_sha || latest.base_sha != current.base_sha {
                    return Ok(Some(ForgeLifecycleReceipt {
                        outcome: String::from("head_changed"),
                        head_sha: latest.head_sha,
                        revert_pr: None,
                    }));
                }
                Ok(Some(ForgeLifecycleReceipt {
                    outcome: String::from(if behind_by == 0 {
                        "accepted"
                    } else {
                        "head_changed"
                    }),
                    head_sha: current.head_sha,
                    revert_pr: None,
                }))
            }
            ForgeLifecycleAction::Lock { .. } | ForgeLifecycleAction::Unlock => {
                let want = matches!(action, ForgeLifecycleAction::Lock { .. });
                Ok(current
                    .conversation
                    .as_ref()
                    .is_some_and(|c| c.locked == want)
                    .then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::BranchDelete | ForgeLifecycleAction::BranchRestore => {
                let want = matches!(action, ForgeLifecycleAction::BranchRestore);
                Ok(current
                    .head_branch
                    .as_ref()
                    .is_some_and(|b| b.exists == want)
                    .then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::IssueLink { issue } => {
                let linked = current
                    .closing_issues
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .any(|e| {
                        e.r#ref.number == *issue
                            && e.r#ref.repository.owner.to_lowercase()
                                == self.repository.owner.to_lowercase()
                            && e.r#ref.repository.name.to_lowercase()
                                == self.repository.name.to_lowercase()
                    });
                Ok(linked.then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::IssueUnlink { issue } => {
                let still_linked =
                    current
                        .closing_issues
                        .as_deref()
                        .unwrap_or(&[])
                        .iter()
                        .any(|e| {
                            e.r#ref.number == issue.number
                                && e.r#ref.repository.owner.to_lowercase()
                                    == issue.repository.owner.to_lowercase()
                                && e.r#ref.repository.name.to_lowercase()
                                    == issue.repository.name.to_lowercase()
                                && e.manual
                        });
                Ok((!still_linked).then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::Reopen => Ok(matches!(
                current.state,
                LifecycleState::Open | LifecycleState::Draft
            )
            .then(|| accepted(&current.head_sha))),
            ForgeLifecycleAction::Ready => {
                Ok((current.state == LifecycleState::Open).then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::Draft => {
                Ok((current.state == LifecycleState::Draft).then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::Close => {
                Ok((current.state == LifecycleState::Closed).then(|| accepted(&current.head_sha)))
            }
            ForgeLifecycleAction::Revert { .. } => unreachable!(),
        }
    }
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

    fn snapshot_json(head_sha: &str, state: &str, head_exists: bool) -> String {
        let base_sha = "1".repeat(40);
        let head_ref = if head_exists {
            r#"{"name":"feat","associatedPullRequests":{"nodes":[]}}"#
        } else {
            "null"
        };
        format!(
            r#"{{"data":{{"repository":{{"isArchived":false,"viewerPermission":"WRITE","deleteBranchOnMerge":false,"defaultBranchRef":{{"name":"main"}},"pullRequest":{{"id":"PR_9","number":9,"title":"Old","body":"Body","state":"{state}","isDraft":false,"headRefOid":"{head_sha}","baseRefOid":"{base_sha}","baseRefName":"main","updatedAt":"2026-01-01T00:00:00Z","mergeCommit":null,"viewerCanUpdate":true,"viewerCanClose":true,"viewerCanReopen":true,"viewerCanUpdateBranch":true,"viewerCanLabel":true,"viewerCanAssign":true,"canBeRebased":true,"labels":{{"nodes":[],"pageInfo":{{"hasNextPage":false}}}},"assignees":{{"nodes":[],"pageInfo":{{"hasNextPage":false}}}},"milestone":null,"locked":false,"activeLockReason":null,"headRefName":"feat","headRef":{head_ref},"isCrossRepository":false,"viewerCanDeleteHeadRef":true,"closingIssuesReferences":{{"nodes":[],"pageInfo":{{"hasNextPage":false}}}},"manualClosingIssues":{{"nodes":[],"pageInfo":{{"hasNextPage":false}}}}}}}},"mutationType":{{"fields":[{{"name":"updatePullRequest"}},{{"name":"closePullRequest"}},{{"name":"reopenPullRequest"}},{{"name":"updatePullRequestBranch"}}]}}}}}}"#
        )
    }

    #[tokio::test]
    async fn lifecycle_branch_delete_refuses_moved_head_without_sending_delete() {
        let sha_snap = "a".repeat(40);
        let sha_moved = "b".repeat(40);
        let runner = QueueRunner::new(vec![
            http(200, &snapshot_json(&sha_snap, "CLOSED", true)),
            // open_prs_onto on closed PR
            http(
                200,
                r#"{"data":{"repository":{"pullRequests":{"nodes":[]}}}}"#,
            ),
            http(200, &snapshot_json(&sha_snap, "CLOSED", true)),
            http(
                200,
                r#"{"data":{"repository":{"pullRequests":{"nodes":[]}}}}"#,
            ),
            // head_commit returns moved SHA!
            http(200, &format!(r#"{{"object":{{"sha":"{sha_moved}"}}}}"#)),
        ]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 0.0));
        let repo =
            ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", "ace").unwrap();
        let lc = GitHubLifecycle::new(&api, repo);
        let snap = lc.snapshot(9, None).await.unwrap();
        assert!(snap.actions.iter().any(|a| a == "branch.delete"));

        let err = lc
            .apply(
                9,
                &snap.version,
                &ForgeLifecycleAction::BranchDelete,
                "op-1",
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, Kind::HeadMoved);
        assert_eq!(err.dispatched, Some(false));
        assert!(
            !runner
                .seen
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.args.iter().any(|a| a == "DELETE"))
        );
    }

    #[tokio::test]
    async fn lifecycle_refuses_stale_version_before_mutation() {
        let sha_snap = "a".repeat(40);
        let runner = QueueRunner::new(vec![http(200, &snapshot_json(&sha_snap, "OPEN", true))]);
        let api = GhApi::new(&runner, "github.com", Arc::new(|| 0.0));
        let repo =
            ForgeRepository::validate(ForgeKind::Github, "github.com", "octo", "ace").unwrap();
        let lc = GitHubLifecycle::new(&api, repo);

        let err = lc
            .apply(
                9,
                "stale-version",
                &ForgeLifecycleAction::Close,
                "op-2",
                None,
                || true,
                Arc::new(MutationDispatch::default()),
            )
            .await
            .unwrap_err();
        assert_eq!(err.kind, Kind::Conflict);
        assert_eq!(err.dispatched, Some(false));
    }
}
