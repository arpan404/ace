//! Bots on the person's subscriptions (ADR 0133, docs/cli-brains.md): what they can think with,
//! and each bot's MCP server, which ace calls for the bot's CLI session (`spade_tools`,
//! `spade_call`). The server answers JSON-RPC over plain POSTs: `initialize`, `tools/list` and
//! `tools/call`, each with one JSON answer.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{AppState, problem};

/// The MCP revision the bot's server speaks.
const PROTOCOL: &str = "2025-11-25";

pub(super) fn routes() -> Router<AppState> {
    Router::new()
        .route("/subscriptions", get(subscriptions))
        .route("/agents/{id}/mcp", post(mcp))
}

/// `{"providers": [...]}` from ace, or none with `error` when ace can't say.
async fn subscriptions(State(state): State<AppState>) -> Response {
    match state.engine.subscriptions().await {
        Ok(providers) => Json(json!({ "providers": providers, "error": null })).into_response(),
        Err(error) => Json(json!({ "providers": [], "error": error })).into_response(),
    }
}

#[derive(Deserialize)]
struct Rpc {
    #[serde(default)]
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

async fn mcp(State(state): State<AppState>, Path(agent): Path<String>, body: String) -> Response {
    let Ok(rpc) = serde_json::from_str::<Rpc>(&body) else {
        return problem(StatusCode::BAD_REQUEST, "not a JSON-RPC request");
    };
    let id = rpc.id.clone();
    let answer = |result: Value| Json(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    match rpc.method.as_str() {
        "initialize" => answer(json!({
            "protocolVersion": PROTOCOL,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "spade", "version": crate::home::VERSION },
        }))
        .into_response(),
        "notifications/initialized" | "ping" => answer(json!({})).into_response(),
        "tools/list" => {
            let query = rpc.params.get("query").and_then(Value::as_str);
            let Some(tools) = state.engine.brain_tools(&agent, query) else {
                return problem(StatusCode::NOT_FOUND, "no such agent");
            };
            let tools: Vec<Value> = tools
                .into_iter()
                .map(|tool| {
                    json!({
                        "name": tool.name,
                        "description": tool.description,
                        "inputSchema": tool.schema,
                    })
                })
                .collect();
            answer(json!({ "tools": tools })).into_response()
        }
        "tools/call" => {
            let Some(name) = rpc.params.get("name").and_then(Value::as_str) else {
                return problem(StatusCode::BAD_REQUEST, "tools/call needs a name");
            };
            let arguments = rpc
                .params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            // Which frame of the turn's answer the call follows (ace stamps it).
            let after = rpc
                .params
                .pointer("/_meta/dev.acehq.spade~1seq")
                .and_then(Value::as_u64);
            let Some(output) = state
                .engine
                .brain_call(&agent, name.to_owned(), arguments, after)
                .await
            else {
                return problem(StatusCode::NOT_FOUND, "no such agent");
            };
            answer(json!({
                "content": [{ "type": "text", "text": output.content }],
                "isError": output.is_error,
            }))
            .into_response()
        }
        other => Json(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("unknown method {other}") },
        }))
        .into_response(),
    }
}
