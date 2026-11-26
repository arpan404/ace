// SPDX-License-Identifier: Apache-2.0
//! GitHub polling decisions, ported from `packages/automations/src/github.ts` and
//! `gh-response.ts`: endpoints, page state and ETags, the baseline poll, per-event filters and
//! deduplication, the 20-page and 2,000-event bounds, and `gh`'s `--include` response. `gh`
//! itself is an injected client; the daemon runs it through `ace-supervisor`.

use std::collections::{BTreeMap, HashMap, HashSet};

use ace_json::Value;
use serde::{Deserialize, Serialize};

use crate::error::{AutomationsError, Result};

/// The GitHub trigger fields A1 polls with (`AutomationTrigger`'s third option).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubTrigger {
    pub repository: String,
    pub event: String,
    pub label: Option<String>,
    pub pull_request: Option<i64>,
    pub poll_interval_ms: i64,
}

#[derive(Debug, Clone, Deserialize)]
struct Label {
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PrNumber {
    number: i64,
}

/// Presence of a field, whatever its value (`pull_request: null` still means a PR,
/// `github.ts:60`).
#[derive(Debug, Clone, Copy)]
struct Present;

impl<'de> Deserialize<'de> for Present {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Present, D::Error> {
        let _ = serde::de::IgnoredAny::deserialize(deserializer)?;
        Ok(Present)
    }
}

/// `Option<Present>` would treat `null` as absent; this keeps presence (`github.ts:60`).
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Present>, D::Error> {
    Present::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Deserialize)]
