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
    /// A stable identity for the readers that cache a projection per page.
    pub id: u64,
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
    now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
    on_write: Option<Box<dyn Fn() + Send + Sync>>,
    cache: Mutex<HashMap<String, Page>>,
    /// Cache keys in insertion order, so eviction takes the oldest first.
    order: Mutex<Vec<String>>,
    cache_bytes: Mutex<usize>,
    /// The child's credential values, masked in every page and header as the guide requires.
    environment: Option<ace_redaction::EnvironmentMatcher>,
    next_page_id: std::sync::atomic::AtomicU64,
}

impl<'a> GhApi<'a> {
    /// The default `gh` on `host`, with the caller's clock.
    pub fn new(
        runner: &'a dyn Runner,
        host: impl Into<String>,
        now: std::sync::Arc<dyn Fn() -> f64 + Send + Sync>,
    ) -> GhApi<'a> {
        GhApi {
            runner,
            command: String::from("gh"),
            host: host.into(),
            now,
            on_write: None,
            cache: Mutex::new(HashMap::new()),
            order: Mutex::new(Vec::new()),
            cache_bytes: Mutex::new(0),
            next_page_id: std::sync::atomic::AtomicU64::new(1),
            environment: runner.credential_environment(),
        }
    }

    /// Another CLI command (a test's fake `gh`).
    pub fn command(mut self, command: impl Into<String>) -> GhApi<'a> {
        self.command = command.into();
        self
    }

    /// The request's exact credential values, from the child's environment.
    pub fn environment(mut self, environment: ace_redaction::EnvironmentMatcher) -> GhApi<'a> {
        self.environment = Some(environment);
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
            .send(path, &input, method, write, cancellation, dispatch.clone())
            .await;
        // Every error of a write is the dispatch's to classify (`http.ts:133-141`).
        let outcome = if write {
            outcome.map_err(|error| dispatch.failure(error))
        } else {
            outcome
        };
        if write {
            self.cache.lock().expect("cache lock").clear();
            *self.cache_bytes.lock().expect("cache bytes lock") = 0;
        }
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
        // A reply with headers but no status line is unreadable, never a sign-in answer.
        let status = status_of(header_text).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        if !(100..=599).contains(&status) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let headers = headers_of(header_text);
        let retry_at = rate_limit_retry_at(&headers, (self.now)());
        let text = &output.stdout[split..];
        // A 304 carries no body: the cached page is the answer. It keeps the validators and
        // `Link` the cached page held, and takes only a fresh `x-poll-interval`.
        if status == 304 {
            let Some(mut cached) = cached else {
                return Err(ForgeError::new(Kind::InvalidData));
            };
            if let Some(polled) = self
                .mask_headers(&headers)
                .into_iter()
                .find(|(name, _)| name == "x-poll-interval")
            {
                cached.headers.retain(|(name, _)| name != "x-poll-interval");
                cached.headers.push(polled);
            }
            self.retain(cache_key, cached.clone());
            return Ok(cached);
        }
        if status == 429 {
            dispatch.reject();
            return Err(ForgeError::retry_at(Kind::RateLimit, retry_at));
        }
        if status == 401 || status == 403 {
            // A 403 is a limit before it is a sign-in answer (`http.ts:222-234`); a 401 is
            // never one, and a plain-text body is not a JSON `message`.
            let limited = status == 403
                && (headers_get(&headers, "x-ratelimit-remaining") == Some("0")
                    || headers_get(&headers, "retry-after").is_some()
                    || rate_limited_body(text));
            if limited {
                dispatch.reject();
                return Err(ForgeError::retry_at(Kind::RateLimit, retry_at));
            }
            dispatch.reject();
            return Err(ForgeError::refused(Kind::Forbidden, status));
        }
        if status == 404 {
            dispatch.reject();
            return Err(ForgeError::not_dispatched(Kind::NotFound));
        }
        if status == 422 {
            dispatch.reject();
            return Err(ForgeError::not_dispatched(unprocessable_kind(text)));
        }
        if status == 405 && method == "PUT" && merge_path(path) {
            dispatch.reject();
            return Err(ForgeError::not_dispatched(Kind::Conflict));
        }
        if status == 409 || status == 400 {
            // GitHub's merge-async acknowledgement is the one 400/409 that is a result
            // (`http.ts:236-253`, `decodeStackMergeOperation`).
            let acknowledged =
                merge_operation(path, method, status, text).is_some_and(|operation| {
                    status != 409 || operation.state != "uncertain" || operation.uuid.is_some()
                });
            if acknowledged {
                let body: Value = ace_json::parse(text).unwrap_or(Value::Null);
                let page = Page {
                    id: self
                        .next_page_id
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                    body: self.mask_value(redact_data(&body)),
                    headers: self.mask_headers(&headers),
                    bytes: text.len(),
                    version: sha256_hex(text),
                    identity_changed: output.identity_changed,
                };
                if reusable {
                    self.retain(cache_key, page.clone());
                }
                return Ok(page);
            }
            if status == 409 {
                dispatch.reject();
                return Err(ForgeError::not_dispatched(Kind::Conflict));
            }
        }
        if !(200..300).contains(&status) {
            return Err(ForgeError::new(Kind::Cli));
        }
        // A missing exit code is a signal death, not success (`http.ts:285`).
        if path == "graphql" {
            if output.truncated {
                return Err(ForgeError::new(Kind::InvalidData));
            }
            let body: Value =
                ace_json::parse(text).map_err(|_| ForgeError::new(Kind::InvalidData))?;
            // A structured refusal is classified before the CLI's exit code (`http.ts:272-285`).
            assert_graphql_result(&body, &dispatch, retry_at, !write)?;
        }
        if output.code != Some(0) {
            return Err(ForgeError::new(Kind::Cli));
        }
        let version = sha256_hex(text);
        if let Some(mut cached) = cached
            && cached.version == version
        {
            cached.headers = self.mask_headers(&headers);
            self.retain(cache_key, cached.clone());
            return Ok(cached);
        }
        let body = if text.trim().is_empty() {
            Value::Null
        } else {
            let parsed: Value =
                ace_json::parse(text).map_err(|_| ForgeError::new(Kind::InvalidData))?;
            self.mask_value(redact_data(&parsed))
        };
        let page = Page {
            id: self
                .next_page_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            body: self.mask_value(body),
            headers: self.mask_headers(&headers),
            bytes: text.len(),
            version,
            identity_changed: output.identity_changed,
        };
        if reusable {
            self.retain(cache_key, page.clone());
        }
        Ok(page)
    }

    /// The request's exact values masked in every string of `value`.
    fn mask_value(&self, value: Value) -> Value {
        let Some(environment) = &self.environment else {
            return value;
        };
        mask_environment_value(&value, environment)
    }

    /// Headers with the request's values masked; a validator that held one is dropped, so it
    /// can never return as `If-None-Match`/`If-Modified-Since`.
    fn mask_headers(&self, headers: &[(String, String)]) -> Vec<(String, String)> {
        let mut kept = safe_headers(headers);
        let Some(environment) = &self.environment else {
            return kept;
        };
        // A header that carried a configured value is dropped whole: a validator would
        // return it as `If-None-Match`, and a `Link` would keep it in the cache.
        kept.retain_mut(|(_, value)| {
            if !environment.spans(value).is_empty() {
                return false;
            }
            *value = super::redact::redact(value, Some(environment));
            true
        });
        kept
    }

    fn retain(&self, key: String, page: Page) {
        // A page bigger than the whole cache is never retained, as the TypeScript skips it.
        if page.bytes > CACHE_BUDGET_BYTES.saturating_sub(1) {
            return;
        }
        let mut cache = self.cache.lock().expect("cache lock");
        let mut order = self.order.lock().expect("cache order lock");
        let mut bytes = self.cache_bytes.lock().expect("cache bytes lock");
        // Completing a request replaces the entry actually retained, in place.
        if let Some(previous) = cache.remove(&key) {
            *bytes = bytes.saturating_sub(previous.bytes);
            order.retain(|held| held != &key);
        }
        while order.len() >= 128 || bytes.saturating_add(page.bytes) > CACHE_BUDGET_BYTES {
            let Some(oldest) = (!order.is_empty()).then(|| order.remove(0)) else {
                break;
            };
            if let Some(evicted) = cache.remove(&oldest) {
                *bytes = bytes.saturating_sub(evicted.bytes);
            }
        }
        *bytes = bytes.saturating_add(page.bytes);
        order.push(key.clone());
        cache.insert(key, page);
    }
}

