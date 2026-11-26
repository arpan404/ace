// SPDX-License-Identifier: Apache-2.0
//! The daemon's in-process HTTP server: the loopback listener's proxy target.
//!
//! Slice 1 serves the two routes a launcher and `ace stop` read before any
//! service exists: `GET /v1/status` and `POST /v1/stop` (`access-http.ts:144`–
//! `:232`). Every other path answers as the TypeScript chain answers an unknown
//! route: `404 {"error":"Unknown endpoint"}`, with its headers. CORS, the
//! maintenance gate and the remaining routes arrive with their owners.
//!
//! TypeScript cases ported: `apps/daemon/src/cli-stop.process.test.ts` ("`ace
//! stop` prints the receipt and the process is gone" and "a stop request without
//! the host token is refused"), `apps/daemon/src/access-cors.server.process.test.ts`
//! ("a preflight from an origin not on the allowlist is 403 Origin not allowed",
//! "an allowlisted origin gets the CORS headers and a 204 preflight"), and
//! `apps/daemon/src/lifecycle.process.test.ts` ("status reports the daemon
//! running and ready").

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http::{Method, Request, StatusCode};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::TcpListener;

use crate::receipt::Admission;

mod access;

/// One route's answer, before the shared headers.
pub(super) type Reply = (StatusCode, serde_json::Value);

/// Where a pairing link sends the device: this daemon's HTTPS address and the
/// key it pins. Absent while remote access is off (`POST /v1/pairings` is 409).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingOrigin {
    pub origin: String,
    pub fingerprint: String,
}

/// A JSON body's largest accepted size: `optionalBody`'s 16 KiB.
const BODY_LIMIT: usize = 16_384;

/// What the server reads and reports.
pub struct HttpConfig {
    pub version: String,
    /// Origins whose pages may read the cross-origin routes (`webOriginAllowlist`).
    pub allowed_origins: Vec<String>,
    /// The daemon's hello and device state, shared with the socket.
    pub auth: Arc<crate::auth::DaemonAuth>,
    /// Startup's gate: `/v1/status` reports whether the services are up.
    pub ready: Arc<std::sync::atomic::AtomicBool>,
    /// Set once the remote listener binds.
    pub pairing: Arc<std::sync::Mutex<Option<PairingOrigin>>>,
    /// Called once a stop request is accepted, after its answer is on the wire.
    pub on_stop: Arc<dyn Fn(Admission) + Send + Sync>,
}

/// The state one server answers from.
struct HttpState {
    config: HttpConfig,
    /// The hop's secret, so a request that did not come through the listener is
    /// refused; the internal port is loopback-only but still reachable locally.
    hop_secret: String,
}

/// A bound in-process server.
pub struct HttpServer {
    pub addr: SocketAddr,
    task: tokio::task::JoinHandle<()>,
}