struct Resource {
    id: i64,
    updated_at: String,
    html_url: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    labels: Option<Vec<Label>>,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default, deserialize_with = "present")]
    pull_request: Option<Present>,
    #[serde(default)]
    pull_requests: Option<Vec<PrNumber>>,
    #[serde(default)]
    pull_request_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubEntry {
    pub id: String,
    pub version: String,
    pub labels: Vec<String>,
    pub variables: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubPage {
    pub endpoint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next: Option<String>,
    pub entries: Vec<GithubEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GithubState {
    pub pages: Vec<GithubPage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubEvent {
    pub key: String,
    pub variables: BTreeMap<String, String>,
}

/// What one `gh api` call answered.
#[derive(Debug, Clone)]
pub struct GhResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub next: Option<String>,
    pub data: Option<Value>,
}

/// The daemon's `gh` boundary (`gh-process.ts:18`), run through `ace-supervisor` in production
/// and by fakes in tests.
pub trait GhClient {
    fn get(&self, endpoint: &str, etag: Option<&str>) -> Result<GhResponse>;
}

pub fn endpoint(trigger: &GithubTrigger) -> String {
    let base = format!("repos/{}", trigger.repository);
    match trigger.event.as_str() {
        "pr_changed" => format!("{base}/pulls?state=all&sort=updated&direction=desc&per_page=100"),
        "ci_failed" => format!("{base}/actions/runs?status=failure&per_page=100"),
        "review_comment" => {
            format!("{base}/pulls/comments?sort=updated&direction=desc&per_page=100")
        }
        _ => format!("{base}/issues?state=all&sort=updated&direction=desc&per_page=100"),
    }
}

fn slice_utf16(text: &str, limit: usize) -> String {
    if text.encode_utf16().count() <= limit {
        return text.to_owned();
    }
    let mut units = 0usize;
    let mut out = String::new();
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > limit {
            break;
        }
        units += width;
        out.push(character);
    }
    out
}

fn entries(data: &Value, trigger: &GithubTrigger) -> Result<Vec<GithubEntry>> {
    let items = if trigger.event == "ci_failed" {
        data.as_object()
            .and_then(|object| object.get("workflow_runs"))
            .and_then(Value::as_array)
    } else {
        data.as_array()
    };
    if items.is_some_and(|items| {
        items.iter().any(|item| {
            item.as_object()
                .and_then(|object| object.get("id"))
                .and_then(Value::as_i64)
                .is_none_or(|id| id <= 0)
        })
    }) {
        return Err(AutomationsError::message("Invalid GitHub resource: \"id\""));
    }
    let resources: Vec<Resource> = if trigger.event == "ci_failed" {
        let workflow: WorkflowRuns = ace_json::from_value(data)
            .map_err(|error| AutomationsError::message(error.to_string()))?;
        workflow.workflow_runs
    } else {
        ace_json::from_value(data).map_err(|error| AutomationsError::message(error.to_string()))?
    };
    if resources.len() > 100 {
        return Err(AutomationsError::message("Invalid GitHub resource"));
    }
    let mut entries = Vec::new();
    for resource in resources {
        let bounded = resource.updated_at.chars().count() <= 128
            && resource.html_url.chars().count() <= 2048
            && resource
                .title
                .as_ref()
                .is_none_or(|title| title.chars().count() <= 8192)
            && resource
                .body
                .as_ref()
                .is_none_or(|body| body.chars().count() <= 8192)
            && resource.number.is_none_or(|number| number > 0)
            && resource.labels.as_ref().is_none_or(|labels| {
                labels.len() <= 100 && labels.iter().all(|label| label.name.chars().count() <= 256)
            })
            && resource
                .pull_requests
                .as_ref()
                .is_none_or(|pulls| pulls.len() <= 100 && pulls.iter().all(|pull| pull.number > 0))
            && resource
                .pull_request_url
                .as_ref()
                .is_none_or(|url| url.chars().count() <= 2048)
            && resource
                .conclusion
                .as_ref()
                .is_none_or(|value| value.chars().count() <= 128);
        if resource.id <= 0 || !bounded {
            return Err(AutomationsError::message("Invalid GitHub resource"));
        }
        if trigger.event == "issue_labelled" && resource.pull_request.is_some() {
            continue;
        }
        if trigger.event == "ci_failed" && resource.conclusion.as_deref() != Some("failure") {
            continue;
        }
        if let Some(pull) = trigger.pull_request {
            let keep = match trigger.event.as_str() {
                "ci_failed" => resource
                    .pull_requests
                    .as_ref()
                    .is_some_and(|pulls| pulls.iter().any(|entry| entry.number == pull)),
                "review_comment" => resource
                    .pull_request_url
                    .as_deref()
                    .is_some_and(|url| url.ends_with(&format!("/{pull}"))),
                _ => resource.number == Some(pull),
            };
            if !keep {
                continue;
            }
        }
        let mut variables = BTreeMap::new();
        variables.insert("repository".to_owned(), trigger.repository.clone());
        variables.insert("url".to_owned(), resource.html_url.clone());
        variables.insert(
            "number".to_owned(),
            (resource.number.unwrap_or(resource.id)).to_string(),
        );
        variables.insert(
            "title".to_owned(),
            resource.title.clone().unwrap_or_default(),
        );
        variables.insert(
            "body".to_owned(),
            slice_utf16(resource.body.as_deref().unwrap_or(""), 8192),
        );
        if trigger.event == "ci_failed" {
            let pulls = resource
                .pull_requests
                .as_ref()
                .map(|pulls| {
                    pulls
                        .iter()
                        .map(|pull| pull.number.to_string())
                        .collect::<Vec<_>>()
                        .join(",")
                })
                .unwrap_or_default();
            variables.insert("pull_requests".to_owned(), pulls);
        }
        entries.push(GithubEntry {
            id: resource.id.to_string(),
            version: resource.updated_at.clone(),
            labels: resource
                .labels
                .as_ref()
                .map(|labels| labels.iter().map(|label| label.name.clone()).collect())
                .unwrap_or_default(),
            variables,
        });
    }
    Ok(entries)
}

#[derive(Debug, Clone, Deserialize)]
struct WorkflowRuns {
    workflow_runs: Vec<Resource>,
}

/// `githubEvents`: events for resources new or changed since `previous`; none on a baseline.
pub fn github_events(
    trigger: &GithubTrigger,
    previous: Option<&GithubState>,
    current: &GithubState,
) -> Result<Vec<GithubEvent>> {
    let Some(previous) = previous else {
        return Ok(Vec::new());
    };
    let old: HashMap<&str, &GithubEntry> = previous
        .pages
        .iter()
        .flat_map(|page| page.entries.iter().map(|entry| (entry.id.as_str(), entry)))
        .collect();
    let mut seen = HashSet::new();
    let mut events = Vec::new();
    for entry in current.pages.iter().flat_map(|page| page.entries.iter()) {
        if !seen.insert(entry.id.as_str()) {
            continue;
        }
        let before = old.get(entry.id.as_str());
        if before.is_some_and(|before| before.version == entry.version) {
            continue;
        }
        if trigger.event == "issue_labelled" {
            let labels: HashSet<&str> = before
                .map(|before| before.labels.iter().map(String::as_str).collect())
                .unwrap_or_default();
            for label in &entry.labels {
                if labels.contains(label.as_str())
                    || trigger.label.as_ref().is_some_and(|wanted| wanted != label)
                {
                    continue;
                }
                if events.len() >= 2000 {
                    return Err(AutomationsError::message(
                        "GitHub event batch exceeds limit",
                    ));
                }
                let mut variables = entry.variables.clone();
                variables.insert("label".to_owned(), label.clone());
                events.push(GithubEvent {
                    key: format!(
                        "github:{}:{}:{}:{}",
                        trigger.event, entry.id, entry.version, label
                    ),
                    variables,
                });
            }
        } else {
            if events.len() >= 2000 {
                return Err(AutomationsError::message(
                    "GitHub event batch exceeds limit",
                ));
            }
            events.push(GithubEvent {
                key: format!("github:{}:{}:{}", trigger.event, entry.id, entry.version),
                variables: entry.variables.clone(),
            });
        }
    }
    Ok(events)
}

#[derive(Debug, Clone)]
pub struct GithubPoll {
    pub state: GithubState,
    pub events: Vec<GithubEvent>,
    pub changed: bool,
}

/// `pollGithub`: every page through conditional GETs, bounded to 20 pages and one repository.
pub fn poll_github(
    client: &dyn GhClient,
    trigger: &GithubTrigger,
    state: &Value,
) -> Result<GithubPoll> {
    // `GithubState.safeParse`: a cursor this build cannot read is a fresh baseline
    // (`github.ts:133`), and more than 20 pages is not a state this build wrote.
    let previous: Option<GithubState> = state
        .as_object()
        .is_some_and(|object| object.contains_key("pages"))
        .then(|| ace_json::from_value::<GithubState>(state).ok())
        .flatten()
        .filter(|state| state.pages.len() <= 20);
    let old = previous.as_ref();
    let mut pages = Vec::new();
    let mut changed = false;
    let mut next = Some(endpoint(trigger));
    let allowed = format!("repos/{}/", trigger.repository);
    while let Some(current) = next {
        if pages.len() >= 20
            || pages
                .iter()
                .any(|page: &GithubPage| page.endpoint == current)
        {
            return Err(AutomationsError::message(
                "GitHub pagination exceeds bounded window",
            ));
        }
        if !current.starts_with(&allowed) {
            return Err(AutomationsError::message(
                "GitHub pagination escaped repository",
            ));
        }
        let prior = old.and_then(|old| old.pages.iter().find(|page| page.endpoint == current));
        let response = client.get(&current, prior.and_then(|page| page.etag.as_deref()))?;
        if response.status == 304 {
            let Some(prior) = prior else {
                return Err(AutomationsError::message("304 without a cached page"));
            };
            pages.push(prior.clone());
            next = prior.next.clone();
        } else {
            changed = true;
            if response.status != 200 {
                return Err(AutomationsError::message(
                    "Unexpected GitHub response status",
                ));
            }
            let data = response
                .data
                .as_ref()
                .ok_or_else(|| AutomationsError::message("Unexpected GitHub response status"))?;
            let page = GithubPage {
                endpoint: current,
                etag: response.etag,
                next: response.next,
                entries: entries(data, trigger)?,
            };
            next = page.next.clone();
            pages.push(page);
        }
    }
    if !changed && old.is_some() {
        return Ok(GithubPoll {
            state: old.cloned().unwrap_or(GithubState { pages }),
            events: Vec::new(),
            changed: false,
        });
    }
    let current = GithubState { pages };
    let events = github_events(trigger, old, &current)?;
    Ok(GithubPoll {
        state: current,
        events,
        changed: true,
    })
}

/// `gh-response.ts`: one `--include` response. Header/body split, status, ETag, and the next
/// page's path when its Link points at api.github.com.
pub fn parse_gh_response(output: &[u8], code: Option<i32>) -> Result<GhResponse> {
    let text = String::from_utf8_lossy(output);
    let boundary = text
        .find("\r\n\r\n")
        .map(|index| (index, 4))
        .or_else(|| text.find("\n\n").map(|index| (index, 2)))
        .ok_or_else(|| AutomationsError::message("Missing gh response headers"))?;
    let (header, body) = (&text[..boundary.0], &text[boundary.0 + boundary.1..]);
    let status: Option<u16> = header.lines().find_map(|line| {
        let rest = line.strip_prefix("HTTP/")?;
        let value = rest.split_whitespace().nth(1)?;
        (value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.parse().ok())
            .flatten()
    });
    let status =
        status.ok_or_else(|| AutomationsError::message("gh GET failed with status NaN"))?;
    if status != 304 && (code != Some(0) || status != 200) {
        return Err(AutomationsError::message(format!(
            "gh GET failed with status {status}"
        )));
    }
    let mut etag = None;
    let mut next = None;
    for line in header.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "etag" {
            if etag.is_none() {
                etag = Some(value.to_owned());
            }
        } else if name == "link" {
            let url = value
                .split(',')
                .find(|part| part.contains("rel=\"next\""))
                .and_then(|part| {
                    part.split_once('<')
                        .and_then(|(_, rest)| rest.split_once('>'))
                })
                .map(|(url, _)| url);
            if let Some(url) = url {
                let path = url
                    .strip_prefix("https://api.github.com/")
                    .ok_or_else(|| AutomationsError::message("Untrusted pagination URL"))?;
                next = Some(path.to_owned());
            }
        }
    }
    let data = if status == 304 {
        None
    } else {
        Some(ace_json::parse(body).map_err(|error| AutomationsError::message(error.to_string()))?)
    };
    Ok(GhResponse {
        status,
        etag,
        next,
        data,
    })
}

