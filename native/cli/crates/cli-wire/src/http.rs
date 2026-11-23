// SPDX-License-Identifier: Apache-2.0
//! Blocking HTTP/1.1 client for daemon `/v1/*` JSON endpoints backed by `ureq` v3.
//!
//! Matches `accessRequest` in `apps/daemon/src/client-access.ts` and `accessResponseError` in
//! `packages/client/src/access-http.ts`: 1 MiB response cap, 10 s timeout cap, pinned `rustls`
//! (`ring`) for remote origins, and zero-reencode [`serde_json::value::RawValue`] bodies.

use std::io;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use ureq::config::Config;
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::{Connector, TcpConnector};
use ureq::{Agent, Error as UreqError};

use crate::error::WireError;
use crate::home::Local;
use crate::profile::{DirectRemote, SocketTicket};
use crate::tls::{TlsPinConfig, build_pinned_rustls_config, classify_rustls_error};
use crate::types::Token;
use crate::ureq_tls::PinnedTlsConnector;

/// Maximum response body accepted from `/v1/*` endpoints (1 MiB, matching `client-access.ts`).
pub const MAX_HTTP_RESPONSE_BYTES: usize = 1_048_576;

/// Maximum header block size accepted in an HTTP response (32 KiB).
pub const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;

/// Default and maximum timeout for `/v1/*` access requests (10 s, matching `client-access.ts`).
pub const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

const MAX_ERROR_DETAIL_CHARS: usize = 512;

/// HTTP methods used by ace CLI `/v1/*` calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
}

impl HttpMethod {
    /// Wire method token.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
        }
    }
}

/// Successful (`HTTP 200`) JSON response from a daemon `/v1/*` endpoint.
///
/// The JSON payload is stored verbatim as a [`RawValue`] so `--json` output can write it directly
/// without decoding and re-encoding, while human output can deserialize borrowed fields on demand.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    status: u16,
    body: Box<RawValue>,
}

impl HttpResponse {
    pub(crate) const fn new(status: u16, body: Box<RawValue>) -> Self {
        Self { status, body }
    }

    /// HTTP status code (always `200` for successful access responses).
    #[must_use]
    pub const fn status(&self) -> u16 {
        self.status
    }

    /// Raw validated JSON payload.
    #[must_use]
    pub fn raw(&self) -> &RawValue {
        &self.body
    }

    /// Raw validated JSON payload as a string slice.
    #[must_use]
    pub fn as_str(&self) -> &str {
        self.body.get()
    }

    /// Consumes the response and returns the owned [`RawValue`].
    #[must_use]
    pub fn into_raw(self) -> Box<RawValue> {
        self.body
    }

    /// Decodes the JSON payload into a caller-chosen type (borrowing from `self` when possible).
    pub fn decode<'a, T: Deserialize<'a>>(&'a self) -> Result<T, WireError> {
        serde_json::from_str(self.body.get()).map_err(|err| WireError::Protocol {
            detail: format!("Failed to decode HTTP JSON response: {err}"),
        })
    }
}