impl GhApi<'_> {
    /// Up to 20 pages following the `Link` header, each counted against `budget`.
    pub async fn pages(
        &self,
        path: &str,
        cancellation: Option<Arc<Cancellation>>,
        budget: &mut crate::transport::limits::ReadBudget,
    ) -> Result<Vec<Page>, ForgeError> {
        let mut result = Vec::new();
        let mut endpoint = Some(path.to_owned());
        for _ in 0..20 {
            let Some(current) = endpoint else {
                return Ok(result);
            };
            let page = self
                .request(
                    &current,
                    None,
                    None,
                    cancellation.clone(),
                    Default::default(),
                )
                .await?;
            budget.add(page.bytes as u64)?;
            endpoint = self.next(&page, path)?;
            result.push(page);
        }
        if endpoint.is_some() {
            return Err(ForgeError::new(Kind::Limit));
        }
        Ok(result)
    }

    /// The `next` page's endpoint for `page`, validated against this API host and resource.
    pub fn next(&self, page: &Page, path: &str) -> Result<Option<String>, ForgeError> {
        self.next_link(page.header("link"), path, "next")
    }

    /// The number of the `last` page GitHub links, when it links one.
    pub fn last_page(&self, page: &Page, path: &str) -> Result<Option<i64>, ForgeError> {
        let Some(last) = self.next_link(page.header("link"), path, "last")? else {
            return Ok(None);
        };
        let number = last
            .split('?')
            .nth(1)
            .and_then(|query| {
                query.split('&').find_map(|pair| {
                    let (name, value) = pair.split_once('=')?;
                    (name == "page").then(|| value.parse::<i64>().ok())?
                })
            })
            .filter(|number| *number >= 1);
        number
            .map(Some)
            .ok_or_else(|| ForgeError::new(Kind::InvalidData))
    }

    fn next_link(
        &self,
        link: Option<&str>,
        path: &str,
        rel: &str,
    ) -> Result<Option<String>, ForgeError> {
        let Some(link) = link else {
            return Ok(None);
        };
        let target = link.split(',').find_map(|part| {
            let part = part.trim();
            let target = part.strip_prefix('<')?.split('>').next()?;
            let attrs = part.split('>').nth(1)?;
            attrs
                .split(';')
                .any(|attr| attr.trim() == format!("rel=\"{rel}\""))
                .then(|| target.to_owned())
        });
        let Some(target) = target else {
            return Ok(None);
        };
        let Some((host, pathname, search)) = parse_link_url(&target) else {
            return Err(ForgeError::new(Kind::InvalidData));
        };
        let api_host = if self.host == "github.com" {
            "api.github.com"
        } else {
            self.host.as_str()
        };
        let prefix = if self.host == "github.com" {
            "/"
        } else {
            "/api/v3/"
        };
        if host != api_host || !pathname.starts_with(prefix) {
            return Err(ForgeError::new(Kind::InvalidData));
        }
        let linked = &pathname[prefix.len()..];
        let requested = path.split('?').next().unwrap_or(path);
        if linked == requested {
            return Ok(Some(format!("{linked}{search}")));
        }
        // GitHub may address the same resource by repository id; only the part below the
        // repository may differ, and the request stays scoped to the named repository.
        let named = requested
            .strip_prefix("repos/")
            .and_then(|rest| rest.split_once('/'))
            .and_then(|(_, rest)| rest.split_once('/').map(|(_, tail)| tail));
        let by_id = linked
            .strip_prefix("repositories/")
            .and_then(|rest| rest.split_once('/'))
            .map(|(_, tail)| tail);
        if let (Some(named), Some(by_id)) = (named, by_id)
            && named == by_id
        {
            return Ok(Some(format!("{requested}{search}")));
        }
        Err(ForgeError::new(Kind::InvalidData))
    }

    /// GitHub's rendering of `text` as a comment in `context`: a read, never cached.
    pub async fn render_markdown(
        &self,
        text: &str,
        context: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<String, ForgeError> {
        let input = format!(
            "{{\"text\":{},\"mode\":\"gfm\",\"context\":{}}}",
            ace_json::ser::to_string(text).unwrap_or_default(),
            ace_json::ser::to_string(context).unwrap_or_default()
        );
        let request = CommandRequest {
            command: self.command.clone(),
            args: vec![
                String::from("api"),
                String::from("markdown"),
                String::from("--hostname"),
                self.host.clone(),
                String::from("--include"),
                String::from("--method"),
                String::from("POST"),
                String::from("--header"),
                String::from("Accept: text/html"),
                String::from("--input"),
                String::from("-"),
            ],
            input: Some(input),
            mode: crate::transport::command::Mode::Json,
            tail_bytes: None,
            cancellation,
            dispatch: None,
        };
        let output = self.runner.run(request).await?;
        let Some(split) = blank_line(&output.stdout) else {
            return Err(no_response(&output, &MutationDispatch::new(None)));
        };
        let header_text = &output.stdout[..split];
        let status = status_of(header_text).ok_or_else(|| ForgeError::new(Kind::InvalidData))?;
        let body = &output.stdout[split..];
        if status == 429 || (status == 403 && rate_limited_body(body)) {
            return Err(ForgeError::retry_at(
                Kind::RateLimit,
                (self.now)() + 60_000.0,
            ));
        }
        if status == 401 || status == 403 {
            return Err(ForgeError::refused(Kind::Forbidden, status));
        }
        if status == 404 {
            return Err(ForgeError::not_dispatched(Kind::NotFound));
        }
        if status != 200 || output.code != Some(0) {
            return Err(ForgeError::new(Kind::Cli));
        }
        if output.truncated {
            return Err(ForgeError::new(Kind::Limit));
        }
        Ok(super::redact::redact(body, self.environment.as_ref()))
    }

    /// A job log's newest `tail_bytes`; `gh api` follows GitHub's redirect to the text.
    pub async fn log(
        &self,
        job_path: &str,
        cancellation: Option<Arc<Cancellation>>,
    ) -> Result<crate::transport::command::CommandResult, ForgeError> {
        let request = CommandRequest {
            command: self.command.clone(),
            args: vec![
                String::from("api"),
                job_path.to_owned(),
                String::from("--hostname"),
                self.host.clone(),
                String::from("--method"),
                String::from("GET"),
            ],
            input: None,
            mode: crate::transport::command::Mode::Tail,
            tail_bytes: None,
            cancellation,
            dispatch: None,
        };
        let result = self.runner.run(request).await?;
        if result.code != Some(0) {
            return Err(ForgeError::new(Kind::Cli));
        }
        Ok(result)
    }
}

