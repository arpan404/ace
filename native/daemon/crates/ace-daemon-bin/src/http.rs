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
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::net::TcpListener;

use crate::receipt::Admission;

/// A JSON body's largest accepted size: `optionalBody`'s 16 KiB.
const BODY_LIMIT: usize = 16_384;

/// What the server reads and reports.
pub struct HttpConfig {
    pub token: String,
    pub version: String,
    /// Origins whose pages may read the cross-origin routes (`webOriginAllowlist`).
    pub allowed_origins: Vec<String>,
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
    if hop != state.hop_secret {
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
    let cross_origin = path == "/v1/status";
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
        .unwrap_or("");
    let host = crate::token::valid_token(token, &state.config.token);
    let mut response = match (path.as_str(), request.method()) {
        ("/v1/status", &Method::GET) => {
            if !host {
                json_body(
                    StatusCode::FORBIDDEN,
                    &json!({"error": "Admin scope required"}),
                )
            } else {
                let body = json!({
                    "running": true,
                    "ready": true,
                    "version": state.config.version,
                    "remote": serde_json::Value::Null,
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

/// `POST /v1/stop`: parse the optional body, write the receipt, answer, then stop.
async fn stop_request(state: &HttpState, request: Request<Incoming>) -> Response {
    let collected = match request.into_body().collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            return json_body(
                StatusCode::BAD_REQUEST,
                &json!({"error": format!("Request failed: {error}")}),
            );
        }
    };
    if collected.len() > BODY_LIMIT {
        return json_body(
            StatusCode::PAYLOAD_TOO_LARGE,
            &json!({"error": "Request too large"}),
        );
    }
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
