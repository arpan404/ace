// SPDX-License-Identifier: Apache-2.0
//! Codex's MCP server status read (`codexDiscoveryApi`'s pager in
//! `mcp-controls.ts`): bounded pages with checked cursors, then the servers ace
//! knows a state for.

use ace_json::{Map, Value};

use super::{McpControls, PAGE_MAX, PAGES_MAX, REQUEST_MS, SERVERS_MAX};
use crate::session::commands::settle;
use crate::session::frames::{Effect, Failure};
use crate::session::state::Session;

/// One status read in flight.
pub(super) struct StatusRead {
    pub(super) operation: u64,
    pub(super) thread: String,
    pub(super) call: u64,
    pub(super) visited: Vec<String>,
    pub(super) pages: u32,
    pub(super) servers: Vec<Value>,
}

impl Session {
    /// One status page: more pages, or the servers with ace's state applied.
    pub(super) fn status_settled(
        &mut self,
        mut read: StatusRead,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        let body = match reply {
            Ok(result) => result.as_object().cloned().unwrap_or_default(),
            Err(message) => {
                return settle(read.operation, Err(Failure::failed(message)));
            }
        };
        let Some(data) = body.get("data").and_then(Value::as_array) else {
            return settle(
                read.operation,
                Err(Failure::failed(
                    "MCP server status page is not Codex's shape",
                )),
            );
        };
        if data.len() > PAGE_MAX {
            return settle(
                read.operation,
                Err(Failure::failed(
                    "MCP server status page is not Codex's shape",
                )),
            );
        }
        if read.servers.len() + data.len() > SERVERS_MAX {
            return settle(
                read.operation,
                Err(Failure::failed("Discovery server capacity reached")),
            );
        }
        read.servers.extend(data.iter().cloned());
        let next = body
            .get("nextCursor")
            .and_then(Value::as_str)
            .filter(|next| !next.is_empty())
            .map(|next| next.to_owned());
        let Some(next) = next else {
            let servers = self.mcp.servers(&read.servers);
            return settle(read.operation, Ok(servers));
        };
        if read.visited.contains(&next) {
            return settle(
                read.operation,
                Err(Failure::failed("Repeated discovery cursor")),
            );
        }
        read.pages += 1;
        if read.pages >= PAGES_MAX {
            return settle(
                read.operation,
                Err(Failure::failed("Discovery page capacity reached")),
            );
        }
        read.visited.push(next.clone());
        let call = self.calls.take();
        read.call = call;
        let thread = read.thread.clone();
        self.mcp.status = Some(read);
        vec![page(call, &thread, Some(&next))]
    }
}

impl McpControls {
    /// The listed servers with ace's own state over each: a server ace disabled
    /// reads `disabled` before Codex's own runtime status.
    pub(super) fn servers(&self, listed: &[Value]) -> Value {
        let servers: Vec<Value> = listed
            .iter()
            .map(|server| {
                let name = server
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let status = match self.enabled.get(&name) {
                    Some(false) => "disabled",
                    _ => server
                        .get("runtimeStatus")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                };
                let mut entry = Map::new();
                entry.insert("name", Value::from(name));
                entry.insert("status", Value::from(status.to_owned()));
                Value::Object(entry)
            })
            .collect();
        Value::Array(servers.into())
    }
}

/// One `mcpServerStatus/list` page (`codexDiscoveryApi`).
pub(super) fn page(call: u64, thread: &str, cursor: Option<&str>) -> Effect {
    let mut params = Map::new();
    params.insert("limit", Value::from(PAGE_MAX as f64));
    params.insert("threadId", Value::from(thread.to_owned()));
    if let Some(cursor) = cursor {
        params.insert("cursor", Value::from(cursor.to_owned()));
    }
    Effect::Request {
        call,
        method: "mcpServerStatus/list".to_owned(),
        params: Value::Object(params),
        timeout_ms: Some(REQUEST_MS),
    }
}