/// `https://<host><pathname><search>`, refusing userinfo and other schemes.
fn parse_link_url(url: &str) -> Option<(String, String, String)> {
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

/// Forge's own key policy (`redact.ts:21`): token, authorization, password or secret.
fn forge_secret_key(key: &str) -> bool {
    static SECRET: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"(?i)token|authorization|password|secret").expect("compiles")
    });
    SECRET.is_match(key)
}

/// `value` with every configured value masked in its strings, depth-first.
fn mask_environment_value(value: &Value, environment: &ace_redaction::EnvironmentMatcher) -> Value {
    match value {
        Value::String(text) => Value::String(super::redact::redact_js(text, Some(environment))),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| mask_environment_value(item, environment))
                .collect(),
        ),
        Value::Object(fields) => {
            let mut result = Map::new();
            let mut suffixes: HashMap<String, usize> = HashMap::new();
            for (key, entry) in fields.iter() {
                let redacted_key = super::redact::redact_js(key, Some(environment));
                let base = redacted_key.as_str().to_owned();
                let mut safe = base.clone();
                let mut suffix = *suffixes.get(&base).unwrap_or(&1);
                while result.get(safe.as_str()).is_some() {
                    safe = format!("{base}#{suffix}");
                    suffix += 1;
                }
                suffixes.insert(base, suffix);
                result.insert(safe, mask_environment_value(entry, environment));
            }
            Value::Object(result)
        }
        other => other.clone(),
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
    // The schema's error shape: an object whose `type` is a string and whose `extensions`,
    // when present, is an object (`http.ts:18-38`). Anything else is unreadable, so the
    // mutation stays uncertain.
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
        ForgeError::not_dispatched(Kind::InvalidData)
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
fn only_missing_fields(data: Option<&Value>, errors: &[Value]) -> bool {
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
fn unprocessable_kind(text: &str) -> Kind {
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
            None => Some(None),
            Some(Value::Null) => Some(None),
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
                    // A bare string is the refusal's message.
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
    // Name collisions stay a conflict with the existing resource; nothing else does.
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

/// `repos/<owner>/<name>/pulls/<n>/merge`.
fn merge_path(path: &str) -> bool {
    static MERGE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^repos/[\w.-]+/[\w.-]+/pulls/[1-9]\d*/merge$").expect("compiles")
    });
    MERGE.is_match(path)
}

