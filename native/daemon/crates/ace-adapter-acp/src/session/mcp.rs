// SPDX-License-Identifier: Apache-2.0
//! ACP MCP server selection, transport filtering, and collision checks
//! (`packages/mcp-server/src/injection.ts:239`-`:250` and
//! `packages/adapter-acp/src/session.ts:417`-`:437`).

use ace_json::Value;
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};

use crate::translate::data::{object, string};

const MAX_ACP_MCP_SERVERS: usize = 64;
const MAX_SERVER_NAME_UNITS: usize = 256;

/// Transport selected for ace's injected MCP server (`AcpSessionSupport["mcp"]`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Http,
    Stdio,
    Unavailable,
}

impl McpTransport {
    pub fn as_str(self) -> &'static str {
        match self {
            McpTransport::Http => "http",
            McpTransport::Stdio => "stdio",
            McpTransport::Unavailable => "unavailable",
        }
    }
}

/// MCP injection and user-configured server inputs supplied at session open.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct McpConfig {
    pub http_servers: Vec<Value>,
    pub stdio_servers: Vec<Value>,
    pub configured_servers: Vec<Value>,
    pub secrets: Vec<String>,
    /// ace's guidance for this session, rendered once by the daemon.
    pub instructions: Option<String>,
    /// The provider's developer instructions, rendered by the daemon
    /// (`packages/mcp-server/src/session-guidance.ts:106`; Rust has no port of that
    /// module yet, so the facade renders it), used when the lease carried none.
    pub developer_instructions: Option<String>,
}

impl McpConfig {
    /// ace's guidance for this session (`session.ts:155`): the lease's own
    /// instructions, else the provider's developer instructions.
    pub fn guidance(&self) -> Option<&str> {
        self.instructions
            .as_deref()
            .or(self.developer_instructions.as_deref())
            .filter(|text| !text.is_empty())
    }
}

/// One user-configured server omitted because the agent lacks its transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedMcpServer {
    pub name: String,
    pub transport: String,
}

/// Outcome of filtering configured servers and merging ace's injected MCP server.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedMcp {
    pub servers: Vec<Value>,
    pub transport: McpTransport,
    pub skipped: Vec<SkippedMcpServer>,
}

/// Preserve user definitions and reject a visible collision instead of silently replacing one
/// (`injection.ts:241`–`:250`).
pub fn append_acp_mcp(user: &[Value], injected: &[Value]) -> Result<Vec<Value>, String> {
    if user.len() + injected.len() > MAX_ACP_MCP_SERVERS {
        return Err("ACP MCP server capacity exceeded".to_owned());
    }
    let mut names: IndexSet<String> = IndexSet::with_capacity(user.len() + injected.len());
    let mut combined = Vec::with_capacity(user.len() + injected.len());
    for value in user.iter().chain(injected.iter()) {
        let Some(map) = value.as_object() else {
            return Err("Invalid ACP MCP server definition".to_owned());
        };
        let Some(name_js) = map.get("name").and_then(Value::as_js_str) else {
            return Err("Invalid ACP MCP server name".to_owned());
        };
        let units = name_js.len_utf16();
        if units == 0 || units > MAX_SERVER_NAME_UNITS {
            return Err("Invalid ACP MCP server name".to_owned());
        }
        let name = name_js.to_string();
        if !names.insert(name.clone()) {
            return Err(format!("ACP MCP server name collision: {name}"));
        }
        combined.push(value.clone());
    }
    Ok(combined)
}

/// Select injected servers by advertised capability, skip unsupported configured servers
/// (recording each skip for `mcp-server-skipped`), and merge with collision checks
/// (`session.ts:417`–`:437`).
pub fn prepare_acp_mcp(
    mcp: Option<&McpConfig>,
    http_mcp: bool,
    sse_mcp: bool,
) -> Result<PreparedMcp, String> {
    let Some(mcp) = mcp else {
        return Ok(PreparedMcp {
            servers: Vec::new(),
            transport: McpTransport::Unavailable,
            skipped: Vec::new(),
        });
    };

    let injected: &[Value] = if http_mcp {
        &mcp.http_servers
    } else {
        &mcp.stdio_servers
    };

    let mut configured = Vec::with_capacity(mcp.configured_servers.len());
    let mut skipped = Vec::new();
    for server in &mcp.configured_servers {
        let map = object(server);
        let server_type = map.get("type").and_then(Value::as_str);
        let unsupported =
            (server_type == Some("http") && !http_mcp) || (server_type == Some("sse") && !sse_mcp);
        if unsupported {
            skipped.push(SkippedMcpServer {
                name: string(map.get("name").unwrap_or(&Value::Null)).to_owned(),
                transport: server_type.unwrap_or("").to_owned(),
            });
        } else {
            configured.push(server.clone());
        }
    }

    let servers = append_acp_mcp(&configured, injected)?;
    let transport = if !injected.is_empty() {
        if http_mcp {
            McpTransport::Http
        } else {
            McpTransport::Stdio
        }
    } else {
        McpTransport::Unavailable
    };

    Ok(PreparedMcp {
        servers,
        transport,
        skipped,
    })
}

#[cfg(test)]
mod tests {
    use super::{McpConfig, McpTransport, SkippedMcpServer, append_acp_mcp, prepare_acp_mcp};
    use ace_json::{Value, json};

    #[test]
    fn stdio_only_agent_skips_http_and_sse_configured_servers_and_injects_stdio() {
        let mcp = McpConfig {
            http_servers: vec![
                json!({ "name": "ace", "type": "http", "url": "http://127.0.0.1:9" }),
            ],
            stdio_servers: vec![json!({ "name": "ace", "command": "node", "args": ["bridge.js"] })],
            configured_servers: vec![
                json!({ "name": "local-stdio", "command": "mcp-bin" }),
                json!({ "name": "remote-http", "type": "http", "url": "https://example.test" }),
                json!({ "name": "remote-sse", "type": "sse", "url": "https://example.test/sse" }),
            ],
            secrets: Vec::new(),
            instructions: None,
            developer_instructions: None,
        };

        let prepared = match prepare_acp_mcp(Some(&mcp), false, false) {
            Ok(p) => p,
            Err(err) => panic!("unexpected error: {err}"),
        };
        assert_eq!(prepared.transport, McpTransport::Stdio);
        assert_eq!(prepared.servers.len(), 2);
        assert_eq!(
            prepared.servers[0].get("name").and_then(Value::as_str),
            Some("local-stdio")
        );
        assert_eq!(
            prepared.servers[1].get("command").and_then(Value::as_str),
            Some("node")
        );
        assert_eq!(
            prepared.skipped,
            vec![
                SkippedMcpServer {
                    name: "remote-http".to_owned(),
                    transport: "http".to_owned(),
                },
                SkippedMcpServer {
                    name: "remote-sse".to_owned(),
                    transport: "sse".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn append_acp_mcp_rejects_name_collisions_and_capacity_overflow() {
        let collision = append_acp_mcp(
            &[json!({ "name": "ace", "command": "custom" })],
            &[json!({ "name": "ace", "command": "bridge" })],
        );
        assert_eq!(
            collision,
            Err("ACP MCP server name collision: ace".to_owned())
        );

        let too_many: Vec<Value> = (0..65)
            .map(|i| json!({ "name": format!("srv-{i}"), "command": "x" }))
            .collect();
        assert_eq!(
            append_acp_mcp(&too_many, &[]),
            Err("ACP MCP server capacity exceeded".to_owned())
        );
    }
}
