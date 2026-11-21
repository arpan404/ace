//! The person's own agents reaching Spade's contracts through ace (ADR 0202 §3, §6), for the
//! outside-contracts tests: a small stand-in for ace's daemon's forwarding (its grants, scope
//! and card signing are tested in the daemon), which takes one bearer per grant and signs each
//! request with ace's token as the daemon does, and the clients' helpers.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use serde_json::{Map, Value, json};
use spade_mcp::serve::KEY_META;
use spade_mcp::{McpClient, McpConfig, Secret};
use spade_server::engine::OutsideCaller;
use spade_server::outside::a2a::EXTENSION;
use spade_server::teams::proof::{Forwarded, OUTSIDE_HEADERS, outside_proof};
use spade_testkit::Script;

use super::contracts::{World, install, world_in};
use super::{Options, Result, TOKEN};

/// ace's local token in its home, which signs what the daemon forwards.
pub const DAEMON_TOKEN: &str = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
/// Two grants with `spade-contracts`, each with its bearer and its client's name as the daemon
/// stamps it (percent-encoded), as ace keeps them.
pub const GRANTS: [(&str, &str, &str); 2] = [
    ("bearer-one", "g_one", "Claude Code"),
    ("bearer-two", "g_two", "Other%20agent"),
];
pub const TOOL: &str = "flight_watcher__cheapest_fare";

pub fn fare() -> Value {
    json!({ "fare": 182, "currency": "USD" })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The id Spade gives grant `grant`'s call with key `key`.
pub fn call_of(grant: &str, key: &str) -> String {
    OutsideCaller {
        grant: grant.to_owned(),
        name: String::new(),
    }
    .call_id(key)
}

/// A fresh nonce for each stamp, as the daemon makes one.
pub fn nonce() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("test-nonce-{:016}", NEXT.fetch_add(1, Ordering::SeqCst))
}

/// The headers ace's daemon signs a request it forwards with, for `host` named `name`: `method`
/// to Spade's `route`, with the protocol headers `mirrored` (name, value) it passes on.
pub fn stamp(
    host: &str,
    name: &str,
    method: &str,
    route: &str,
    mirrored: &[(&str, &str)],
    body: &[u8],
    key: &str,
) -> Vec<(&'static str, String)> {
    let time = now_ms();
    let nonce = nonce();
    let headers = OUTSIDE_HEADERS.map(|header| {
        mirrored
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(header))
            .map(|(_, v)| *v)
    });
    let forwarded = Forwarded {
        time,
        nonce: &nonce,
        method,
        route,
        sender: host,
        name,
        headers,
        body,
    };
    vec![
        ("x-ace-from-host", host.to_owned()),
        ("x-ace-from-name", name.to_owned()),
        ("x-ace-inbox-time", time.to_string()),
        ("x-ace-outside-nonce", nonce.clone()),
        (
            "x-ace-inbox-proof",
            outside_proof(key, &forwarded).unwrap_or_default(),
        ),
    ]
}

/// The stand-in daemon: `/mcp`, `/a2a` and `/card` for a client holding a grant's bearer.
pub async fn forward(
    State(spade): State<String>,
    method: Method,
    uri: axum::http::Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let Some((_, grant, name)) = GRANTS.iter().find(|(b, ..)| Some(*b) == bearer) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let path = match (method.as_str(), uri.path()) {
        ("POST", "/mcp") => "/v1/outside/mcp",
        ("POST", "/a2a") => "/v1/outside/a2a",
        ("GET", "/card") => "/v1/outside/card",
        _ => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    };
    let mirrored: Vec<(&str, &str)> = OUTSIDE_HEADERS
        .iter()
        .filter_map(|h| Some((*h, headers.get(*h)?.to_str().ok()?)))
        .collect();
    let stamped = stamp(
        &format!("ace:outside:{grant}"),
        name,
        method.as_str(),
        path,
        &mirrored,
        &body,
        DAEMON_TOKEN,
    );
    let mut request = reqwest::Client::new()
        .request(method, format!("{spade}{path}"))
        .bearer_auth(TOKEN);
    for (header, value) in stamped {
        request = request.header(header, value);
    }
    for (header, value) in &mirrored {
        request = request.header(*header, *value);
    }
    if let Some(value) = headers.get("content-type") {
        request = request.header("content-type", value.clone());
    }
    let Ok(answer) = request.body(body).send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let status = StatusCode::from_u16(answer.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let kind = answer
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    let bytes = answer.bytes().await.unwrap_or_default();
    (status, [("content-type", kind)], bytes).into_response()
}

pub struct Daemon {
    pub url: String,
}

pub async fn daemon(spade: &str) -> Result<Daemon> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let app = Router::new()
        .fallback(any(forward))
        .with_state(spade.to_owned());
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(Daemon { url })
}

/// Flight watcher and a Trip planner that never calls, on a Spade beside ace's home, with the
/// stand-in daemon in front. `watcher` is given nothing: the call ids are the clients'.
pub async fn world(
    watcher: Vec<Script>,
    tools: Vec<Arc<dyn spade_server::tools::Tool>>,
) -> Result<(World, Daemon)> {
    let home = tempfile::tempdir()?.keep();
    std::fs::write(home.join("daemon-token"), format!("{DAEMON_TOKEN}\n"))?;
    let options = Options {
        ace_home: Some(home),
        ..Options::default()
    };
    let world = world_in(options, install(), Vec::new(), |_| watcher, tools).await?;
    let daemon = daemon(&world.spade.base).await?;
    Ok((world, daemon))
}

pub fn mcp_client(daemon: &Daemon, bearer: &str) -> McpClient {
    McpClient::new(
        McpConfig::new(format!("{}/mcp", daemon.url), Duration::from_secs(30))
            .bearer(Secret::new(bearer.to_owned()))
            .direct(),
    )
}

pub fn keyed(key: &str) -> Map<String, Value> {
    let mut meta = Map::new();
    meta.insert(KEY_META.to_owned(), json!(key));
    meta
}

/// Each call delivered to the watcher, as its conversation holds it.
pub fn deliveries(events: &[Value]) -> Vec<&Value> {
    events
        .iter()
        .filter(|e| e["type"] == "user_message" && e["from_agent"]["contract"].is_object())
        .collect()
}

pub async fn a2a(
    daemon: &Daemon,
    bearer: &str,
    version: Option<&str>,
    method: &str,
    params: Value,
) -> Result<Value> {
    let mut request = reqwest::Client::new()
        .post(format!("{}/a2a", daemon.url))
        .bearer_auth(bearer)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }));
    if let Some(version) = version {
        request = request.header("A2A-Version", version);
    }
    Ok(request.send().await?.json().await?)
}

pub fn message(id: &str, skill: &str, data: Value) -> Value {
    json!({
        "message": {
            "messageId": id,
            "role": "ROLE_USER",
            "parts": [{ "data": data, "mediaType": "application/json" }],
            "metadata": { EXTENSION: { "skill": skill } },
        }
    })
}
