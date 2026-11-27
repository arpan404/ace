// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! HTTP envelope parsing, GraphQL error classification, 422 unprocessable mapping, Link URL
//! validation and GitHub's `merge-async` acknowledgement decoding (`http-errors.ts`,
//! `github-stack-operation.ts`, and `http.ts`'s pure helpers).

use ace_json::Value;
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::transport::command::CommandResult;
use crate::transport::error::{ForgeError, Kind};
use crate::transport::mutation::MutationDispatch;

/// A decoded GitHub `merge-async` stack operation (`ForgeStackOperation`).
#[derive(Debug, Clone, PartialEq)]
pub struct StackMergeOperation {
    pub action: &'static str,
    pub state: String,
    pub message: String,
    pub uuid: Option<String>,
    pub raw: Value,
}

/// Decodes GitHub's native stack merge operation (`decodeStackMergeOperation`).
/// Unknown states remain observable as `"uncertain"` with raw data preserved; `"pending"`
/// requires a validated UUID.
pub fn decode_stack_merge_operation(body: &Value) -> Option<StackMergeOperation> {
    let fields = body.as_object()?;
    let status_text = fields.get("status")?.as_str()?;
    if status_text.chars().count() > 65_536 {
        return None;
    }
    let details = fields.get("details")?.as_object()?;
    let message = details.get("message")?.as_str()?;
    if message.chars().count() > 65_536 {
        return None;
    }
    let uuid = match details.get("uuid") {
        None => None,
        Some(uuid) => {
            let uuid = uuid.as_str()?;
            if !is_uuid(uuid) {
                return None;
            }
            Some(uuid.to_owned())
        }
    };
    if status_text == "pending" && uuid.is_none() {
        return None;
    }
    let state = match status_text {
        "pending" | "merged" | "enqueued" | "failed" => status_text.to_owned(),
        _ => String::from("uncertain"),
    };
    Some(StackMergeOperation {
        action: "merge",
        state,
        message: message.to_owned(),
        uuid,
        raw: body.clone(),
    })
}

/// `repos/<owner>/<name>/pulls/<n>/merge`.
pub(crate) fn merge_path(path: &str) -> bool {
    static MERGE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^repos/[\w.-]+/[\w.-]+/pulls/[1-9]\d*/merge$").expect("compiles")
    });
    MERGE.is_match(path)
}

/// `repos/<owner>/<name>/pulls/<n>/merge-async`.
pub(crate) fn merge_async_path(path: &str) -> bool {
    static MERGE_ASYNC: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^repos/[\w.-]+/[\w.-]+/pulls/[1-9]\d*/merge-async$").expect("compiles")
    });
    MERGE_ASYNC.is_match(path)
}

pub(crate) fn is_uuid(text: &str) -> bool {
    static UUID: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
            .expect("compiles")
    });
    UUID.is_match(text)
}

/// `https://<host><pathname><search>`, refusing userinfo and other schemes.
pub(crate) fn parse_link_url(url: &str) -> Option<(String, String, String)> {
    let rest = url.strip_prefix("https://")?;
    let (authority, pathquery) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if authority.contains('@') || authority.is_empty() {
        return None;
    }
    let (pathname, search) = match pathquery.find('?') {
        Some(index) => (&pathquery[..index], &pathquery[index..]),
        None => (pathquery, ""),
    };
    Some((authority.to_owned(), pathname.to_owned(), search.to_owned()))
}

/// The index of the blank line separating headers from the body (`\r?\n\r?\n`).
pub fn blank_line(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index + 1 < bytes.len() {
        if bytes[index] == b'\n' && bytes[index + 1] == b'\n' {
            return Some(index + 2);
        }
        if index + 2 < bytes.len()
            && bytes[index] == b'\r'
            && bytes[index + 1] == b'\n'
            && bytes[index + 2] == b'\n'
        {
            return Some(index + 3);
        }
        if index + 3 < bytes.len()
            && bytes[index] == b'\r'
            && bytes[index + 1] == b'\n'
            && bytes[index + 2] == b'\r'
            && bytes[index + 3] == b'\n'
        {
            return Some(index + 4);
        }
        index += 1;
    }
    None
}

/// The first `HTTP/<version> <status>` line's status.
pub fn status_of(header_text: &str) -> Option<u16> {
    static STATUS: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)^HTTP/[\d.]+ (\d{3})").expect("the status pattern compiles")
    });
    let first = header_text.lines().next()?;
    STATUS
        .captures(first.trim_end_matches('\r'))?
        .get(1)?
        .as_str()
        .parse()
        .ok()
}

/// The reply's headers, names lower-cased, in arrival order.
pub fn headers_of(header_text: &str) -> Vec<(String, String)> {
    header_text
        .lines()
        .skip(1)
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            let colon = line.find(':')?;
            if colon == 0 {
                return None;
            }
            Some((
                line[..colon].to_ascii_lowercase(),
                line[colon + 1..].trim().to_owned(),
            ))
        })
        .collect()
}

