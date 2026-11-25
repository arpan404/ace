// SPDX-License-Identifier: Apache-2.0
//! Codex's MCP controls (`mcp-controls.ts`). The app-server owns `config.toml`
//! writes, so ace sends the config keys and asks for a reload: no environment,
//! headers or credential operations ever cross.

use ace_json::{Map, Value};
use indexmap::IndexMap;

use super::commands::settle;
use super::frames::{Effect, Failure};
use super::state::Session;

mod server;
mod status;

use server::Server;
use status::StatusRead;

/// The status read's page bound (`codexPage`).
pub(super) const PAGE_MAX: usize = 100;
/// How many status pages a read asks for (`for page < 8`).
pub(super) const PAGES_MAX: u32 = 8;
/// How many servers a status read keeps (`data.length > 512`).
pub(super) const SERVERS_MAX: usize = 512;
/// One request's deadline (`request` in `session.ts`).
pub(super) const REQUEST_MS: f64 = 30_000.0;

/// What follows a config write (`write`, then `reload`).
#[derive(Debug, Clone)]
enum After {
    Nothing,
    /// `toggle`'s bookkeeping, once the reload landed.
    Enable {
        name: String,
        on: bool,
    },
}

/// One control request's steps, by the call it waits on.
struct Pending {
    operation: u64,
    thread: String,
    step: Step,
}

#[derive(Debug, Clone)]
enum Step {
    /// `config/value/write`, then the reload.
    Write { after: After },
    /// `config/mcpServer/reload`.
    Reload { after: After },
}

/// A session's MCP controls: the servers it disabled itself, and its reads.
#[derive(Default)]
pub(crate) struct McpControls {
    enabled: IndexMap<String, bool>,
    writes: IndexMap<u64, Pending>,
    status: Option<StatusRead>,
}

impl McpControls {
    pub(crate) fn new() -> McpControls {
        McpControls::default()
    }

    /// `cleanup()`: every answer still owed fails.
    pub(crate) fn clear(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        for (_, pending) in std::mem::take(&mut self.writes) {
            effects.extend(settle(
                pending.operation,
                Err(Failure::failed("Codex session ended")),
            ));
        }
        if let Some(read) = self.status.take() {
            effects.extend(settle(
                read.operation,
                Err(Failure::failed("Codex session ended")),
            ));
        }
        effects
    }
}

impl Session {
    /// `status()`: each server Codex lists, with the state ace wrote over it.
    pub fn mcp_status(&mut self, operation: u64, thread: &str) -> Vec<Effect> {
        if self.is_closed() {
            return super::commands::closed(operation);
        }
        let call = self.calls.take();
        self.mcp.status = Some(StatusRead {
            operation,
            thread: thread.to_owned(),
            call,
            visited: Vec::new(),
            pages: 0,
            servers: Vec::new(),
        });
        vec![status::page(call, thread, None)]
    }

    /// `add(name, input)`: the server's config, then a reload.
    pub fn mcp_add(
        &mut self,
        operation: u64,
        thread: &str,
        name: &str,
        input: &Value,
    ) -> Vec<Effect> {
        if self.is_closed() {
            return super::commands::closed(operation);
        }
        let server = match Server::parse(input) {
            Ok(server) => server,
            Err(message) => return settle(operation, Err(Failure::failed(message))),
        };
        self.write(operation, thread, name, "", server.config(), After::Nothing)
    }

    /// `replace()`: Codex has no live replacement.
    pub fn mcp_replace(&mut self, operation: u64) -> Vec<Effect> {
        settle(
            operation,
            Err(Failure::failed(
                "Codex does not support replacing live MCP servers",
            )),
        )
    }

    /// `reconnect`: the app-server reloads its own configuration.
    pub fn mcp_reconnect(&mut self, operation: u64, thread: &str) -> Vec<Effect> {
        if self.is_closed() {
            return super::commands::closed(operation);
        }
        let call = self.calls.take();
        self.mcp.writes.insert(
            call,
            Pending {
                operation,
                thread: thread.to_owned(),
                step: Step::Reload {
                    after: After::Nothing,
                },
            },
        );
        vec![reload_request(call, thread)]
    }

    /// `enable`/`disable`: the server's own `enabled` key, then a reload.
    pub fn mcp_toggle(
        &mut self,
        operation: u64,
        thread: &str,
        name: &str,
        on: bool,
    ) -> Vec<Effect> {
        if self.is_closed() {
            return super::commands::closed(operation);
        }
        self.write(
            operation,
            thread,
            name,
            ".enabled",
            Value::Bool(on),
            After::Enable {
                name: name.to_owned(),
                on,
            },
        )
    }

    /// `write(name, suffix, value)`: one config key, then a reload.
    fn write(
        &mut self,
        operation: u64,
        thread: &str,
        name: &str,
        suffix: &str,
        value: Value,
        after: After,
    ) -> Vec<Effect> {
        if !server::is_name(name) {
            return settle(
                operation,
                Err(Failure::failed(
                    "Manage this server name in Codex configuration",
                )),
            );
        }
        let call = self.calls.take();
        let key_path = format!("mcp_servers.{name}{suffix}");
        self.mcp.writes.insert(
            call,
            Pending {
                operation,
                thread: thread.to_owned(),
                step: Step::Write { after },
            },
        );
        vec![write_request(call, &key_path, &value)]
    }

    /// One control reply, when this call is a control's.
    pub(crate) fn mcp_settled(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Option<Vec<Effect>> {
        if let Some(read) = self.mcp.status.take()
            && read.call == call
        {
            return Some(self.status_settled(read, reply));
        }
        let pending = self.mcp.writes.shift_remove(&call)?;
        Some(self.step_settled(pending, reply))
    }

    /// One write or reload: the next step, or the answer it ends on.
    fn step_settled(&mut self, pending: Pending, reply: Result<&Value, &str>) -> Vec<Effect> {
        let Pending {
            operation,
            thread,
            step,
        } = pending;
        let after = match &step {
            Step::Write { after } => after.clone(),
            Step::Reload { after } => after.clone(),
        };
        let next = match &step {
            Step::Write { .. } => Step::Reload {
                after: after.clone(),
            },
            Step::Reload { .. } => {
                if let Err(message) = reply {
                    return settle(operation, Err(Failure::failed(message)));
                }
                if let After::Enable { name, on } = after {
                    self.mcp.enabled.insert(name, on);
                }
                return settle(operation, Ok(Value::Null));
            }
        };
        if let Err(message) = reply {
            return settle(operation, Err(Failure::failed(message)));
        }
        let call = self.calls.take();
        self.mcp.writes.insert(
            call,
            Pending {
                operation,
                thread: thread.clone(),
                step: next,
            },
        );
        vec![reload_request(call, &thread)]
    }
}

fn write_request(call: u64, key_path: &str, value: &Value) -> Effect {
    let mut params = Map::new();
    params.insert("keyPath", Value::from(key_path.to_owned()));
    params.insert("value", value.clone());
    params.insert("mergeStrategy", Value::from("upsert"));
    Effect::Request {
        call,
        method: "config/value/write".to_owned(),
        params: Value::Object(params),
        timeout_ms: Some(REQUEST_MS),
    }
}

fn reload_request(call: u64, thread: &str) -> Effect {
    let mut params = Map::new();
    params.insert("threadId", Value::from(thread.to_owned()));
    Effect::Request {
        call,
        method: "config/mcpServer/reload".to_owned(),
        params: Value::Object(params),
        timeout_ms: Some(REQUEST_MS),
    }
}

#[cfg(test)]
mod tests;
