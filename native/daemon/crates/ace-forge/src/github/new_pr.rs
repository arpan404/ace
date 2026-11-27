// SPDX-License-Identifier: Apache-2.0
//! Pull request creation text rendering and pre-creation repository reads
//! (`pr-create-text.ts`, `github-new-pr.ts`).

use std::sync::Arc;

use ace_json::{Map, Value};
use serde::Serialize;

use crate::github::lifecycle_writes::{LifecycleMilestone, branch_path};
use crate::github::merge_state::is_sha;
use crate::pure::ForgeRepository;
use crate::transport::command::Cancellation;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http::GhApi;
use crate::transport::limits::ReadBudget;
use crate::transport::mutation::MutationDispatch;

const MAX_PAGES: usize = 10;
const FILE_PAGE_SIZE: usize = 25;

/// Template used by [`pr_create_text`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrCreateTemplate {
    pub title: String,
    pub body: String,
}

/// Input to [`pr_create_text`] (`ForgeCreatePrInput`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeCreatePrInput {
    pub expected_head: Option<String>,
    pub branch: String,
    pub base: Option<String>,
    pub title: String,
    pub summary: String,
    pub template: PrCreateTemplate,
    pub draft: bool,
}

/// Rendered pull request payload ready for host creation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderedPrCreate {
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub title: String,
    pub body: String,
}

/// Renders reviewed thread text once with identical validation across all hosts (`prCreateText`).
pub fn pr_create_text(
    thread_id: &str,
    input: &ForgeCreatePrInput,
) -> Result<RenderedPrCreate, ForgeError> {
    if let Some(ref head) = input.expected_head
        && !is_sha(head)
    {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let check_len = |s: &str, min: usize, max: usize| {
        let len = s.chars().count();
        len >= min && len <= max
    };
    if !check_len(thread_id, 1, 256)
        || !check_len(&input.branch, 1, 256)
        || !check_len(&input.title, 1, 256)
        || !check_len(&input.summary, 0, 65_536)
        || !check_len(&input.template.title, 1, 256)
        || !check_len(&input.template.body, 0, 65_536)
    {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    let Some(ref base) = input.base else {
        return Err(ForgeError::new(Kind::BaseMissing));
    };
    if !check_len(base, 1, 256) {
        return Err(ForgeError::new(Kind::InvalidData));
    }

    let render = |template: &str| -> Result<String, ForgeError> {
        let mut out = String::with_capacity(template.len());
        let bytes = template.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
                let start = i + 2;
                let mut end = start;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                {
                    end += 1;
                }
                if end > start
                    && end + 1 < bytes.len()
                    && bytes[end] == b'}'
                    && bytes[end + 1] == b'}'
                {
                    let key = &template[start..end];
                    let replacement = match key {
                        "threadId" => thread_id,
                        "branch" => input.branch.as_str(),
                        "title" => input.title.as_str(),
                        "summary" => input.summary.as_str(),
                        _ => return Err(ForgeError::new(Kind::InvalidData)),
                    };
                    out.push_str(replacement);
                    i = end + 2;
                    continue;
                }
            }
            if let Some(ch) = template[i..].chars().next() {
                out.push(ch);
                i += ch.len_utf8();
            } else {
                break;
            }
        }
        Ok(out)
    };

    let title = render(&input.template.title)?;
    let body = render(&input.template.body)?;
    if !check_len(&title, 1, 256) || !check_len(&body, 0, 65_536) {
        return Err(ForgeError::new(Kind::InvalidData));
    }
    Ok(RenderedPrCreate {
        branch: input.branch.clone(),
        base: base.clone(),
        draft: input.draft,
        title,
        body,
    })
}

/// Validates a git branch name per `ForgeBranchName`.
pub fn is_valid_branch_name(name: &str) -> bool {
    let len = name.chars().count();
    if len == 0 || len > 256 {
        return false;
    }
    if name.starts_with('/')
        || name.ends_with('/')
        || name.ends_with('.')
        || name.starts_with('-')
        || name.contains("..")
        || name.contains("//")
        || name.contains("@{")
        || name.contains('\\')
        || name == "@"
    {
        return false;
    }
    for byte in name.bytes() {
        if byte < 0x20
            || byte == 0x7f
            || matches!(byte, b' ' | b'~' | b'^' | b':' | b'?' | b'*' | b'[')
        {
            return false;
        }
    }
    !name
        .split('/')
        .any(|seg| seg.is_empty() || seg.starts_with('.') || seg.ends_with(".lock"))
}