pub(crate) fn headers_get<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// `x-poll-interval` and the cache's validators, each only when it is plain and bounded.
pub(crate) fn safe_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut kept = Vec::new();
    for (name, value) in headers {
        let printable = value
            .chars()
            .all(|character| (' '..='~').contains(&character));
        let keep = match name.as_str() {
            "etag" => printable && !value.is_empty() && value.len() <= 512,
            "link" => true,
            "last-modified" => printable && !value.is_empty() && value.len() <= 128,
            "x-poll-interval" => {
                !value.is_empty() && value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit())
            }
            _ => false,
        };
        if keep {
            // Headers come from the host: redact before they are returned or cached (guide 2).
            kept.push((name.clone(), super::redact::redact(value, None)));
        }
    }
    kept
}

/// `Retry-After`, else `X-RateLimit-Reset`, else a minute from now.
pub(crate) fn rate_limit_retry_at(headers: &[(String, String)], now: f64) -> f64 {
    if let Some(seconds) =
        headers_get(headers, "retry-after").and_then(|value| value.parse::<f64>().ok())
        && seconds.is_finite()
        && seconds >= 0.0
    {
        return now + seconds * 1_000.0;
    }
    if let Some(reset) = headers_get(headers, "x-ratelimit-reset")
        .and_then(|value| value.parse::<f64>().ok())
        .map(|seconds| seconds * 1_000.0)
        && reset.is_finite()
        && reset > now
    {
        return reset;
    }
    now + 60_000.0
}

/// gh printed no HTTP response: it never reached the host, or refused for missing sign-in.
pub(crate) fn no_response(output: &CommandResult, dispatch: &MutationDispatch) -> ForgeError {
    if output.code == Some(4) && output.stdout.trim().is_empty() {
        dispatch.reject();
        return ForgeError::not_dispatched(Kind::Forbidden);
    }
    ForgeError::new(if output.unreachable {
        Kind::Offline
    } else {
        Kind::Cli
    })
}