/// `createGhClient`'s request check: a canonical `repos/...` endpoint and a header-safe ETag.
pub fn validate_request(endpoint: &str, etag: Option<&str>) -> Result<()> {
    if endpoint.len() > 1024 {
        return Err(AutomationsError::message("Invalid GitHub endpoint"));
    }
    let (path, _query) = endpoint.split_once('?').unwrap_or((endpoint, ""));
    let mut segments = path.split('/');
    if segments.next() != Some("repos") {
        return Err(AutomationsError::message("Invalid GitHub endpoint"));
    }
    let repository = segments.next().unwrap_or("");
    let name = segments.next().unwrap_or("");
    let repo_part = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
    };
    if !repo_part(repository) || !repo_part(name) || segments.next().is_none() {
        return Err(AutomationsError::message("Invalid GitHub endpoint"));
    }
    let rest = &path["repos/".len() + repository.len() + 1 + name.len()..];
    if rest.starts_with('/') && rest.len() == 1 {
        return Err(AutomationsError::message("Invalid GitHub endpoint"));
    }
    if rest
        .split('/')
        .any(|segment| segment == "." || segment == "..")
        || endpoint.contains("//")
    {
        return Err(AutomationsError::message("Invalid GitHub endpoint"));
    }
    if let Some(etag) = etag
        && (etag.len() > 512 || etag.contains('\r') || etag.contains('\n'))
    {
        return Err(AutomationsError::message("Invalid ETag"));
    }
    Ok(())
}

/// The `gh api` arguments one request uses, including the conditional header.
pub fn gh_arguments(endpoint: &str, etag: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "api".to_owned(),
        "--hostname".to_owned(),
        "github.com".to_owned(),
        "--method".to_owned(),
        "GET".to_owned(),
        "--include".to_owned(),
        endpoint.to_owned(),
        "-H".to_owned(),
        "Accept: application/vnd.github+json".to_owned(),
    ];
    if let Some(etag) = etag {
        args.push("-H".to_owned());
        args.push(format!("If-None-Match: {etag}"));
    }
    args
}
