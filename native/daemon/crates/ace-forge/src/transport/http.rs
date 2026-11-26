// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! `GhApi` (`http.ts`): GitHub requests through `gh api --include`, with `--include` parsing,
//! ETag and `If-Modified-Since` reuse, a GraphQL cache keyed by the document's SHA-256, cache
//! clearing on writes, `x-poll-interval`, and the fixed error categories. Every body is
//! redacted before it is cached or returned (`redact.ts`, ADR 0224 §8a).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ace_json::{Map, Value};
use regex::Regex;
use sha2::{Digest, Sha256};

use crate::transport::command::{Cancellation, CommandRequest, Runner};
use crate::transport::error::{ForgeError, Kind};
use crate::transport::mutation::{MutationDispatch, is_forge_mutation};

/// How much redacted cache a `GhApi` keeps before it starts over.
const CACHE_BUDGET_BYTES: usize = 8_388_608;

/// The reply page a caller reads.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub body: Value,
    pub headers: Vec<(String, String)>,
    pub bytes: usize,
    pub version: String,
    pub identity_changed: bool,
}

impl Page {
    /// One header's value, case-insensitively.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// GitHub's API over one runner, with its ETag and GraphQL caches.
pub struct GhApi<'a> {
    runner: &'a dyn Runner,
    command: String,
    host: String,
    now: Box<dyn Fn() -> f64 + Send + Sync>,
    on_write: Option<Box<dyn Fn() + Send + Sync>>,
    cache: Mutex<HashMap<String, Page>>,
    cache_bytes: Mutex<usize>,
}

