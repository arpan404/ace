// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! GitHub's payload schemas (`github-schemas.ts`), mirrored field for field: loose objects,
//! the TypeScript's string bounds (code points, `docs/engine/porting-guide.md` rule 17), and
//! a failed decode is `invalid_data`, never a raw decoder error.

use ace_json::Value;
use regex::Regex;

pub use crate::transport::error::Kind;

/// The longest string a schema keeps (`z.string().max(65_536)`, code points).
pub const MAX_TEXT: usize = 65_536;
/// The most entries a page keeps.
pub const MAX_PAGE: usize = 100;

fn object(value: &Value) -> Option<&ace_json::Map> {
    value.as_object()
}

fn string_field(value: &Value, name: &str) -> Option<String> {
    value
        .as_object()?
        .get(name)
        .and_then(|field| field.as_str())
        .filter(|text| text.chars().count() <= MAX_TEXT)
        .map(str::to_owned)
}

fn required_string(value: &Value, name: &str) -> Result<String, Kind> {
    string_field(value, name).ok_or(Kind::InvalidData)
}

fn nullable_string(value: &Value, name: &str) -> Result<Option<String>, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        None | Some(Value::Null) => Ok(None),
        Some(field) => field
            .as_str()
            .filter(|text| text.chars().count() <= MAX_TEXT)
            .map(|text| Some(text.to_owned()))
            .ok_or(Kind::InvalidData),
    }
}

fn positive_int(value: &Value, name: &str) -> Result<i64, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        Some(Value::Number(number)) => number
            .as_i64()
            .filter(|number| *number > 0)
            .ok_or(Kind::InvalidData),
        _ => Err(Kind::InvalidData),
    }
}

fn optional_int(value: &Value, name: &str) -> Result<Option<i64>, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(number)) => number.as_i64().map(Some).ok_or(Kind::InvalidData),
        Some(_) => Err(Kind::InvalidData),
    }
}

fn optional_bool(value: &Value, name: &str) -> Result<Option<bool>, Kind> {
    // `z.boolean().optional()`: absent is fine, null is not.
    match value.as_object().and_then(|fields| fields.get(name)) {
        None => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(Kind::InvalidData),
    }
}

/// `z.boolean().nullable().optional()`: absent and null both read as unknown.
fn nullable_bool(value: &Value, name: &str) -> Result<Option<bool>, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(flag)) => Ok(Some(*flag)),
        Some(_) => Err(Kind::InvalidData),
    }
}

/// `str.nullable()`: the key must be present, and its value a string or null.
fn required_nullable(value: &Value, name: &str) -> Result<Option<String>, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        None => Err(Kind::InvalidData),
        Some(Value::Null) => Ok(None),
        Some(field) => field
            .as_str()
            .filter(|text| text.chars().count() <= MAX_TEXT)
            .map(|text| Some(text.to_owned()))
            .ok_or(Kind::InvalidData),
    }
}

/// `str.optional()`: absent is fine; present must be a short string.
fn optional_string(value: &Value, name: &str) -> Result<Option<String>, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        None => Ok(None),
        Some(field) => field
            .as_str()
            .filter(|text| text.chars().count() <= MAX_TEXT)
            .map(|text| Some(text.to_owned()))
            .ok_or(Kind::InvalidData),
    }
}

/// `str.nullish().catch(undefined)`: any non-string reads as absent.
fn catch_string(value: &Value, name: &str) -> Option<String> {
    value
        .as_object()
        .and_then(|fields| fields.get(name))
        .and_then(|field| field.as_str())
        .filter(|text| text.chars().count() <= MAX_TEXT)
        .map(str::to_owned)
}

/// A commit id the schemas accept: 40 to 64 hexadecimal characters.
fn sha_of(text: &str) -> bool {
    static SHA: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[a-fA-F0-9]{40,64}$").expect("the SHA pattern compiles")
    });
    SHA.is_match(text)
}

/// One author (`user`/`author`: a loose object with a login).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Author {
    pub login: String,
    pub avatar_url: Option<String>,
}

fn parse_author(value: &Value, name: &str) -> Result<Option<Author>, Kind> {
    match value.as_object().and_then(|fields| fields.get(name)) {
        None | Some(Value::Null) => Ok(None),
        Some(author) => Ok(Some(Author {
            login: string_field(author, "login").ok_or(Kind::InvalidData)?,
            avatar_url: nullable_string(author, "avatar_url")?,
        })),
    }
}

/// A pull request (`GitHubPr`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pull {
    pub number: i64,
    pub node_id: String,
    pub title: String,
    pub html_url: String,
    pub state: String,
    pub draft: Option<bool>,
    pub merged: Option<bool>,
    pub merged_at: Option<String>,
    pub mergeable: Option<bool>,
    pub head_sha: String,
    pub head_ref: String,
}

