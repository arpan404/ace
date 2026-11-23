// SPDX-License-Identifier: Apache-2.0
//! Minimal blocking HTTP/1.1 client for daemon `/v1/*` JSON endpoints.
//!
//! Matches `accessRequest` in `apps/daemon/src/client-access.ts` and `accessResponseError` in
//! `packages/client/src/access-http.ts`: 1 MiB response cap, Content-Length and chunked transfer
//! decoding, deadline enforcement, and zero-reencode [`serde_json::value::RawValue`] bodies.

use std::io::{BufReader, Read, Write};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

use crate::error::WireError;
use crate::home::Local;
use crate::http_parse::{finish_http_response, read_http_response};
use crate::stream::{TransportStream, classify_io_error, connect_local_tcp};
use crate::types::Token;

/// Maximum response body accepted from `/v1/*` endpoints (1 MiB, matching `client-access.ts`).
pub const MAX_HTTP_RESPONSE_BYTES: usize = 1_048_576;

/// Maximum header block size accepted in an HTTP response (32 KiB).
pub const MAX_HTTP_HEADER_BYTES: usize = 32 * 1024;

/// Default and maximum timeout for `/v1/*` access requests (10 s, matching `client-access.ts`).
pub const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(10);

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
    let clamped = clamp_http_timeout(timeout);
    let deadline = Instant::now() + clamped;
    let tcp = connect_local_tcp(local.origin().socket_addr(), deadline)?;
    let mut stream = TransportStream::Plain(tcp);
    stream.apply_deadline(deadline, "Request")?;
    let host_header = local.origin().host_header();
    let result = execute_http(
        &mut stream,
        &host_header,
        method,
        path,
        Some(local.token()),
        body,
    );
    stream.shutdown_both();
    result
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

/// Executes one HTTP/1.1 request/response exchange over an already-connected stream.
pub fn execute_http<S: Read + Write>(
    stream: &mut S,
    host_header: &str,
    method: HttpMethod,
    path: &str,
    token: Option<&Token>,
    body: Option<&[u8]>,
) -> Result<HttpResponse, WireError> {
    validate_http_path(path)?;
    let request_bytes = build_http_request(method, host_header, path, token, body);
    stream
        .write_all(&request_bytes)
        .map_err(|err| classify_io_error(&err, "Request"))?;
    stream
        .flush()
        .map_err(|err| classify_io_error(&err, "Request"))?;
    let mut reader = BufReader::with_capacity(8192, stream);
    let (status, response_body) = read_http_response(&mut reader)?;
    finish_http_response(status, response_body)
}

/// Clamps caller timeout into `1 ms..=10 s`, matching `accessRequest` in `client-access.ts`.
#[must_use]
pub fn clamp_http_timeout(timeout: Duration) -> Duration {
    timeout.clamp(Duration::from_millis(1), DEFAULT_HTTP_TIMEOUT)
}

/// Validates a `/v1/*` request path: leading `/`, no query, fragment, whitespace, or CR/LF.
pub fn validate_http_path(path: &str) -> Result<(), WireError> {
    if !path.starts_with('/') || path.starts_with("//") {
        return Err(WireError::InvalidTarget {
            detail: "HTTP request path must start with a single '/'".into(),
        });
    }
    if path.contains(['?', '#']) {
        return Err(WireError::InvalidTarget {
            detail: "Credentials or queries must not be placed in request URLs".into(),
        });
    }
    if path.bytes().any(|b| b <= 0x20 || b == 0x7f) {
        return Err(WireError::InvalidTarget {
            detail: "HTTP request path contains invalid control or whitespace characters".into(),
        });
    }
    Ok(())
}

/// Formats an HTTP/1.1 request with `Connection: close`, optional Bearer token, and optional JSON body.
#[must_use]
pub fn build_http_request(
    method: HttpMethod,
    host_header: &str,
    path: &str,
    token: Option<&Token>,
    body: Option<&[u8]>,
) -> Vec<u8> {
    let body_len = body.map_or(0, <[u8]>::len);
    let mut out = Vec::with_capacity(192 + path.len() + host_header.len() + body_len);
    let _ = write!(
        out,
        "{} {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\nAccept: application/json\r\n",
        method.as_str()
    );
    if let Some(tok) = token {
        let _ = write!(out, "Authorization: Bearer {}\r\n", tok.as_str());
    }
    if let Some(bytes) = body {
        let _ = write!(
            out,
            "Content-Type: application/json\r\nContent-Length: {}\r\n",
            bytes.len()
        );
    }
    out.extend_from_slice(b"\r\n");
    if let Some(bytes) = body {
        out.extend_from_slice(bytes);
    }
    out
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::thread;

    use super::*;
    use crate::origin::LocalOrigin;

    #[test]
    fn path_validation_rejects_queries_fragments_and_control_chars() {
        assert!(validate_http_path("/v1/status").is_ok());
        assert!(validate_http_path("/v1/devices/dev_1").is_ok());
        for bad in [
            "v1/status",
            "//evil.example/v1/status",
            "/v1/status?token=abc",
            "/v1/status#frag",
            "/v1/status\r\nX-Inject: 1",
            "/v1/status HTTP/1.1",
        ] {
            assert!(validate_http_path(bad).is_err(), "expected invalid: {bad}");
        }
    }

    #[test]
    fn local_http_request_round_trips_over_loopback_tcp() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let expected_token = "a".repeat(64);
        let token_clone = expected_token.clone();

        let server = thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut req = [0u8; 1024];
            let n = sock.read(&mut req).unwrap();
            let text = std::str::from_utf8(&req[..n]).unwrap();
            assert!(text.starts_with("GET /v1/status HTTP/1.1\r\n"));
            assert!(text.contains(&format!("Authorization: Bearer {token_clone}\r\n")));
            let body = r#"{"running":true,"ready":true,"version":"0.1.0"}"#;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(resp.as_bytes()).unwrap();
        });

        let local = Local::new(
            LocalOrigin::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
            Token::parse(expected_token).unwrap(),
        );
        let reply = http_request_local(
            &local,
            HttpMethod::Get,
            "/v1/status",
            None,
            Duration::from_secs(2),
        )
        .unwrap();
        assert_eq!(
            reply.as_str(),
            r#"{"running":true,"ready":true,"version":"0.1.0"}"#
        );
        server.join().unwrap();
    }

    #[test]
    fn local_http_request_times_out_when_server_stalls() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = thread::spawn(move || {
            let (_sock, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(300));
        });

        let local = Local::new(
            LocalOrigin::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
            Token::parse("b".repeat(64)).unwrap(),
        );
        let err = http_request_local(
            &local,
            HttpMethod::Get,
            "/v1/status",
            None,
            Duration::from_millis(60),
        )
        .unwrap_err();
        assert!(matches!(err, WireError::Timeout { .. }));
        assert_eq!(err.exit_code(), 3);
        server.join().unwrap();
    }
}