impl<'a> GhApi<'a> {
    /// The default `gh` on `host`, with the caller's clock.
    pub fn new(
        runner: &'a dyn Runner,
        host: impl Into<String>,
        now: Box<dyn Fn() -> f64 + Send + Sync>,
    ) -> GhApi<'a> {
        GhApi {
            runner,
            command: String::from("gh"),
            host: host.into(),
            now,
            on_write: None,
            cache: Mutex::new(HashMap::new()),
            cache_bytes: Mutex::new(0),
        }
    }

    /// Another CLI command (a test's fake `gh`).
    pub fn command(mut self, command: impl Into<String>) -> GhApi<'a> {
        self.command = command.into();
        self
    }

    /// Runs as a write starts and once it ends, however it ends.
    pub fn on_write(mut self, on_write: Box<dyn Fn() + Send + Sync>) -> GhApi<'a> {
        self.on_write = Some(on_write);
        self
    }

    /// One request; `body` (JSON) makes it a POST unless `method` says otherwise.
    pub async fn request(
        &self,
        path: &str,
        body: Option<Value>,
        method: Option<&str>,
        cancellation: Option<Arc<Cancellation>>,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<Page, ForgeError> {
        let input = body
            .as_ref()
            .map(|body| ace_json::ser::to_string(body).unwrap_or_default());
        let method = method.unwrap_or(if input.is_some() { "POST" } else { "GET" });
        let probe = CommandRequest {
            command: self.command.clone(),
            args: vec![
                String::from("api"),
                path.to_owned(),
                String::from("--method"),
                method.to_owned(),
            ],
            input: input.clone(),
            mode: crate::transport::command::Mode::Json,
            tail_bytes: None,
            cancellation: cancellation.clone(),
            dispatch: None,
        };
        let write = is_forge_mutation(&probe);
        if write && let Some(on_write) = &self.on_write {
            on_write();
        }
        let outcome = self
            .send(path, &input, method, write, cancellation, dispatch)
            .await;
        if write && let Some(on_write) = &self.on_write {
            on_write();
        }
        outcome
    }

    async fn send(
        &self,
        path: &str,
        input: &Option<String>,
        method: &str,
        write: bool,
        cancellation: Option<Arc<Cancellation>>,
        dispatch: Arc<MutationDispatch>,
    ) -> Result<Page, ForgeError> {
        let mut args = vec![
            String::from("api"),
            path.to_owned(),
            String::from("--hostname"),
            self.host.clone(),
            String::from("--include"),
            String::from("--method"),
            method.to_owned(),
            String::from("--header"),
            String::from("Accept: application/vnd.github+json"),
        ];
        let reusable = !write;
        if !reusable {
            self.cache.lock().expect("cache lock").clear();
            *self.cache_bytes.lock().expect("cache bytes lock") = 0;
        }
        let cache_key = if method == "GET" {
            path.to_owned()
        } else {
            format!("graphql:{}", sha256_hex(input.as_deref().unwrap_or("")))
        };
        let cached = if reusable {
            self.cache
                .lock()
                .expect("cache lock")
                .get(&cache_key)
                .cloned()
        } else {
            None
        };
        if method == "GET"
            && let Some(cached) = &cached
        {
            if let Some(etag) = cached.header("etag") {
                args.push(String::from("--header"));
                args.push(format!("If-None-Match: {etag}"));
            }
            if let Some(modified) = cached.header("last-modified") {
                args.push(String::from("--header"));
                args.push(format!("If-Modified-Since: {modified}"));
            }
        }
        if input.is_some() {
            args.push(String::from("--input"));
            args.push(String::from("-"));
        }
        let request = CommandRequest {
            command: self.command.clone(),
            args,
            input: input.clone(),
            mode: crate::transport::command::Mode::Json,
            tail_bytes: None,
            cancellation,
            dispatch: Some(dispatch.clone()),
        };
        let output = match self.runner.run(request).await {
            Ok(output) => output,
            Err(error) => {
                return Err(if write {
                    dispatch.failure(error)
                } else {
                    error
                });
            }
        };
        let Some(split) = blank_line(&output.stdout) else {
            return Err(no_response(&output, &dispatch));
        };
        let header_text = &output.stdout[..split];
        let status = status_of(header_text).ok_or_else(|| no_response(&output, &dispatch))?;
        let headers = headers_of(header_text);
        let retry_at = rate_limit_retry_at(&headers, (self.now)());
        let text = &output.stdout[split..];
        // A 304 carries no body: the cached page is the answer, with fresh headers.
        if status == 304
            && let Some(mut cached) = cached
        {
            cached.headers = safe_headers(&headers);
            self.retain(cache_key, cached.clone());
            return Ok(cached);
        }
        if status == 401 || status == 403 {
            dispatch.reject();
            return Err(ForgeError::not_dispatched(Kind::Forbidden));
        }
        if status == 404 {
            dispatch.reject();
            return Err(ForgeError::not_dispatched(Kind::NotFound));
        }
        if status == 429
            || (status == 403 && headers_get(&headers, "x-ratelimit-remaining") == Some("0"))
        {
            dispatch.reject();
            return Err(ForgeError::retry_at(Kind::RateLimit, retry_at));
        }
        if path == "graphql" {
            if output.truncated {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            let body: Value =
                ace_json::parse(text).map_err(|_| ForgeError::new(Kind::InvalidData))?;
            assert_graphql_result(&body, &dispatch, retry_at, !write)?;
        }
        if !(200..300).contains(&status) {
            return Err(ForgeError::new(Kind::Cli));
        }
        if output.code.is_some_and(|code| code != 0) {
            return Err(ForgeError::new(Kind::Cli));
        }
        let version = sha256_hex(text);
        if let Some(mut cached) = cached
            && cached.version == version
        {
            cached.headers = safe_headers(&headers);
            self.retain(cache_key, cached.clone());
            return Ok(cached);
        }
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            let parsed: Value =
                ace_json::parse(text).map_err(|_| ForgeError::new(Kind::InvalidData))?;
            redact_data(&parsed)
        };
        let page = Page {
            body,
            headers: safe_headers(&headers),
            bytes: text.len(),
            version,
            identity_changed: output.identity_changed,
        };
        if reusable {
            self.retain(cache_key, page.clone());
        }
        Ok(page)
    }

    fn retain(&self, key: String, page: Page) {
        let mut cache = self.cache.lock().expect("cache lock");
        let mut bytes = self.cache_bytes.lock().expect("cache bytes lock");
        if bytes.saturating_add(page.bytes) > CACHE_BUDGET_BYTES {
            cache.clear();
            *bytes = 0;
        }
        if let Some(previous) = cache.get(&key) {
            *bytes = bytes.saturating_sub(previous.bytes);
        }
        *bytes = bytes.saturating_add(page.bytes);
        cache.insert(key, page);
    }
}

/// The index of the blank line separating headers from the body (`\r?\n\r?\n`).
fn blank_line(text: &str) -> Option<usize> {
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
fn status_of(header_text: &str) -> Option<u16> {
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
fn headers_of(header_text: &str) -> Vec<(String, String)> {
    header_text
        .lines()
        .skip(1)
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            let colon = line.find(':')?;
            Some((
                line[..colon].to_ascii_lowercase(),
                line[colon + 1..].trim().to_owned(),
            ))
        })
        .collect()
}

fn headers_get<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

/// `x-poll-interval` and the cache's validators, each only when it is plain and bounded.
fn safe_headers(headers: &[(String, String)]) -> Vec<(String, String)> {
    let mut kept = Vec::new();
    for (name, value) in headers {
        let printable = value
            .chars()
            .all(|character| (' '..='~').contains(&character));
        let keep = match name.as_str() {
            "etag" => printable && value.len() <= 512,
            "link" => true,
            "last-modified" => printable && value.len() <= 128,
            "x-poll-interval" => {
                !value.is_empty() && value.len() <= 5 && value.bytes().all(|b| b.is_ascii_digit())
            }
            _ => false,
        };
        if keep {
            kept.push((name.clone(), value.clone()));
        }
    }
    kept
}