/// Decodes `GitHubPr`; `raw` stays the redacted input the caller already holds.
pub fn parse_pull(value: &Value) -> Result<Pull, Kind> {
    let head = value
        .as_object()
        .and_then(|fields| fields.get("head"))
        .filter(|head| object(head).is_some())
        .ok_or(Kind::InvalidData)?;
    let head_sha = required_string(head, "sha")?;
    if !sha_of(&head_sha) {
        return Err(Kind::InvalidData);
    }
    Ok(Pull {
        number: positive_int(value, "number")?,
        node_id: required_string(value, "node_id")?,
        title: required_string(value, "title")?,
        html_url: required_string(value, "html_url")?,
        state: required_string(value, "state")?,
        draft: optional_bool(value, "draft")?,
        merged: optional_bool(value, "merged")?,
        merged_at: nullable_string(value, "merged_at")?,
        mergeable: nullable_bool(value, "mergeable")?,
        head_sha,
        head_ref: required_string(head, "ref")?,
    })
}

/// A check run (`GitHubCheck`); `started_at` reads a null or missing value as absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub id: i64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub completed_at: Option<String>,
    pub started_at: Option<String>,
    pub details_url: Option<String>,
    pub html_url: Option<String>,
}

/// Decodes `GitHubCheck`.
pub fn parse_check(value: &Value) -> Result<Check, Kind> {
    Ok(Check {
        id: positive_int(value, "id")?,
        name: required_string(value, "name")?,
        status: required_string(value, "status")?,
        conclusion: required_nullable(value, "conclusion")?,
        completed_at: required_nullable(value, "completed_at")?,
        started_at: catch_string(value, "started_at"),
        details_url: nullable_string(value, "details_url")?,
        html_url: nullable_string(value, "html_url")?,
    })
}

/// A legacy commit status (`GitHubStatus`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyStatus {
    pub id: i64,
    pub context: String,
    pub state: String,
    pub updated_at: String,
    pub target_url: Option<String>,
}

/// Decodes `GitHubStatus`.
pub fn parse_legacy_status(value: &Value) -> Result<LegacyStatus, Kind> {
    Ok(LegacyStatus {
        id: positive_int(value, "id")?,
        context: required_string(value, "context")?,
        state: required_string(value, "state")?,
        updated_at: required_string(value, "updated_at")?,
        target_url: required_nullable(value, "target_url")?,
    })
}

/// A review or issue comment (`GitHubComment`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    pub id: i64,
    pub body: String,
    pub user: Option<Author>,
    pub path: Option<String>,
    pub line: Option<i64>,
    pub original_line: Option<i64>,
    pub updated_at: String,
    pub created_at: Option<String>,
    pub in_reply_to_id: Option<i64>,
}

/// Decodes `GitHubComment`.
pub fn parse_comment(value: &Value) -> Result<Comment, Kind> {
    let in_reply_to_id = optional_int(value, "in_reply_to_id")?;
    if in_reply_to_id.is_some_and(|id| id <= 0) {
        return Err(Kind::InvalidData);
    }
    Ok(Comment {
        id: positive_int(value, "id")?,
        body: required_string(value, "body")?,
        user: parse_author(value, "user")?,
        path: optional_string(value, "path")?,
        line: optional_int(value, "line")?,
        original_line: optional_int(value, "original_line")?,
        updated_at: required_string(value, "updated_at")?,
        created_at: optional_string(value, "created_at")?,
        in_reply_to_id,
    })
}

/// A review (`GitHubReview`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub id: i64,
    pub body: Option<String>,
    pub state: String,
    pub user: Option<Author>,
    pub submitted_at: Option<String>,
}

/// Decodes `GitHubReview`.
pub fn parse_review(value: &Value) -> Result<Review, Kind> {
    let state = required_string(value, "state")?;
    if state.chars().count() > 256 {
        return Err(Kind::InvalidData);
    }
    Ok(Review {
        id: positive_int(value, "id")?,
        body: nullable_string(value, "body")?,
        state,
        user: parse_author(value, "user")?,
        submitted_at: nullable_string(value, "submitted_at")?,
    })
}

/// `CheckPage`: at most 100 checks from `check_runs`.
pub fn parse_check_page(value: &Value) -> Result<Vec<Check>, Kind> {
    let runs = value
        .as_object()
        .and_then(|fields| fields.get("check_runs"))
        .filter(|runs| runs.as_array().is_some())
        .ok_or(Kind::InvalidData)?;
    page(runs, parse_check)
}

/// One page of up to 100 entries decoded with `decode`.
pub fn page<T>(value: &Value, decode: impl Fn(&Value) -> Result<T, Kind>) -> Result<Vec<T>, Kind> {
    let items = value.as_array().ok_or(Kind::InvalidData)?;
    if items.len() > MAX_PAGE {
        return Err(Kind::InvalidData);
    }
    items.iter().map(decode).collect()
}

