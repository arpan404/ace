// SPDX-License-Identifier: Apache-2.0
//! The PR-status mappings (`status.ts`): a pull's protocol status, its checks (current and
//! legacy) and the comments a review or issue carries. Every input is decoded by
//! [`crate::schema::github`] after redaction, so a failed decode is `invalid_data`.

use ace_json::Value;
use serde::Serialize;

use crate::schema::github::{
    Check, Comment, Kind, LegacyStatus, Pull, Review, parse_check, parse_comment,
    parse_legacy_status, parse_pull, parse_review,
};

/// A check's mapped state: what the panel and `ciStatus` read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pending,
    Success,
    Failure,
    Cancelled,
    Unknown,
}

impl CheckStatus {
    /// The protocol token.
    pub fn as_str(self) -> &'static str {
        match self {
            CheckStatus::Pending => "pending",
            CheckStatus::Success => "success",
            CheckStatus::Failure => "failure",
            CheckStatus::Cancelled => "cancelled",
            CheckStatus::Unknown => "unknown",
        }
    }
}

/// One check row (`ForgeCheck`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRow {
    pub id: String,
    pub name: String,
    pub status: CheckStatus,
    pub conclusion: Option<String>,
    pub completed_at: Option<String>,
    pub started_at: Option<String>,
    pub job_id: Option<i64>,
    pub url: Option<String>,
}

/// A comment row (review, issue or inline).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentRow {
    pub kind: &'static str,
    pub id: i64,
    pub body: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_avatar_url: Option<String>,
    pub file: Option<String>,
    pub line: Option<i64>,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub reply_to: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review_state: Option<String>,
}

/// The pull a status is asked about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub forge: String,
    pub host: String,
    pub owner: String,
    pub name: String,
    pub number: i64,
}

/// A pull's protocol status (`ForgePrStatus`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrStatus {
    pub r#ref: PrRef,
    pub title: String,
    pub url: String,
    pub head_sha: String,
    pub state: String,
    pub mergeability: String,
    pub ci: String,
    pub checks: Vec<CheckRow>,
    pub comments: Vec<CommentRow>,
    pub raw: Value,
}

/// Maps one check run; `details_url`/`html_url` supply the link, and an Actions job link
/// carries the job identifier a third-party check does not.
pub fn map_check(input: &Value) -> Result<CheckRow, Kind> {
    let check = parse_check(input)?;
    let status = check_status(&check);
    let url = check.details_url.clone().or_else(|| check.html_url.clone());
    let job_id = url.as_deref().and_then(job_from_url);
    Ok(CheckRow {
        id: format!("check:{}", check.id),
        name: check.name,
        status,
        conclusion: check.conclusion,
        completed_at: check.completed_at,
        started_at: check.started_at,
        job_id,
        url,
    })
}

fn check_status(check: &Check) -> CheckStatus {
    if check.status != "completed" {
        return match check.status.as_str() {
            "queued" | "in_progress" | "waiting" | "pending" | "requested" => CheckStatus::Pending,
            _ => CheckStatus::Unknown,
        };
    }
    match check.conclusion.as_deref() {
        Some("success" | "neutral" | "skipped") => CheckStatus::Success,
        Some("failure" | "timed_out" | "action_required" | "startup_failure" | "stale") => {
            CheckStatus::Failure
        }
        Some("cancelled") => CheckStatus::Cancelled,
        _ => CheckStatus::Unknown,
    }
}

/// `/actions/runs/<run>/job/<id>` or `/runs/<id>`, when the link names a positive job.
#[allow(clippy::expect_used)]
fn job_from_url(url: &str) -> Option<i64> {
    static JOB: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"/actions/runs/\d+/job/(\d+)(?:\?|$)").expect("compiles")
    });
    static RUN: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"/runs/(\d+)(?:\?|$)").expect("compiles"));
    let captures = JOB.captures(url).or_else(|| RUN.captures(url))?;
    captures
        .get(1)?
        .as_str()
        .parse::<i64>()
        .ok()
        .filter(|job| *job > 0)
}

/// Maps a legacy commit status (`mapLegacyStatus`).
pub fn map_legacy_status(input: &Value) -> Result<CheckRow, Kind> {
    let status: LegacyStatus = parse_legacy_status(input)?;
    let mapped = match status.state.as_str() {
        "pending" => CheckStatus::Pending,
        "success" => CheckStatus::Success,
        "failure" | "error" => CheckStatus::Failure,
        _ => CheckStatus::Unknown,
    };
    Ok(CheckRow {
        id: format!("status:{}", status.id),
        name: status.context,
        status: mapped,
        conclusion: Some(status.state),
        completed_at: Some(status.updated_at),
        started_at: None,
        job_id: None,
        url: status.target_url,
    })
}