/// Successful fields or unknown errors cannot prove that a mutation was refused.
pub(crate) fn assert_graphql_result(
    body: &Value,
    dispatch: &MutationDispatch,
    retry_at: f64,
    query: bool,
) -> Result<(), ForgeError> {
    let Some(object) = body.as_object() else {
        return Err(ForgeError::new(Kind::InvalidData));
    };
    if let Some(errors) = object.get("errors").and_then(|errors| errors.as_array()) {
        for error in errors {
            let Some(fields) = error.as_object() else {
                return Err(ForgeError::new(Kind::InvalidData));
            };
            if fields
                .get("type")
                .is_some_and(|kind| kind.as_str().is_none())
            {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            match fields.get("extensions") {
                None => {}
                Some(Value::Object(extensions))
                    if extensions
                        .get("code")
                        .is_some_and(|code| code.as_str().is_none()) =>
                {
                    return Err(ForgeError::new(Kind::InvalidData));
                }
                Some(Value::Object(_)) => {}
                Some(_) => return Err(ForgeError::new(Kind::InvalidData)),
            }
        }
    }
    let data = match object.get("data") {
        None | Some(Value::Null) => None,
        Some(Value::Object(_)) => object.get("data"),
        Some(_) => return Err(ForgeError::new(Kind::InvalidData)),
    };
    let errors = match object.get("errors") {
        None => return Ok(()),
        Some(Value::Array(errors)) if errors.is_empty() => return Ok(()),
        Some(Value::Array(errors)) => errors,
        Some(_) => return Err(ForgeError::new(Kind::InvalidData)),
    };
    let refused = match data {
        Some(Value::Object(fields)) => {
            fields.is_empty() || fields.iter().all(|(_, value)| *value == Value::Null)
        }
        _ => true,
    };
    let codes: Vec<Option<&str>> = errors
        .iter()
        .map(|error| {
            let fields = error.as_object();
            fields
                .and_then(|fields| fields.get("type"))
                .and_then(|value| value.as_str())
                .or_else(|| {
                    fields
                        .and_then(|fields| fields.get("extensions"))
                        .and_then(|extensions| extensions.as_object())
                        .and_then(|extensions| extensions.get("code"))
                        .and_then(|value| value.as_str())
                })
        })
        .collect();
    let all = |code: &str| codes.iter().all(|each| *each == Some(code));
    let error = if refused && all("RATE_LIMITED") {
        ForgeError::retry_at(Kind::RateLimit, retry_at)
    } else if refused && (all("FORBIDDEN") || all("UNAUTHORIZED")) {
        ForgeError::not_dispatched(Kind::Forbidden)
    } else if refused && all("NOT_FOUND") {
        ForgeError::not_dispatched(Kind::NotFound)
    } else if refused && (all("UNPROCESSABLE") || all("STALE_DATA")) {
        ForgeError::not_dispatched(Kind::Conflict)
    } else if refused && (all("GRAPHQL_VALIDATION_FAILED") || all("undefinedField")) {
        ForgeError::query_refused()
    } else if query && !refused && only_missing_fields(data, errors) {
        return Ok(());
    } else {
        // Unrecognised errors prove nothing about a write: it stays uncertain.
        return Err(ForgeError::new(Kind::InvalidData));
    };
    dispatch.reject();
    Err(error)
}

/// A read may name missing fields (a deleted PR among many aliases); the rest is valid.
pub(crate) fn only_missing_fields(data: Option<&Value>, errors: &[Value]) -> bool {
    let Some(data) = data else {
        return false;
    };
    !errors.is_empty()
        && errors.iter().all(|error| {
            let Some(fields) = error.as_object() else {
                return false;
            };
            if fields.get("type").and_then(|kind| kind.as_str()) != Some("NOT_FOUND") {
                return false;
            }
            let Some(path) = fields.get("path").and_then(|path| path.as_array()) else {
                return false;
            };
            if path.is_empty() || path.len() > 32 {
                return false;
            }
            let mut value = data;
            for step in path {
                match step {
                    Value::String(key) => {
                        match value
                            .as_object()
                            .and_then(|fields| fields.get(key.as_str()))
                        {
                            Some(next) => value = next,
                            None => return false,
                        }
                    }
                    Value::Number(number) => match number
                        .as_i64()
                        .and_then(|index| usize::try_from(index).ok())
                        .and_then(|index| value.as_array().and_then(|items| items.get(index)))
                    {
                        Some(next) => value = next,
                        None => return false,
                    },
                    _ => return false,
                }
            }
            *value == Value::Null
        })
}

/// `unprocessableKind`: GitHub's 422 body names the refused field or explains the refusal,
/// mapped to the fixed categories in the TypeScript's order (`http-errors.ts:19-46`).
pub fn unprocessable_kind(text: &str) -> Kind {
    static NO_COMMITS: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?i)no commits between").expect("compiles"));
    static PR_EXISTS: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)pull request already exists").expect("compiles")
    });
    static ALREADY: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?i)already exists").expect("compiles"));
    let Ok(body) = ace_json::parse(text) else {
        return Kind::Unprocessable;
    };
    let Some(fields) = body.as_object() else {
        return Kind::Unprocessable;
    };
    let text_field = |value: Option<&Value>, max: usize| -> Option<Option<String>> {
        match value {
            None | Some(Value::Null) => Some(None),
            Some(field) => field
                .as_str()
                .filter(|text| text.chars().count() <= max)
                .map(|text| Some(text.to_owned())),
        }
    };
    let Some(message) = text_field(fields.get("message"), 4_096) else {
        return Kind::Unprocessable;
    };
    let entries: Vec<(Option<String>, Option<String>, Option<String>)> = match fields.get("errors")
    {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(errors)) if errors.len() <= 100 => {
            let mut entries = Vec::with_capacity(errors.len());
            for error in errors {
                match error {
                    Value::String(message) if message.chars().count() <= 4_096 => {
                        entries.push((None, None, Some(message.as_str().to_owned())));
                    }
                    Value::Object(detail) => {
                        let Some(field) = text_field(detail.get("field"), 256) else {
                            return Kind::Unprocessable;
                        };
                        let Some(code) = text_field(detail.get("code"), 256) else {
                            return Kind::Unprocessable;
                        };
                        let Some(detail_message) = text_field(detail.get("message"), 4_096) else {
                            return Kind::Unprocessable;
                        };
                        entries.push((field, code, detail_message));
                    }
                    _ => return Kind::Unprocessable,
                }
            }
            entries
        }
        _ => return Kind::Unprocessable,
    };
    let mut messages: Vec<String> = message.into_iter().collect();
    messages.extend(entries.iter().filter_map(|(_, _, message)| message.clone()));
    if messages.iter().any(|message| NO_COMMITS.is_match(message)) {
        return Kind::NoCommits;
    }
    if messages.iter().any(|message| PR_EXISTS.is_match(message)) {
        return Kind::PrExists;
    }
    let invalid = |field: &str| {
        entries.iter().any(|(entry_field, code, _)| {
            entry_field.as_deref() == Some(field) && code.as_deref() == Some("invalid")
        })
    };
    if invalid("head") {
        return Kind::HeadMissing;
    }
    if invalid("base") {
        return Kind::BaseMissing;
    }
    if entries.iter().any(|(_, code, message)| {
        code.as_deref() == Some("already_exists")
            || message
                .as_deref()
                .is_some_and(|text| ALREADY.is_match(text))
    }) {
        return Kind::Conflict;
    }
    Kind::Unprocessable
}

/// A 403 body that says the host rate-limited the request (`http.ts:214`).
pub(crate) fn rate_limited_body(text: &str) -> bool {
    static LIMITED: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)secondary rate limit|rate limit exceeded|abuse detection")
            .expect("compiles")
    });
    ace_json::parse(text)
        .ok()
        .and_then(|body| {
            body.as_object()
                .and_then(|fields| fields.get("message"))
                .and_then(|message| message.as_str().map(str::to_owned))
        })
        .is_some_and(|message| LIMITED.is_match(&message))
}

/// A 403 markdown reply mentioning a rate limit (`http.ts:371`).
pub(crate) fn markdown_rate_limited(body: &str) -> bool {
    static LIMITED: std::sync::LazyLock<Regex> =
        std::sync::LazyLock::new(|| Regex::new(r"(?i)rate limit").expect("compiles"));
    LIMITED.is_match(body)
}

pub(crate) fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}