impl HttpServer {
    /// Bind on loopback and serve until stopped.
    pub async fn bind(config: HttpConfig, hop_secret: String) -> std::io::Result<Self> {
        let state = Arc::new(HttpState { config, hop_secret });
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let addr = listener.local_addr()?;
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = listener.accept().await else {
                    continue;
                };
                let state = Arc::clone(&state);
                tokio::spawn(async move {
                    let service = service_fn(move |request: Request<Incoming>| {
                        let state = Arc::clone(&state);
                        async move { Ok::<_, Infallible>(answer(state, request).await) }
                    });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Ok(Self { addr, task })
    }

    /// Stop serving. The listener is closed first, so nothing new arrives here.
    pub fn stop(self) {
        self.task.abort();
    }
}

type Response = http::Response<Full<Bytes>>;

/// Equal bytes in constant time, so the loopback hop's secret cannot be learned
/// a byte at a time (`proxy-guard.ts:59`).
fn same_secret(actual: &[u8], expected: &[u8]) -> bool {
    if actual.len() != expected.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in actual.iter().zip(expected) {
        difference |= left ^ right;
    }
    difference == 0
}

fn json_body(status: StatusCode, body: &serde_json::Value) -> Response {
    let mut response = Response::new(Full::new(Bytes::from(body.to_string())));
    *response.status_mut() = status;
    common_headers(response)
}

fn common_headers(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert("cache-control", http::HeaderValue::from_static("no-store"));
    headers.insert(
        "referrer-policy",
        http::HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        "content-type",
        http::HeaderValue::from_static("application/json"),
    );
    headers.insert("vary", http::HeaderValue::from_static("Origin"));
    response
}

/// `access-http.ts`'s route table, reduced to what exists in slice 1.
async fn answer(state: Arc<HttpState>, request: Request<Incoming>) -> Response {
    let hop = request
        .headers()
        .get("x-ace-hop-secret")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    // The one secret the internal hop carries; compare in constant time.
    if !same_secret(hop.as_bytes(), state.hop_secret.as_bytes()) {
        return json_body(StatusCode::FORBIDDEN, &json!({"error": "Forbidden"}));
    }
    let origin = request
        .headers()
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let allowed = origin.as_ref().is_some_and(|origin| {
        state
            .config
            .allowed_origins
            .iter()
            .any(|allowed| allowed == origin)
    });
    let path = request.uri().path().to_owned();
    // `crossOrigin`: only these routes answer CORS, and only to the allowlist.
    let cross_origin = matches!(
        path.as_str(),
        "/v1/status" | "/v1/pair" | "/v1/tickets" | "/v1/devices" | "/v1/pairings"
    ) || path.starts_with("/v1/devices/");
    if cross_origin && request.method() == Method::OPTIONS {
        if !allowed {
            return json_body(
                StatusCode::FORBIDDEN,
                &json!({"error": "Origin not allowed"}),
            );
        }
        let mut response = Response::new(Full::new(Bytes::new()));
        *response.status_mut() = StatusCode::NO_CONTENT;
        response = common_headers(response);
        let headers = response.headers_mut();
        if let Some(origin) = &origin
            && let Ok(value) = http::HeaderValue::from_str(origin)
        {
            headers.insert("access-control-allow-origin", value);
        }
        headers.insert(
            "access-control-allow-methods",
            http::HeaderValue::from_static("GET, POST, DELETE"),
        );
        headers.insert(
            "access-control-allow-headers",
            http::HeaderValue::from_static("authorization, content-type"),
        );
        headers.insert(
            "access-control-max-age",
            http::HeaderValue::from_static("600"),
        );
        return response;
    }
    let token = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_owned();
    let token = token.as_str();
    let host = state.config.auth.local(token);
    let method = request.method().clone();
    let reply = |(status, body): Reply| json_body(status, &body);
    let mut response = match (path.as_str(), &method) {
        ("/v1/tickets", &Method::POST) => reply(access::ticket(&state, token)),
        ("/v1/devices", &Method::GET) => reply(access::devices(&state, token)),
        (path, &Method::DELETE) if path.starts_with("/v1/devices/") => {
            let id = &path["/v1/devices/".len()..];
            reply(access::revoke(&state, token, id))
        }
        ("/v1/pair", &Method::POST) => {
            let source = request
                .headers()
                .get("x-ace-hop-peer-address")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("unknown")
                .to_owned();
            match read_body(request, BODY_LIMIT).await {
                Ok(body) => reply(access::pair(&state, &body, &source)),
                Err(failure) => failure,
            }
        }
        ("/v1/pairings", &Method::POST) => match read_body(request, BODY_LIMIT).await {
            Ok(body) => reply(access::pairings(&state, token, &body)),
            Err(failure) => failure,
        },
        ("/v1/status", &Method::GET) => {
            // Any admin, as `access-http.ts:215` runs `requireAdmin` first.
            if !state.config.auth.is_admin(token) {
                json_body(
                    StatusCode::FORBIDDEN,
                    &json!({"error": "Admin scope required"}),
                )
            } else {
                let remote = state
                    .config
                    .pairing
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .clone()
                    .map(|pairing| {
                        json!({"origin": pairing.origin, "fingerprint": pairing.fingerprint})
                    });
                // `remote`: the LAN/Tailscale address a device pairs at, or null.
                let ready = state
                    .config
                    .ready
                    .load(std::sync::atomic::Ordering::Acquire);
                let body = json!({
                    "running": true,
                    "ready": ready,
                    "version": state.config.version,
                    "remote": remote,
                });
                json_body(StatusCode::OK, &body)
            }
        }
        ("/v1/stop", &Method::POST) => {
            if !host {
                json_body(
                    StatusCode::FORBIDDEN,
                    &json!({"error": "Host token required"}),
                )
            } else {
                stop_request(&state, request).await
            }
        }
        // Any other path is the chain's last handler: `Unknown endpoint`.
        _ => json_body(StatusCode::NOT_FOUND, &json!({"error": "Unknown endpoint"})),
    };
    if cross_origin
        && allowed
        && let Some(origin) = origin
        && let Ok(value) = http::HeaderValue::from_str(&origin)
    {
        response
            .headers_mut()
            .insert("access-control-allow-origin", value);
    }
    response
}

/// A request's body, refused the moment it passes `limit` (`optionalBody`): the
/// bytes are never collected past the cap, so an unauthenticated peer cannot make
/// the daemon hold a body larger than its route allows.
async fn read_body(request: Request<Incoming>, limit: usize) -> Result<Vec<u8>, Response> {
    use http_body_util::BodyExt as _;
    let mut body = request.into_body();
    let mut data = Vec::new();
    loop {
        let frame = body.frame().await;
        let Some(frame) = frame else {
            return Ok(data);
        };
        let frame = frame.map_err(|error| {
            json_body(
                StatusCode::BAD_REQUEST,
                &json!({"error": format!("Request failed: {error}")}),
            )
        })?;
        let Some(chunk) = frame.data_ref() else {
            continue;
        };
        if data.len() + chunk.len() > limit {
            return Err(json_body(
                StatusCode::PAYLOAD_TOO_LARGE,
                &json!({"error": "Request too large"}),
            ));
        }
        data.extend_from_slice(chunk);
    }
}

/// `POST /v1/stop`: parse the optional body, write the receipt, answer, then stop.
async fn stop_request(state: &HttpState, request: Request<Incoming>) -> Response {
    let collected = match read_body(request, BODY_LIMIT).await {
        Ok(body) => body,
        Err(failure) => return failure,
    };
    let text = String::from_utf8_lossy(&collected);
    let text = text.trim();
    let body = if text.is_empty() {
        json!({})
    } else {
        match serde_json::from_str::<serde_json::Value>(text) {
            Ok(body) => body,
            Err(_) => {
                return json_body(
                    StatusCode::BAD_REQUEST,
                    &json!({"error": "JSON object required"}),
                );
            }
        }
    };
    // `StopRequest.safeParse(...)`: a caller that is not a list of process
    // members is a bad request, never a partially read chain.
    if !valid_stop_request(&body) {
        return json_body(
            StatusCode::BAD_REQUEST,
            &json!({"error": "Invalid stop request"}),
        );
    }
    let id = match crate::ids::uuid_v4() {
        Ok(id) => id,
        Err(error) => {
            return json_body(
                StatusCode::INTERNAL_SERVER_ERROR,
                &json!({"error": format!("Request failed: {error}")}),
            );
        }
    };
    let admission = Admission { receipt_id: id };
    let response = json_body(
        StatusCode::OK,
        &serde_json::from_str(&admission.to_json()).unwrap_or(json!({"stopping": true})),
    );
    (state.config.on_stop)(admission);
    response
}

/// `StopRequest`: an optional `caller` of at most 64 members, each `{pid, start}`.
fn valid_stop_request(body: &serde_json::Value) -> bool {
    let Some(caller) = body.get("caller") else {
        return true;
    };
    let Some(members) = caller.as_array() else {
        return false;
    };
    members.len() <= 64
        && members.iter().all(|member| {
            member
                .get("pid")
                .and_then(serde_json::Value::as_i64)
                .is_some_and(|pid| pid > 0)
                && member
                    .get("start")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|start| !start.is_empty() && start.len() <= 128)
        })
}