/// The aggregate CI state: failure, then pending, then unknown, else success; none if empty.
pub fn ci_status(checks: &[CheckRow]) -> &'static str {
    if checks.is_empty() {
        return "none";
    }
    if checks
        .iter()
        .any(|check| matches!(check.status, CheckStatus::Failure | CheckStatus::Cancelled))
    {
        return "failure";
    }
    if checks
        .iter()
        .any(|check| check.status == CheckStatus::Pending)
    {
        return "pending";
    }
    if checks
        .iter()
        .any(|check| check.status == CheckStatus::Unknown)
    {
        return "unknown";
    }
    "success"
}

/// Maps an inline review comment (`mapComment`).
pub fn map_comment(input: &Value) -> Result<CommentRow, Kind> {
    let comment: Comment = parse_comment(input)?;
    Ok(CommentRow {
        kind: "inline",
        id: comment.id,
        body: comment.body,
        author: comment
            .user
            .as_ref()
            .map_or_else(|| String::from("ghost"), |user| user.login.clone()),
        author_avatar_url: comment.user.and_then(|user| user.avatar_url),
        file: comment.path,
        line: comment.line.or(comment.original_line),
        updated_at: comment.updated_at,
        created_at: comment.created_at,
        reply_to: comment.in_reply_to_id,
        review_state: None,
    })
}

/// Maps an issue comment (`mapIssueComment`).
pub fn map_issue_comment(input: &Value) -> Result<CommentRow, Kind> {
    Ok(CommentRow {
        kind: "issue",
        ..map_comment(input)?
    })
}

/// Maps a review (`mapReviewComment`): no file, no line, its state kept.
pub fn map_review_comment(input: &Value) -> Result<CommentRow, Kind> {
    let review: Review = parse_review(input)?;
    Ok(CommentRow {
        kind: "review",
        id: review.id,
        body: review.body.unwrap_or_default(),
        author: review
            .user
            .as_ref()
            .map_or_else(|| String::from("ghost"), |user| user.login.clone()),
        author_avatar_url: review.user.and_then(|user| user.avatar_url),
        file: None,
        line: None,
        updated_at: review.submitted_at.unwrap_or_default(),
        created_at: None,
        reply_to: None,
        review_state: Some(review.state),
    })
}

/// Maps a pull into its protocol status (`mapPr`): merged before closed before draft/open.
pub fn map_pr(reference: &PrRef, input: &Value, checks: &[CheckRow]) -> Result<PrStatus, Kind> {
    let pull: Pull = parse_pull(input)?;
    let state = if pull.merged == Some(true) || pull.merged_at.is_some() {
        "merged"
    } else if pull.state == "closed" {
        "closed"
    } else if pull.state == "open" {
        if pull.draft == Some(true) {
            "draft"
        } else {
            "open"
        }
    } else {
        "unknown"
    };
    let mergeability = match pull.mergeable {
        Some(true) => "mergeable",
        Some(false) => "conflicting",
        None => "unknown",
    };
    Ok(PrStatus {
        r#ref: reference.clone(),
        title: pull.title,
        url: pull.html_url,
        head_sha: pull.head_sha,
        state: String::from(state),
        mergeability: String::from(mergeability),
        ci: String::from(ci_status(checks)),
        checks: checks.to_vec(),
        comments: Vec::new(),
        raw: input.clone(),
    })
}

#[cfg(test)]
mod tests {
    use ace_json::json;

    use super::{
        CheckStatus, PrRef, ci_status, map_check, map_comment, map_issue_comment,
        map_legacy_status, map_pr, map_review_comment,
    };
    use crate::schema::github::Kind;

    fn check(status: &str, conclusion: Option<&str>) -> ace_json::Value {
        json!({
            "id": 11, "name": "test", "status": status, "conclusion": conclusion,
            "completed_at": "2026-10-02T10:00:07Z",
            "details_url": "https://github.com/octo/ace/actions/runs/42/job/99",
        })
    }

    fn reference() -> PrRef {
        PrRef {
            forge: String::from("github"),
            host: String::from("github.com"),
            owner: String::from("octo"),
            name: String::from("ace"),
            number: 7,
        }
    }