/// `Retry-After`, else `X-RateLimit-Reset`, else a minute from now.
fn rate_limit_retry_at(headers: &[(String, String)], now: f64) -> f64 {
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
fn no_response(
    output: &crate::transport::command::CommandResult,
    dispatch: &MutationDispatch,
) -> ForgeError {
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
fn assert_graphql_result(
    body: &Value,
    dispatch: &MutationDispatch,
    retry_at: f64,
    query: bool,
) -> Result<(), ForgeError> {
    let Some(object) = body.as_object() else {
        return Err(ForgeError::new(Kind::InvalidData));
    };
    let data = object.get("data");
    let errors = match object.get("errors") {
        Some(Value::Array(errors)) if !errors.is_empty() => errors,
        _ => return Ok(()),
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
        ForgeError::not_dispatched(Kind::InvalidData)
    } else if query && !refused && only_missing_fields(data, errors) {
        return Ok(());
    } else {
        ForgeError::new(Kind::InvalidData)
    };
    let _ = error;
    dispatch.reject();
    Err(error)
}

/// A read may name missing fields (a deleted PR among many aliases); the rest is valid.
fn only_missing_fields(data: Option<&Value>, errors: &[Value]) -> bool {
    let Some(Value::Object(fields)) = data else {
        return false;
    };
    !errors.is_empty()
        && errors.iter().all(|error| {
            let Some(path) = error
                .as_object()
                .and_then(|fields| fields.get("path"))
                .and_then(|path| path.as_array())
            else {
                return false;
            };
            match path.first() {
                Some(Value::String(root)) => fields
                    .get(root.as_str())
                    .is_some_and(|value| *value == Value::Null),
                _ => false,
            }
        })
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// `redact.ts`'s `redactData`: strings masked, secret keys masked, colliding keys suffixed.
pub fn redact_data(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::from(super::tail::redact(text.as_str(), None)),
        Value::Array(items) => Value::Array(items.iter().map(redact_data).collect()),
        Value::Object(fields) => {
            let mut result = Map::new();
            let mut suffixes: HashMap<String, usize> = HashMap::new();
            for (key, entry) in fields.iter() {
                let redacted_key = super::tail::redact(key.as_str(), None);
                let mut safe_key = redacted_key.clone();
                let mut suffix = *suffixes.get(&redacted_key).unwrap_or(&1);
                while result.get(safe_key.as_str()).is_some() {
                    safe_key = format!("{redacted_key}#{suffix}");
                    suffix += 1;
                }
                suffixes.insert(redacted_key, suffix);
                let value = if ace_redaction::is_secret_key(key.as_str()) {
                    Value::from("[REDACTED]")
                } else {
                    redact_data(entry)
                };
                result.insert(safe_key, value);
            }
            Value::Object(result)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use std::pin::Pin;
    use std::sync::Mutex;

    use ace_json::json;

    use super::{GhApi, Page, blank_line, headers_of, redact_data, status_of};
    use crate::transport::command::{CommandRequest, CommandResult, Runner};
    use crate::transport::error::Kind;

    #[derive(Default)]
    struct Stub {
        replies: Mutex<Vec<CommandResult>>,
        seen: Mutex<Vec<CommandRequest>>,
    }

    impl Runner for Stub {
        fn run<'a>(
            &'a self,
            request: CommandRequest,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<CommandResult, crate::transport::error::ForgeError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.seen.lock().expect("seen").push(request);
                Ok(self.replies.lock().expect("replies").remove(0))
            })
        }
    }

    fn reply(text: &str) -> CommandResult {
        CommandResult {
            code: Some(0),
            stdout: text.to_owned(),
            truncated: false,
            identity_changed: false,
            http: None,
            unreachable: false,
        }
    }

    fn api(json: &str, extra: &str) -> String {
        format!("HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n{extra}\r\n{json}")
    }

    fn stub(replies: &[&str]) -> Stub {
        Stub {
            replies: Mutex::new(replies.iter().map(|text| reply(text)).collect()),
            seen: Mutex::new(Vec::new()),
        }
    }

    #[test]
    fn the_header_split_and_status_are_parsed_from_include_output() {
        let text = "HTTP/1.1 404 Not Found\r\nETag: \"abc\"\r\n\r\n{\"message\":\"missing\"}";
        let split = blank_line(text).expect("a blank line");
        assert_eq!(status_of(&text[..split]), Some(404));
        let headers = headers_of(&text[..split]);
        assert_eq!(headers[0], ("etag".to_owned(), "\"abc\"".to_owned()));
        assert_eq!(&text[split..], "{\"message\":\"missing\"}");
    }

    #[test]
    fn a_get_reuses_its_etag_and_a_304_answers_the_cached_page() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let first_reply = api(r#"{"login":"octo"}"#, "ETag: \"v1\"\r\n");
            let stub = stub(&[
                first_reply.as_str(),
                "HTTP/2.0 304 Not Modified\r\nETag: \"v2\"\r\n\r\n",
            ]);
            let api_client = GhApi::new(&stub, "github.com", Box::new(|| 0.0));
            let first = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect("a page");
            assert_eq!(first.body, json!({ "login": "octo" }));
            let second = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect("the cached page");
            assert_eq!(second.body, first.body);
            assert_eq!(second.header("etag"), Some("\"v2\""));
            let seen = stub.seen.lock().expect("seen");
            assert!(
                seen[1]
                    .args
                    .contains(&String::from("If-None-Match: \"v1\"")),
                "{:?}",
                seen[1].args
            );
        });
    }

    #[test]
    fn a_write_clears_the_cache_and_its_graphql_key_is_the_documents_sha256() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let query_reply = api(r#"{"viewer":{"login":"octo"}}"#, "");
            let mutation_reply = api(r#"{"ok":true}"#, "");
            let stub = stub(&[
                query_reply.as_str(),
                mutation_reply.as_str(),
                query_reply.as_str(),
            ]);
            let api_client = GhApi::new(&stub, "github.com", Box::new(|| 0.0));
            let query = json!({ "query": "query { viewer { login } }" });
            api_client
                .request(
                    "graphql",
                    Some(query.clone()),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect("a query");
            api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "mutation { x }" })),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect("a mutation");
            let third = api_client
                .request("graphql", Some(query), None, None, Default::default())
                .await
                .expect("the query again");
            assert_eq!(third.body, json!({ "viewer": { "login": "octo" } }));
            let seen = stub.seen.lock().expect("seen");
            assert_eq!(seen.len(), 3);
            assert!(
                !seen[2]
                    .args
                    .iter()
                    .any(|arg| arg.starts_with("If-None-Match")),
                "a write cleared the cache: {:?}",
                seen[2].args
            );
        });
    }

    #[test]
    fn a_refused_status_maps_to_the_fixed_category() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let stub = stub(&["HTTP/2.0 403 Forbidden\r\n\r\n"]);
            let api_client = GhApi::new(&stub, "github.com", Box::new(|| 0.0));
            let error = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect_err("refused");
            assert_eq!(error.kind, Kind::Forbidden);
            assert_eq!(error.dispatched, Some(false));
        });
    }

    #[test]
    fn a_rate_limited_reply_carries_its_retry_time() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let stub = stub(&["HTTP/2.0 429 Too Many Requests\r\nRetry-After: 30\r\n\r\n"]);
            let api_client = GhApi::new(&stub, "github.com", Box::new(|| 1_000.0));
            let error = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect_err("rate limited");
            assert_eq!(error.kind, Kind::RateLimit);
            assert_eq!(error.retry_at, Some(31_000.0));
        });
    }

    #[test]
    fn bodies_are_redacted_before_they_are_kept_and_colliding_keys_are_suffixed() {
        let page: Page = Page {
            body: json!({ "visible": "ok", "token": "opaque", "ghp_keyone": { "value": 1 }, "ghp_keytwo": { "value": 2 } }),
            headers: Vec::new(),
            bytes: 1,
            version: String::from("v"),
            identity_changed: false,
        };
        let clean = redact_data(&page.body);
        let text = ace_json::ser::to_string(&clean).expect("serializes");
        assert!(!text.contains("opaque"), "{text}");
        assert!(text.contains(r#""visible":"ok""#), "{text}");
        assert!(text.contains(r#""value":1"#), "{text}");
        assert!(text.contains(r#""value":2"#), "{text}");
        assert!(!text.contains("ghp_keyone"), "{text}");
        assert!(text.contains("[REDACTED]#1"), "{text}");
    }

    #[test]
    fn a_graphql_error_is_a_refusal_the_reader_may_smaller_ask() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            let text = api(r#"{"data":null,"errors":[{"type":"NOT_FOUND"}]}"#, "");
            let stub = stub(&[text.as_str()]);
            let api_client = GhApi::new(&stub, "github.com", Box::new(|| 0.0));
            let error = api_client
                .request(
                    "graphql",
                    Some(json!({ "query": "query { x }" })),
                    None,
                    None,
                    Default::default(),
                )
                .await
                .expect_err("refused");
            assert_eq!(error.kind, Kind::NotFound);
        });
    }
}