/// Sends a blocking HTTP/1.1 request to the local loopback daemon's `/v1/*` endpoint.
pub fn http_request_local(
    local: &Local,
    method: HttpMethod,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<HttpResponse, WireError> {
    validate_http_path(path)?;
    let agent = Agent::new_with_config(base_config(timeout, false));
    let url = local.origin().endpoint_url(path);
    send_request(&agent, &url, method, Some(local.token()), body, true)
}

/// Serializes `body` as JSON and sends a blocking HTTP/1.1 request to the local loopback daemon.
pub fn http_request_local_json<B: Serialize>(
    local: &Local,
    method: HttpMethod,
    path: &str,
    body: &B,
    timeout: Duration,
) -> Result<HttpResponse, WireError> {
    let encoded = serde_json::to_vec(body).map_err(|err| WireError::Protocol {
        detail: format!("Failed to encode HTTP request body: {err}"),
    })?;
    http_request_local(local, method, path, Some(&encoded), timeout)
}

/// Sends a blocking pinned-HTTPS `/v1/*` request to a direct remote daemon.
pub fn http_request_remote(
    direct: &DirectRemote<'_>,
    method: HttpMethod,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<HttpResponse, WireError> {
    let tls = TlsPinConfig::new(direct.fingerprint.clone());
    http_request_remote_with_tls(direct, &tls, method, path, body, timeout)
}

/// Sends a blocking pinned-HTTPS `/v1/*` request using an explicit [`TlsPinConfig`] (for custom
/// clocks or `.ts.net` fallback roots).
pub fn http_request_remote_with_tls(
    direct: &DirectRemote<'_>,
    tls: &TlsPinConfig,
    method: HttpMethod,
    path: &str,
    body: Option<&[u8]>,
    timeout: Duration,
) -> Result<HttpResponse, WireError> {
    validate_http_path(path)?;
    let rustls_config = build_pinned_rustls_config(tls)?;
    let connector = TcpConnector::default().chain(PinnedTlsConnector::new(rustls_config));
    let agent = Agent::with_parts(
        base_config(timeout, true),
        connector,
        DefaultResolver::default(),
    );
    let url = direct.origin.endpoint_url(path);
    send_request(&agent, &url, method, Some(direct.token), body, false)
}

/// Exchanges a paired remote device token for a single-use WebSocket ticket (`POST /v1/tickets`).
pub fn exchange_ticket(
    direct: &DirectRemote<'_>,
    timeout: Duration,
) -> Result<SocketTicket, WireError> {
    let tls = TlsPinConfig::new(direct.fingerprint.clone());
    exchange_ticket_with_tls(direct, &tls, timeout)
}

/// Exchanges a paired remote device token for a single-use WebSocket ticket using an explicit
/// [`TlsPinConfig`].
pub fn exchange_ticket_with_tls(
    direct: &DirectRemote<'_>,
    tls: &TlsPinConfig,
    timeout: Duration,
) -> Result<SocketTicket, WireError> {
    let response =
        http_request_remote_with_tls(direct, tls, HttpMethod::Post, "/v1/tickets", None, timeout)?;
    SocketTicket::from_json(response.as_str())
}

/// Validates a `/v1/*` request path (no credentials, query, fragment, or control bytes).
pub(crate) fn validate_http_path(path: &str) -> Result<(), WireError> {
    if !path.starts_with('/')
        || path.contains(['?', '#'])
        || path.bytes().any(|b| b.is_ascii_control() || b == b' ')
    {
        return Err(WireError::InvalidTarget {
            detail: "Credentials and query strings must not be placed in request paths".into(),
        });
    }
    Ok(())
}

fn base_config(timeout: Duration, https_only: bool) -> Config {
    let clamped = timeout.clamp(Duration::from_millis(1), DEFAULT_HTTP_TIMEOUT);
    Config::builder()
        .http_status_as_error(false)
        .https_only(https_only)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .proxy(None)
        .max_idle_connections(0)
        .max_response_header_size(MAX_HTTP_HEADER_BYTES)
        .timeout_global(Some(clamped))
        .build()
}

fn send_request(
    agent: &Agent,
    url: &str,
    method: HttpMethod,
    token: Option<&Token>,
    body: Option<&[u8]>,
    is_local: bool,
) -> Result<HttpResponse, WireError> {
    let mut builder = ureq::http::Request::builder()
        .method(method.as_str())
        .uri(url)
        .header("Accept", "application/json");
    if let Some(tok) = token {
        builder = builder.header("Authorization", format!("Bearer {}", tok.as_str()));
    }
    if body.is_some() {
        builder = builder.header("Content-Type", "application/json");
    }
    let request = builder
        .body(body.unwrap_or(&[]))
        .map_err(|err| WireError::InvalidTarget {
            detail: format!("Invalid HTTP request: {err}"),
        })?;

    let response = agent
        .run(request)
        .map_err(|err| classify_ureq_error(err, is_local))?;
    let status = response.status().as_u16();
    let body_text = response
        .into_body()
        .into_with_config()
        .limit(MAX_HTTP_RESPONSE_BYTES as u64)
        .read_to_string()
        .map_err(|err| classify_ureq_error(err, is_local))?;
    finish_http_response(status, body_text)
}

fn finish_http_response(status: u16, body_text: String) -> Result<HttpResponse, WireError> {
    if status != 200 {
        return Err(map_http_status_error(status, &body_text));
    }
    let raw = RawValue::from_string(body_text).map_err(|err| WireError::Protocol {
        detail: format!("Daemon returned malformed JSON: {err}"),
    })?;
    Ok(HttpResponse::new(status, raw))
}

/// Maps non-200 HTTP responses matching `accessResponseError` + `accessFailure` in TypeScript.
fn map_http_status_error(status: u16, body: &str) -> WireError {
    #[derive(Deserialize)]
    struct AccessFailureBody<'a> {
        #[serde(borrow)]
        error: Option<&'a str>,
    }

    let detail = serde_json::from_str::<AccessFailureBody<'_>>(body)
        .ok()
        .and_then(|parsed| parsed.error)
        .filter(|msg| !msg.is_empty())
        .map_or_else(
            || format!("HTTP {status}"),
            |msg| {
                let truncated: String = msg.chars().take(MAX_ERROR_DETAIL_CHARS).collect();
                format!("HTTP {status}: {truncated}")
            },
        );

    if status == 401 || status == 403 {
        WireError::Auth {
            detail,
            revoked: false,
        }
    } else if status == 429 || status >= 500 {
        WireError::Offline { detail }
    } else {
        WireError::Daemon {
            code: "http".into(),
            message: detail,
        }
    }
}

/// Maps `ureq` transport errors matching `accessRequest` in `apps/daemon/src/client-access.ts`:
/// HTTP timeouts and transport errors become `offline` (`uncertain`, exit 5), while local
/// `ConnectionRefused` maps to `daemon_down` (exit 4).
fn classify_ureq_error(err: UreqError, is_local: bool) -> WireError {
    match err {
        UreqError::Timeout(_) | UreqError::BodyStalled | UreqError::HostNotFound => {
            WireError::Offline {
                detail: "Access transport unavailable".into(),
            }
        }
        UreqError::Rustls(tls_err) => classify_rustls_error(&tls_err),
        UreqError::Tls(msg) => WireError::Auth {
            detail: msg.into(),
            revoked: false,
        },
        UreqError::BodyExceedsLimit(_) | UreqError::LargeResponseHeader(..) => WireError::Limit {
            detail: "Response exceeded size limit".into(),
        },
        UreqError::Io(io_err) => classify_ureq_io_error(&io_err, is_local),
        UreqError::ConnectionFailed => {
            if is_local {
                WireError::DaemonDown
            } else {
                WireError::Offline {
                    detail: "Access transport unavailable".into(),
                }
            }
        }
        other => WireError::Protocol {
            detail: other.to_string(),
        },
    }
}

fn classify_ureq_io_error(err: &io::Error, is_local: bool) -> WireError {
    if let Some(tls_err) = err
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        return classify_rustls_error(tls_err);
    }
    if is_local && err.kind() == io::ErrorKind::ConnectionRefused {
        return WireError::DaemonDown;
    }
    WireError::Offline {
        detail: "Access transport unavailable".into(),
    }
}