    fn pull(extra: ace_json::Value) -> ace_json::Value {
        let mut value = json!({
            "number": 7,
            "node_id": "PR_7",
            "title": "Handle empty input",
            "html_url": "https://github.com/octo/ace/pull/7",
            "state": "open",
            "draft": false,
            "head": { "sha": "0123456789abcdef0123456789abcdef01234567", "ref": "work/card" },
        });
        if let (Some(fields), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, entry) in extra.iter() {
                fields.insert(key.clone(), entry.clone());
            }
        }
        value
    }

    #[test]
    fn a_check_maps_pending_success_failure_and_cancelled_states() {
        assert_eq!(
            map_check(&check("in_progress", None)).unwrap().status,
            CheckStatus::Pending
        );
        assert_eq!(
            map_check(&check("completed", Some("neutral")))
                .unwrap()
                .status,
            CheckStatus::Success
        );
        assert_eq!(
            map_check(&check("completed", Some("timed_out")))
                .unwrap()
                .status,
            CheckStatus::Failure
        );
        assert_eq!(
            map_check(&check("completed", Some("cancelled")))
                .unwrap()
                .status,
            CheckStatus::Cancelled
        );
        assert_eq!(
            map_check(&check("completed", Some("other")))
                .unwrap()
                .status,
            CheckStatus::Unknown
        );
        let mapped = map_check(&check("completed", Some("failure"))).unwrap();
        assert_eq!(mapped.id, "check:11");
        assert_eq!(mapped.job_id, Some(99));
    }

    #[test]
    fn a_legacy_status_maps_its_state_and_keeps_the_context() {
        let mapped = map_legacy_status(&json!({
            "id": 3, "context": "deploy", "state": "error", "updated_at": "now", "target_url": null
        }))
        .unwrap();
        assert_eq!(mapped.name, "deploy");
        assert_eq!(mapped.status, CheckStatus::Failure);
        assert_eq!(mapped.conclusion.as_deref(), Some("error"));
        assert_eq!(mapped.id, "status:3");
    }

    #[test]
    fn ci_failure_beats_pending_beats_unknown_and_an_empty_list_is_none() {
        let success = map_check(&check("completed", Some("success"))).unwrap();
        let pending = map_check(&check("in_progress", None)).unwrap();
        let unknown = map_check(&check("completed", Some("other"))).unwrap();
        assert_eq!(ci_status(&[]), "none");
        assert_eq!(ci_status(std::slice::from_ref(&success)), "success");
        assert_eq!(ci_status(&[success.clone(), pending.clone()]), "pending");
        assert_eq!(ci_status(&[success.clone(), unknown.clone()]), "unknown");
        assert_eq!(ci_status(&[unknown, pending.clone()]), "pending");
        assert_eq!(ci_status(&[success, pending]), "pending");
    }

    #[test]
    fn a_draft_pull_is_draft_and_a_merged_one_is_merged() {
        let checks = Vec::new();
        assert_eq!(
            map_pr(&reference(), &pull(json!({})), &checks)
                .unwrap()
                .state,
            "open"
        );
        assert_eq!(
            map_pr(&reference(), &pull(json!({ "draft": true })), &checks)
                .unwrap()
                .state,
            "draft"
        );
        assert_eq!(
            map_pr(&reference(), &pull(json!({ "merged": true })), &checks)
                .unwrap()
                .state,
            "merged"
        );
        assert_eq!(
            map_pr(&reference(), &pull(json!({ "state": "closed" })), &checks)
                .unwrap()
                .state,
            "closed"
        );
        assert_eq!(
            map_pr(&reference(), &pull(json!({ "mergeable": false })), &checks)
                .unwrap()
                .mergeability,
            "conflicting"
        );
        assert_eq!(
            map_pr(&reference(), &pull(json!({ "mergeable": null })), &checks)
                .unwrap()
                .mergeability,
            "unknown"
        );
    }

    #[test]
    fn a_pull_status_keeps_the_redacted_raw_and_its_checks() {
        let checks = vec![map_check(&check("completed", Some("failure"))).unwrap()];
        let status = map_pr(
            &reference(),
            &pull(json!({ "extra": "ghp_secret1" })),
            &checks,
        )
        .unwrap();
        assert_eq!(status.ci, "failure");
        assert_eq!(status.checks.len(), 1);
        assert_eq!(status.raw["extra"], json!("ghp_secret1"));
    }

    #[test]
    fn comments_keep_their_kind_author_and_position() {
        let inline = map_comment(&json!({
            "id": 5,
            "body": "Handle empty input",
            "user": { "login": "octo", "avatar_url": "https://avatars/octo" },
            "path": "src/main.ts",
            "line": null,
            "original_line": 14,
            "updated_at": "2026-10-02T10:00:00Z",
            "in_reply_to_id": 4,
        }))
        .unwrap();
        assert_eq!(inline.kind, "inline");
        assert_eq!(inline.line, Some(14));
        assert_eq!(inline.reply_to, Some(4));
        assert_eq!(inline.author, "octo");
        let issue = map_issue_comment(&json!({
            "id": 6, "body": "x", "user": null, "updated_at": "now"
        }))
        .unwrap();
        assert_eq!(issue.kind, "issue");
        assert_eq!(issue.author, "ghost");
        let review = map_review_comment(&json!({
            "id": 9, "body": null, "state": "APPROVED", "user": null, "submitted_at": null
        }))
        .unwrap();
        assert_eq!(review.kind, "review");
        assert_eq!(review.review_state.as_deref(), Some("APPROVED"));
        assert_eq!(review.body, "");
    }

    #[test]
    fn a_malformed_check_is_invalid_data_not_a_decoder_error() {
        let error = map_check(&json!({ "id": "11" })).expect_err("invalid");
        assert_eq!(error, Kind::InvalidData);
    }
}