/// GitHub's merge-async acknowledgement (`decodeStackMergeOperation`): `{status,
/// details:{uuid, message}}` on a 400 or 409 for `pulls/<n>/merge-async`.
struct MergeOperation {
    state: String,
    uuid: Option<String>,
}

fn merge_operation(path: &str, method: &str, status: u16, text: &str) -> Option<MergeOperation> {
    static MERGE_ASYNC: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^repos/[\w.-]+/[\w.-]+/pulls/[1-9]\d*/merge-async$").expect("compiles")
    });
    if !(status == 400 || status == 409) || method != "PUT" || !MERGE_ASYNC.is_match(path) {
        return None;
    }
    let body = ace_json::parse(text).ok()?;
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
    Some(MergeOperation { state, uuid })
}

fn is_uuid(text: &str) -> bool {
    static UUID: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
            .expect("compiles")
    });
    UUID.is_match(text)
}

/// A 403 body that says the host rate-limited the request (`http.ts:214`).
fn rate_limited_body(text: &str) -> bool {
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

        .unwrap_or_else(|| text.to_owned())
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
                let value = if forge_secret_key(key.as_str()) {
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
        fn credential_environment(&self) -> Option<ace_redaction::EnvironmentMatcher> {
            None
        }

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
                if let Some(dispatch) = &request.dispatch {
                    dispatch.prepare();
                    dispatch.record();
                }
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
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
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
            assert_eq!(second.header("etag"), Some("\"v1\""));
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
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
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
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
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
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 1_000.0));
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
            id: 1,
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

    #[allow(clippy::type_complexity)]
    fn write<'a>(
        api_client: &'a GhApi<'a>,
        path: &str,
        body: ace_json::Value,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = (
                        Result<Page, crate::transport::error::ForgeError>,
                        std::sync::Arc<crate::transport::mutation::MutationDispatch>,
                    ),
                > + 'a,
        >,
    > {
        let dispatch = std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
        let path = path.to_owned();
        Box::pin(async move {
            let outcome = api_client
                .request(&path, Some(body), None, None, dispatch.clone())
                .await;
            (outcome, dispatch)
        })
    }

    #[test]
    fn a_malformed_graphql_error_leaves_a_mutation_uncertain() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&[&api(
                    r#"{"data":null,"errors":[{"type":"NOT_FOUND","extensions":null}]}"#,
                    "",
                )]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let dispatch =
                    std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
                let error = api_client
                    .request(
                        "graphql",
                        Some(json!({ "query": "mutation { x }" })),
                        None,
                        None,
                        dispatch.clone(),
                    )
                    .await
                    .expect_err("unreadable");
                assert_eq!(error.kind, Kind::OutcomeUncertain);
                assert!(!dispatch.definitely_failed(), "the fence stays");
            });
    }

    #[test]
    fn the_default_supervised_runner_masks_its_childs_credentials() {
        use std::os::unix::fs::PermissionsExt;

        let token = "opaque-gh-token-value";
        let path = std::env::temp_dir().join(format!("forge-echo-{}", std::process::id()));
        std::fs::write(
            &path,
            "#!/bin/sh\nprintf 'HTTP/2.0 200 OK\\r\\nETag: \"%s\"\\r\\n\\r\\n{\"note\":\"%s\"}' \"$GH_TOKEN\" \"$GH_TOKEN\"\n",
        )
        .expect("script");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            // No `.environment(…)` call: the supervised runner supplies its own.
            let runner = crate::transport::command::SupervisedRunner::new(
                tokio::runtime::Handle::current(),
                crate::transport::command::RunnerOptions {
                    env: vec![(String::from("GH_TOKEN"), token.to_owned())],
                    ..crate::transport::command::RunnerOptions::default()
                },
            )
            .expect("runner");
            let api_client = GhApi::new(&runner, "github.com", std::sync::Arc::new(|| 0.0))
                .command(path.to_string_lossy().into_owned());
            let page = api_client
                .request("user", None, None, None, Default::default())
                .await
                .expect("a page");
            let text = ace_json::ser::to_string(&page.body).expect("serializes");
            assert!(!text.contains(token), "{text}");
            assert!(text.contains("[REDACTED]"), "{text}");
            assert_eq!(page.header("etag"), None, "a validator is dropped");
        });
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_lost_write_response_is_an_uncertain_outcome_that_was_dispatched() {
        #[derive(Default)]
        struct Lost {
            seen: Mutex<Vec<CommandRequest>>,
        }

        impl Runner for Lost {
            fn credential_environment(&self) -> Option<ace_redaction::EnvironmentMatcher> {
                None
            }

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
                    if let Some(dispatch) = &request.dispatch {
                        dispatch.prepare();
                        dispatch.record();
                    }
                    self.seen.lock().expect("seen").push(request);
                    Err(crate::transport::error::ForgeError::new(Kind::Cli))
                })
            }
        }

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let runner = Lost::default();
                let api_client = GhApi::new(&runner, "github.com", std::sync::Arc::new(|| 0.0));
                let error = api_client
                    .request(
                        "repos/octo/ace/issues/1/comments",
                        Some(json!({ "body": "x" })),
                        None,
                        None,
                        Default::default(),
                    )
                    .await
                    .expect_err("the response was lost");
                assert_eq!(error.kind, Kind::OutcomeUncertain);
                assert_eq!(error.dispatched, Some(true));
            });
    }

    #[test]
    fn a_non_string_extension_code_is_unreadable_and_leaves_a_write_uncertain() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&[&api(
                    r#"{"data":null,"errors":[{"type":"NOT_FOUND","extensions":{"code":42}}]}"#,
                    "",
                )]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let dispatch =
                    std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
                let error = api_client
                    .request(
                        "graphql",
                        Some(json!({ "query": "mutation { x }" })),
                        None,
                        None,
                        dispatch.clone(),
                    )
                    .await
                    .expect_err("unreadable");
                assert_eq!(error.kind, Kind::OutcomeUncertain);
                assert!(!dispatch.definitely_failed());
            });
    }

    #[test]
    fn the_requests_credential_values_never_escape_a_page() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let token = "opaque-gh-token-value";
                let body = api(
                    &format!(r#"{{"note":"echoed {token}","visible":"ok"}}"#),
                    &format!("ETag: \"{token}\"\r\n"),
                );
                let stub = stub(&[body.as_str(), body.as_str()]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0))
                    .environment(ace_redaction::EnvironmentMatcher::new(&[token]));
                let page = api_client
                    .request("user", None, None, None, Default::default())
                    .await
                    .expect("a page");
                let text = ace_json::ser::to_string(&page.body).expect("serializes");
                assert!(!text.contains(token), "{text}");
                assert!(text.contains("[REDACTED]"), "{text}");
                assert_eq!(page.header("etag"), None, "a validator is dropped");
                api_client
                    .request("user", None, None, None, Default::default())
                    .await
                    .expect("a page");
                let seen = stub.seen.lock().expect("seen");
                let request = &seen[1];
                assert!(
                    !request.args.iter().any(|arg| arg.contains("If-None-Match")),
                    "{:?}",
                    request.args
                );
                assert!(!request.args.iter().any(|arg| arg.contains(token)));
            });
    }

    #[test]
    fn a_graphql_refusal_is_classified_before_a_nonzero_exit() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let mut output =
                    reply(&api(r#"{"data":null,"errors":[{"type":"NOT_FOUND"}]}"#, ""));
                output.code = Some(1);
                let stub = Stub {
                    replies: Mutex::new(vec![output]),
                    seen: Mutex::new(Vec::new()),
                };
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
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

    #[test]
    fn a_host_header_is_redacted_before_it_is_returned() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&[&api(r#"[]"#, "ETag: \"ghp_12345678901234567890\"\r\n")]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let page = api_client
                    .request("user/repos", None, None, None, Default::default())
                    .await
                    .expect("a page");
                assert_eq!(page.header("etag"), Some("\"[REDACTED]\""));
            });
    }

    #[test]
    fn a_409_merge_async_acknowledgement_is_the_result_and_not_a_refusal() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
        // `stacks.process.test.ts:18-20`: GitHub's acknowledgement body.
        let body = api(
            r#"{"status":"pending","details":{"uuid":"4f8b2a1c-3d5e-4f6a-8b9c-0d1e2f3a4b5c","message":"Merge requested"}}"#,
            "",
        )
        .replace("200 OK", "409 Conflict");
        let stub = stub(&[body.as_str()]);
        let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
        let dispatch =
            std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
        let page = api_client
            .request(
                "repos/octo/ace/pulls/8/merge-async",
                Some(json!({ "merge_method": "squash" })),
                Some("PUT"),
                None,
                dispatch.clone(),
            )
            .await
            .expect("the acknowledgement is the result");
        assert_eq!(page.body["status"], json!("pending"));
        assert_eq!(
            page.body["details"]["uuid"],
            json!("4f8b2a1c-3d5e-4f6a-8b9c-0d1e2f3a4b5c")
        );
        assert!(!dispatch.definitely_failed(), "the write may not be retried");

            });
    }

    #[test]
    fn an_unrecognised_graphql_error_leaves_a_mutation_uncertain() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        runtime.block_on(async {
            for reply in [
                api(r#"{"data":{"ok":true},"errors":[{"message":"boom"}]}"#, ""),
                String::from("HTTP/2.0 200 OK\r\n\r\nnot json"),
            ] {
                let stub = stub(&[reply.as_str()]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let (outcome, dispatch) =
                    write(&api_client, "graphql", json!({ "query": "mutation { x }" })).await;
                let error = outcome.expect_err("uncertain");
                assert_eq!(error.kind, Kind::OutcomeUncertain);
                assert!(!dispatch.definitely_failed(), "the write must stay fenced");
            }
        });
    }

    #[test]
    fn a_mutation_that_fails_after_dispatch_is_uncertain() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&["HTTP/2.0 502 Bad Gateway\r\n\r\n{\"message\":\"bad\"}"]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let (outcome, dispatch) = write(
                    &api_client,
                    "repos/octo/ace/issues/1/comments",
                    json!({ "body": "x" }),
                )
                .await;
                assert_eq!(outcome.expect_err("uncertain").kind, Kind::OutcomeUncertain);
                assert!(!dispatch.definitely_failed());
            });
    }

    #[test]
    fn a_refused_pr_create_names_its_reason_and_is_certain() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&[
                    &api(r#"{"message":"No commits between main and work"}"#, "")
                        .replace("200 OK", "422 Unprocessable"),
                ]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let dispatch =
                    std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
                let outcome = api_client
                    .request(
                        "repos/octo/ace/pulls",
                        Some(json!({ "title": "x", "head": "work", "base": "main" })),
                        None,
                        None,
                        dispatch.clone(),
                    )
                    .await;
                assert_eq!(outcome.expect_err("refused").kind, Kind::NoCommits);
                assert!(dispatch.definitely_failed());
            });
    }

    #[test]
    fn a_validation_refusal_names_the_field_it_refused() {
        for (body, kind) in [
            (
                r#"{"message":"Validation Failed","errors":[{"field":"head","code":"invalid"}]}"#,
                Kind::HeadMissing,
            ),
            (
                r#"{"message":"Validation Failed","errors":[{"field":"base","code":"invalid"}]}"#,
                Kind::BaseMissing,
            ),
            (
                r#"{"message":"Validation Failed","errors":[{"code":"already_exists","message":"name already exists"}]}"#,
                Kind::Conflict,
            ),
            (
                r#"{"message":"Validation Failed","errors":[{"field":"head","code":"missing"}]}"#,
                Kind::Unprocessable,
            ),
            (
                r#"{"message":"Validation Failed","errors":["No commits between main and work"]}"#,
                Kind::NoCommits,
            ),
            (
                r#"{"message":"Validation Failed","errors":[{"field":"head","code":"invalid"},{"message":"A pull request already exists for octo:work"}]}"#,
                Kind::PrExists,
            ),
            (
                r#"{"message":"Pull Request is not mergeable","errors":[{"code":"other"}]}"#,
                Kind::Unprocessable,
            ),
        ] {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime")
                .block_on(async {
                    let stub = stub(&[&api(body, "").replace("200 OK", "422 Unprocessable")]);
                    let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                    let dispatch = std::sync::Arc::new(
                        crate::transport::mutation::MutationDispatch::new(None),
                    );
                    let error = api_client
                        .request(
                            "repos/octo/ace/pulls",
                            Some(json!({ "title": "x" })),
                            None,
                            None,
                            dispatch,
                        )
                        .await
                        .expect_err("refused");
                    assert_eq!(error.kind, kind, "{body}");
                });
        }
    }

    #[test]
    fn a_merge_refused_with_405_is_a_conflict() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let stub = stub(&[&api(r#"{"message":"Pull Request is not mergeable"}"#, "")
                    .replace("200 OK", "405 Method Not Allowed")]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let dispatch =
                    std::sync::Arc::new(crate::transport::mutation::MutationDispatch::new(None));
                let outcome = api_client
                    .request(
                        "repos/octo/ace/pulls/7/merge",
                        Some(json!({ "merge_method": "squash" })),
                        Some("PUT"),
                        None,
                        dispatch.clone(),
                    )
                    .await;
                assert_eq!(outcome.expect_err("refused").kind, Kind::Conflict);
                assert!(dispatch.definitely_failed());
            });
    }

    #[test]
    fn a_secondary_rate_limit_403_is_rate_limited_before_forbidden() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let limited = stub(&[&api(
                    r#"{"message":"You have exceeded a secondary rate limit"}"#,
                    "Retry-After: 30\r\n",
                )
                .replace("200 OK", "403 Forbidden")]);
                let api_client =
                    GhApi::new(&limited, "github.com", std::sync::Arc::new(|| 1_000.0));
                let error = api_client
                    .request("user", None, None, None, Default::default())
                    .await
                    .expect_err("limited");
                assert_eq!(error.kind, Kind::RateLimit);
                assert_eq!(error.retry_at, Some(31_000.0));
                let forbidden =
                    stub(&[&api(r#"{"message":"Bad credentials"}"#, "")
                        .replace("200 OK", "403 Forbidden")]);
                let api_client =
                    GhApi::new(&forbidden, "github.com", std::sync::Arc::new(|| 1_000.0));
                let error = api_client
                    .request("user", None, None, None, Default::default())
                    .await
                    .expect_err("forbidden");
                assert_eq!(error.kind, Kind::Forbidden);
                assert_eq!(error.status, Some(403));
            });
    }

    #[test]
    fn a_304_keeps_the_cached_link_header() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let first = api(
                    r#"[]"#,
                    "ETag: \"v1\"\r\nLink: <https://api.github.com/x?page=2>; rel=\"next\"\r\n",
                );
                let stub = stub(&[
                    first.as_str(),
                    "HTTP/2.0 304 Not Modified\r\nETag: \"v2\"\r\nX-Poll-Interval: 60\r\n\r\n",
                ]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                api_client
                    .request("user/repos", None, None, None, Default::default())
                    .await
                    .expect("first");
                let second = api_client
                    .request("user/repos", None, None, None, Default::default())
                    .await
                    .expect("cached");
                assert!(second.header("link").is_some(), "{:?}", second.headers);
                assert_eq!(second.header("etag"), Some("\"v1\""));
                assert_eq!(second.header("x-poll-interval"), Some("60"));
            });
    }

    #[test]
    fn an_authorisation_error_path_is_not_a_missing_field() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let body = api(
                    r#"{"data":{"r0":null},"errors":[{"type":"FORBIDDEN","path":["r0"]}]}"#,
                    "",
                );
                let stub = stub(&[body.as_str()]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                let error = api_client
                    .request(
                        "graphql",
                        Some(json!({ "query": "query { r0 }" })),
                        None,
                        None,
                        Default::default(),
                    )
                    .await
                    .expect_err("refused");
                assert_eq!(error.kind, Kind::Forbidden);
            });
    }

    #[test]
    fn a_missing_field_across_a_nested_path_is_tolerated() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(async {
                let body = api(
                    r#"{"data":{"repository":{"pullRequest":null}},"errors":[{"type":"NOT_FOUND","path":["repository","pullRequest"]}]}"#,
                    "",
                );
                let stub = stub(&[body.as_str()]);
                let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
                api_client
                    .request(
                        "graphql",
                        Some(json!({ "query": "query { repository { pullRequest } }" })),
                        None,
                        None,
                        Default::default(),
                    )
                    .await
                    .expect("a read may name a missing field");
            });
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
            let api_client = GhApi::new(&stub, "github.com", std::sync::Arc::new(|| 0.0));
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