#[cfg(test)]
mod tests {
    use ace_json::json;

    use super::{
        Kind, MAX_PAGE, page, parse_check, parse_check_page, parse_comment, parse_legacy_status,
        parse_pull, parse_review,
    };

    fn pull() -> ace_json::Value {
        json!({
            "number": 7,
            "node_id": "PR_7",
            "title": "Handle empty input",
            "html_url": "https://github.com/octo/ace/pull/7",
            "state": "open",
            "draft": false,
            "head": { "sha": "0123456789abcdef0123456789abcdef01234567", "ref": "work/card" },
            "future_field": { "useful": true },
        })
    }

    #[test]
    fn a_pull_keeps_the_fields_the_reader_uses_and_ignores_unknown_ones() {
        let parsed = parse_pull(&pull()).expect("a pull");
        assert_eq!(parsed.number, 7);
        assert_eq!(parsed.head_ref, "work/card");
        assert_eq!(parsed.draft, Some(false));
        assert_eq!(parsed.mergeable, None);
    }

    #[test]
    fn a_pull_with_a_bad_head_sha_or_a_string_number_is_invalid_data() {
        let mut bad = pull();
        if let Some(fields) = bad.as_object_mut() {
            fields.insert(
                String::from("head"),
                json!({ "sha": "not-a-sha", "ref": "work" }),
            );
        }
        assert_eq!(parse_pull(&bad), Err(Kind::InvalidData));
        let mut number = pull();
        if let Some(fields) = number.as_object_mut() {
            fields.insert(String::from("number"), ace_json::Value::from("7"));
        }
        assert_eq!(parse_pull(&number), Err(Kind::InvalidData));
    }

    #[test]
    fn a_check_reads_null_timestamps_as_absent_and_requires_a_positive_id() {
        let check = parse_check(&json!({
            "id": 11,
            "name": "test",
            "status": "completed",
            "conclusion": "failure",
            "completed_at": "2026-10-02T10:00:07Z",
            "started_at": null,
            "details_url": "https://github.com/octo/ace/actions/runs/42/job/99",
        }))
        .expect("a check");
        assert_eq!(check.started_at, None);
        assert_eq!(check.conclusion.as_deref(), Some("failure"));
        let invalid = parse_check(
            &json!({ "id": 0, "name": "x", "status": "queued", "conclusion": null, "completed_at": null }),
        );
        assert_eq!(invalid, Err(Kind::InvalidData));
    }

    #[test]
    fn a_check_page_carries_at_most_a_hundred_checks() {
        let runs: Vec<ace_json::Value> = (1..=MAX_PAGE as i64)
            .map(|id| json!({ "id": id, "name": "x", "status": "queued", "conclusion": null, "completed_at": null }))
            .collect();
        let page_value = json!({ "check_runs": runs });
        assert_eq!(
            parse_check_page(&page_value).map(|checks| checks.len()),
            Ok(MAX_PAGE)
        );
        let too_many =
            json!({ "check_runs": (0..=MAX_PAGE).map(|_| json!({})).collect::<Vec<_>>() });
        assert_eq!(parse_check_page(&too_many), Err(Kind::InvalidData));
    }

    #[test]
    fn a_legacy_status_and_a_comment_decode_their_own_shapes() {
        let status = parse_legacy_status(&json!({
            "id": 3, "context": "deploy", "state": "error", "updated_at": "now", "target_url": null
        }))
        .expect("a status");
        assert_eq!(status.state, "error");
        let comment = parse_comment(&json!({
            "id": 5,
            "body": "Handle empty input",
            "user": { "login": "octo", "avatar_url": "https://avatars/octo" },
            "path": "src/main.ts",
            "line": 12,
            "updated_at": "2026-10-02T10:00:00Z",
            "in_reply_to_id": 4,
        }))
        .expect("a comment");
        assert_eq!(
            comment.user.map(|user| user.login),
            Some(String::from("octo"))
        );
        assert_eq!(comment.line, Some(12));
    }

    #[test]
    fn a_review_without_a_body_or_user_still_decodes() {
        let review = parse_review(&json!({
            "id": 9, "body": null, "state": "APPROVED", "user": null
        }))
        .expect("a review");
        assert_eq!(review.body, None);
        assert_eq!(review.user, None);
    }

    #[test]
    fn a_page_refuses_more_entries_than_the_schema_keeps() {
        let values: Vec<ace_json::Value> = (0..=MAX_PAGE).map(|_| json!(1)).collect();
        let value = ace_json::Value::Array(values.into());
        assert_eq!(
            page(&value, |item| Ok(item.clone())),
            Err(Kind::InvalidData)
        );
    }
}
