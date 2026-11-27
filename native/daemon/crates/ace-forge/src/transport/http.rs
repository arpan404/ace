// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! `GhApi` (`http.ts`): GitHub requests through `gh api --include`, with `--include` parsing,
//! ETag and `If-Modified-Since` reuse, a GraphQL cache keyed by the document's SHA-256, cache
//! clearing on writes, `x-poll-interval`, and the fixed error categories. Every body is
//! redacted before it is cached or returned (`redact.ts`, ADR 0224 §8a).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ace_json::Value;

use crate::transport::command::{Cancellation, CommandRequest, CommandResult, Mode, Runner};
use crate::transport::error::{ForgeError, Kind};
use crate::transport::http_errors::{
    assert_graphql_result, blank_line, decode_stack_merge_operation, headers_get, headers_of,
    markdown_rate_limited, merge_async_path, merge_path, no_response, parse_link_url,
    rate_limit_retry_at, rate_limited_body, safe_headers, sha256_hex, status_of,
    unprocessable_kind,
};
use crate::transport::mutation::{MutationDispatch, is_forge_mutation};
pub use crate::transport::redact::redact_data;

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
    now: Arc<dyn Fn() -> f64 + Send + Sync>,
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
        now: Arc<dyn Fn() -> f64 + Send + Sync>,
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

    /// The host this client targets.
    pub fn host(&self) -> &str {
        &self.host
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

    fn clear_cache(&self) {
        self.cache.lock().expect("cache lock").clear();
        self.order.lock().expect("cache order lock").clear();
        *self.cache_bytes.lock().expect("cache bytes lock") = 0;
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
            mode: Mode::Json,
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
            self.clear_cache();
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
            self.clear_cache();
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
            mode: Mode::Json,
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
            // (`http.ts:236-253`, `decodeStackMergeOperation` on the redacted body).
            let native_body = if method == "PUT" && merge_async_path(path) {
                ace_json::parse(text)
                    .ok()
                    .map(|parsed| self.redact_value(&parsed))
            } else {
                None
            };
            let operation = native_body.as_ref().and_then(decode_stack_merge_operation);
            let acknowledged = operation
                .is_some_and(|op| status != 409 || op.state != "uncertain" || op.uuid.is_some());
            if acknowledged && let Some(body) = native_body {
                let page = Page {
                    id: self
                        .next_page_id
                        .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                    body,
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
            self.redact_value(&parsed)
        };
        let page = Page {
            id: self
                .next_page_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst),
            body,
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

    /// Pattern, secret-key and child-environment redaction in one surrogate-preserving pass.
    fn redact_value(&self, value: &Value) -> Value {
        super::redact::redact_data_with_env(value, self.environment.as_ref())
    }

    /// Headers with the request's values masked; a validator that held one is dropped, so it
    /// can never return as `If-None-Match`/`If-Modified-Since`.
    fn mask_headers(&self, headers: &[(String, String)]) -> Vec<(String, String)> {
        let mut kept = safe_headers(headers);
        let Some(environment) = &self.environment else {
            return kept;
        };
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
        let mut cache = self.cache.lock().expect("cache lock");
        let mut order = self.order.lock().expect("cache order lock");
        let mut bytes = self.cache_bytes.lock().expect("cache bytes lock");
        // Completing a request replaces the entry actually retained, in place.
        if let Some(previous) = cache.remove(&key) {
            *bytes = bytes.saturating_sub(previous.bytes);
            order.retain(|held| held != &key);
        }
        // A page bigger than the whole cache is never retained (`http.ts:331`).
        if page.bytes > CACHE_BUDGET_BYTES {
            return;
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
        // GitHub may address the same resource by numeric repository id (`repositories/123/...`).
        // Only the resource below the repository may differ; the request stays scoped to the
        // named repository (`http.ts:424-427`).
        let named = requested
            .strip_prefix("repos/")
            .and_then(|rest| rest.split_once('/'))
            .and_then(|(_, rest)| rest.split_once('/').map(|(_, tail)| tail));
        let by_id = linked
            .strip_prefix("repositories/")
            .and_then(|rest| rest.split_once('/'))
            .filter(|(id, _)| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
            .map(|(_, tail)| tail);
        if let (Some(named), Some(by_id)) = (named, by_id)
            && !named.is_empty()
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
            mode: Mode::Json,
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
        if status == 429 || (status == 403 && markdown_rate_limited(body)) {
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
        tail_bytes: Option<usize>,
    ) -> Result<CommandResult, ForgeError> {
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
            mode: Mode::Tail,
            tail_bytes,
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

#[cfg(test)]
#[path = "http_tests.rs"]
mod tests;