pub fn is_valid_repo_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

fn is_valid_login(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn is_hex_color(color: &str) -> bool {
    color.len() == 6 && color.bytes().all(|b| b.is_ascii_hexdigit())
}

fn is_default_pr_template_name(filename: &str) -> bool {
    let lower = filename.to_ascii_lowercase();
    lower == "pull_request_template.md" || lower.ends_with("/pull_request_template.md")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeBranch {
    pub name: String,
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeLabelOption {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeAssignablePerson {
    pub login: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeRepoPrOptions {
    pub labels: Vec<ForgeLabelOption>,
    pub assignable: Vec<ForgeAssignablePerson>,
    pub milestones: Vec<LifecycleMilestone>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeCompareHead {
    pub owner: String,
    pub name: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgeCompare {
    pub base: String,
    pub head: ForgeCompareHead,
    pub status: String,
    pub ahead_by: u64,
    pub behind_by: u64,
    pub merge_base_sha: String,
    pub head_sha: String,
    pub commits: Vec<Value>,
    pub total_commits: u64,
    pub files: Vec<Value>,
    pub total_files: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_page: Option<usize>,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_pr: Option<u64>,
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

/// Pre-creation PR helper reads (`GitHubNewPr`).
pub struct GitHubNewPr<'a> {
    api: &'a GhApi<'a>,
    repository: ForgeRepository,
    root: String,
}

impl<'a> GitHubNewPr<'a> {
    pub fn new(api: &'a GhApi<'a>, repository: ForgeRepository) -> Self {
        let root = format!("repos/{}/{}", repository.owner, repository.name);
        Self {
            api,
            repository,
            root,
        }
    }

    async fn read_pages(
        &self,
        path: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<(Vec<Value>, bool), ForgeError> {
        let mut budget = ReadBudget::new();
        let mut items = Vec::new();
        let mut endpoint = Some(path.to_owned());
        for _ in 0..MAX_PAGES {
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
            let arr = page
                .body
                .as_array()
                .filter(|a| a.len() <= 100)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            items.extend(arr.iter().cloned());
            endpoint = self.api.next(&page, path)?;
        }
        Ok((items, endpoint.is_some()))
    }

    async fn fork_head(
        &self,
        head: &ForgeCompareHead,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<String, ForgeError> {
        let path = format!(
            "repos/{}/{}/git/ref/heads/{}",
            head.owner,
            head.name,
            branch_path(&head.branch)
        );
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
            Ok(page) => page
                .body
                .as_object()
                .and_then(|o| o.get("object"))
                .and_then(Value::as_object)
                .and_then(|o| o.get("sha"))
                .and_then(Value::as_str)
                .filter(|s| is_sha(s))
                .map(str::to_owned)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData)),
            Err(err) if err.kind == Kind::NotFound => Err(ForgeError::new(Kind::HeadMissing)),
            Err(err) => Err(err),
        }
    }

    pub async fn branches(
        &self,
        default_branch: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<(Vec<ForgeBranch>, bool), ForgeError> {
        let (items, truncated) = self
            .read_pages(
                &format!("{}/branches?per_page=100", self.root),
                cancellation,
            )
            .await?;
        let mut branches = Vec::with_capacity(items.len());
        for item in items {
            let obj = item
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.chars().count() <= 256)
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
                .to_owned();
            let sha = obj
                .get("commit")
                .and_then(Value::as_object)
                .and_then(|c| c.get("sha"))
                .and_then(Value::as_str)
                .filter(|s| is_sha(s))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
                .to_owned();
            branches.push(ForgeBranch { name, sha });
        }
        branches.sort_by(|a, b| {
            if a.name == default_branch {
                std::cmp::Ordering::Less
            } else if b.name == default_branch {
                std::cmp::Ordering::Greater
            } else {
                a.name.cmp(&b.name)
            }
        });
        Ok((branches, truncated))
    }

    pub async fn template(
        &self,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Option<String>, ForgeError> {
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
            Value::from(
                "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequestTemplates{filename body}}}",
            ),
        );
        body.insert(String::from("variables"), Value::Object(vars));
        let page = match self
            .api
            .request(
                "graphql",
                Some(Value::Object(body)),
                Some("POST"),
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await
        {
            Ok(p) => p,
            Err(err) if err.is_query_refused() => return Ok(None),
            Err(err) => return Err(err),
        };
        let list = match page
            .body
            .as_object()
            .and_then(|o| o.get("data"))
            .and_then(Value::as_object)
            .and_then(|d| d.get("repository"))
            .and_then(Value::as_object)
            .and_then(|r| r.get("pullRequestTemplates"))
        {
            Some(Value::Null) | None => return Ok(None),
            Some(Value::Array(arr)) if arr.len() <= 100 => arr,
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let mut valid: Vec<(String, String)> = Vec::new();
        for item in list {
            let obj = item
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let filename = bounded_text(obj.get("filename")).unwrap_or_default();
            if let Some(text) = bounded_text(obj.get("body"))
                && !text.trim().is_empty()
            {
                valid.push((filename, text));
            }
        }
        if let Some((_, body)) = valid.iter().find(|(f, _)| is_default_pr_template_name(f)) {
            return Ok(Some(body.clone()));
        }
        Ok((valid.len() == 1).then(|| valid.remove(0).1))
    }

    pub async fn milestones(
        &self,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<Vec<LifecycleMilestone>, ForgeError> {
        let page = self
            .api
            .request(
                &format!(
                    "{}/milestones?state=open&sort=due_on&direction=asc&per_page=100",
                    self.root
                ),
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let arr = page
            .body
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let mut out = Vec::with_capacity(arr.len());
        for item in arr {
            let obj = item
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let state = bounded_text(obj.get("state"))
                .filter(|s| s == "open" || s == "closed")
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let due_on = match obj.get("due_on") {
                Some(Value::Null) => None,
                other => {
                    Some(bounded_text(other).ok_or_else(|| ForgeError::new(Kind::InvalidData))?)
                }
            };
            out.push(LifecycleMilestone {
                number: pos_u64(obj.get("number"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                title: bounded_text(obj.get("title"))
                    .ok_or_else(|| ForgeError::new(Kind::InvalidData))?,
                state,
                due_on,
            });
        }
        Ok(out)
    }

    pub async fn options(
        &self,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<ForgeRepoPrOptions, ForgeError> {
        let (raw_labels, labels_trunc) = self
            .read_pages(
                &format!("{}/labels?per_page=100", self.root),
                cancellation.clone(),
            )
            .await?;
        let (raw_people, people_trunc) = self
            .read_pages(
                &format!("{}/assignees?per_page=100", self.root),
                cancellation.clone(),
            )
            .await?;
        let milestones = self.milestones(cancellation).await?;

        let labels_over = raw_labels.len() > 500;
        let people_over = raw_people.len() > 500;
        let mut labels = Vec::new();
        for item in raw_labels.into_iter().take(500) {
            let obj = item
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let name =
                bounded_text(obj.get("name")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let color = obj
                .get("color")
                .and_then(Value::as_str)
                .filter(|c| is_hex_color(c))
                .map(str::to_owned);
            let description = bounded_text(obj.get("description")).unwrap_or_default();
            labels.push(ForgeLabelOption {
                name,
                color,
                description,
            });
        }
        let mut assignable = Vec::new();
        for item in raw_people.into_iter().take(500) {
            let obj = item
                .as_object()
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
            let login = obj
                .get("login")
                .and_then(Value::as_str)
                .filter(|l| is_valid_login(l))
                .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
                .to_owned();
            let avatar_url = bounded_text(obj.get("avatar_url"));
            assignable.push(ForgeAssignablePerson { login, avatar_url });
        }
        Ok(ForgeRepoPrOptions {
            labels,
            assignable,
            milestones,
            truncated: labels_trunc || people_trunc || labels_over || people_over,
        })
    }

    pub async fn compare(
        &self,
        base: &str,
        head: &ForgeCompareHead,
        page: usize,
        cancellation: Option<Arc<Cancellation>>,
        pinned: Option<&str>,
    ) -> Result<ForgeCompare, ForgeError> {
        if !is_valid_login(&head.owner)
            || !is_valid_branch_name(base)
            || !is_valid_branch_name(&head.branch)
            || !is_valid_repo_name(&head.name)
            || pinned.is_some_and(|p| !is_sha(p))
            || page == 0
        {
            return Err(ForgeError::new(Kind::Unprocessable));
        }
        let same_owner = head.owner.to_lowercase() == self.repository.owner.to_lowercase();
        let same_name = head.name.to_lowercase() == self.repository.name.to_lowercase();
        let head_ref = if let Some(sha) = pinned {
            sha.to_owned()
        } else if same_owner && same_name {
            branch_path(&head.branch)
        } else if same_owner {
            self.fork_head(head, cancellation.clone()).await?
        } else {
            format!("{}:{}", head.owner, branch_path(&head.branch))
        };
        let response = self
            .api
            .request(
                &format!("{}/compare/{}...{head_ref}", self.root, branch_path(base)),
                None,
                None,
                cancellation,
                Arc::new(MutationDispatch::default()),
            )
            .await?;
        let obj = response
            .body
            .as_object()
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let status = bounded_text(obj.get("status"))
            .filter(|s| matches!(s.as_str(), "ahead" | "behind" | "diverged" | "identical"))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let ahead_by =
            nonneg_u64(obj.get("ahead_by")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let behind_by =
            nonneg_u64(obj.get("behind_by")).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let total_commits = nonneg_u64(obj.get("total_commits"))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let merge_base_sha = obj
            .get("merge_base_commit")
            .and_then(Value::as_object)
            .and_then(|c| c.get("sha"))
            .and_then(Value::as_str)
            .filter(|s| is_sha(s))
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .to_owned();
        let commits: Vec<Value> = obj
            .get("commits")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 250)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))?
            .iter()
            .cloned()
            .collect();
        let all_files: Vec<Value> = match obj.get("files") {
            None => Vec::new(),
            Some(Value::Array(arr)) if arr.len() <= 300 => arr.iter().cloned().collect(),
            _ => return Err(ForgeError::new(Kind::InvalidData)),
        };
        let head_sha = commits
            .last()
            .and_then(Value::as_object)
            .and_then(|c| c.get("sha"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| merge_base_sha.clone());
        let first = (page - 1).saturating_mul(FILE_PAGE_SIZE);
        let page_files: Vec<Value> = all_files
            .iter()
            .skip(first)
            .take(FILE_PAGE_SIZE)
            .cloned()
            .collect();
        let next_page = (first + FILE_PAGE_SIZE < all_files.len()).then_some(page + 1);
        Ok(ForgeCompare {
            base: base.to_owned(),
            head: head.clone(),
            status,
            ahead_by,
            behind_by,
            merge_base_sha,
            head_sha,
            total_commits,
            truncated: total_commits > commits.len() as u64 || all_files.len() >= 300,
            commits,
            total_files: all_files.len(),
            files: page_files,
            next_page,
            existing_pr: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pr_create_text_renders_known_placeholders_and_refuses_unknown_or_missing_base() {
        let input = ForgeCreatePrInput {
            expected_head: None,
            branch: "feat/x".into(),
            base: Some("main".into()),
            title: "Add feature".into(),
            summary: "Summary text".into(),
            template: PrCreateTemplate {
                title: "[{{branch}}] {{title}}".into(),
                body: "Thread {{threadId}}\n\n{{summary}}".into(),
            },
            draft: true,
        };
        let rendered = pr_create_text("t-1", &input).unwrap();
        assert_eq!(rendered.title, "[feat/x] Add feature");
        assert_eq!(rendered.body, "Thread t-1\n\nSummary text");
        assert!(rendered.draft);

        let missing_base = ForgeCreatePrInput {
            base: None,
            ..input.clone()
        };
        assert_eq!(
            pr_create_text("t-1", &missing_base).unwrap_err().kind,
            Kind::BaseMissing
        );

        let bad_key = ForgeCreatePrInput {
            template: PrCreateTemplate {
                title: "{{unknown}}".into(),
                body: String::new(),
            },
            ..input
        };
        assert_eq!(
            pr_create_text("t-1", &bad_key).unwrap_err().kind,
            Kind::InvalidData
        );
    }
}
