// SPDX-License-Identifier: Apache-2.0
//! What ace writes into `mcp_servers.<name>` (`McpServerInput`, `mcp-controls.ts`):
//! a command and its arguments, or an http endpoint without credentials.

use ace_json::{Map, Value};

/// A server name the app-server's config path can carry (`/^[A-Za-z0-9_-]{1,64}$/`).
const NAME_MAX: usize = 64;
/// A command or an argument's bound (`z.string().max(2048)`).
const TEXT_MAX: usize = 2048;
/// How many arguments an MCP server may take (`z.array(...).max(64)`).
const ARGS_MAX: usize = 64;

pub(super) enum Server {
    Command { command: String, args: Vec<String> },
    Http { url: String },
}

impl Server {
    /// `McpServerInput.parse(input)`: strict, both transports.
    pub(super) fn parse(input: &Value) -> Result<Server, String> {
        let Some(input) = input.as_object() else {
            return Err("MCP server input must be an object".to_owned());
        };
        match input.get("transport").and_then(Value::as_str) {
            Some("command") => {
                for key in input.keys() {
                    if !matches!(key.as_str(), "transport" | "command" | "args") {
                        return Err(format!("Unrecognized key \"{key}\" in MCP server input"));
                    }
                }
                let command = bounded(text(input.get("command")))
                    .ok_or_else(|| "MCP server command must be 1 to 2048 characters".to_owned())?;
                let args = match input.get("args") {
                    None => Vec::new(),
                    Some(value) => value
                        .as_array()
                        .filter(|args| args.len() <= ARGS_MAX)
                        .ok_or_else(|| {
                            format!("MCP server args must be at most {ARGS_MAX} strings")
                        })?
                        .iter()
                        .map(|arg| {
                            // An empty argument is an argument: only its length
                            // is bounded (`z.string().max(2048)`).
                            arg.as_str()
                                .filter(|arg| arg.chars().count() <= TEXT_MAX)
                                .map(|arg| arg.to_owned())
                                .ok_or_else(|| {
                                    "MCP server arguments must be at most 2048 characters"
                                        .to_owned()
                                })
                        })
                        .collect::<Result<Vec<String>, String>>()?,
                };
                Ok(Server::Command { command, args })
            }
            Some("http") => {
                for key in input.keys() {
                    if !matches!(key.as_str(), "transport" | "url") {
                        return Err(format!("Unrecognized key \"{key}\" in MCP server input"));
                    }
                }
                let url = bounded(text(input.get("url")))
                    .filter(|url| is_endpoint(url))
                    .ok_or_else(|| {
                        "MCP server URL must be an http or https URL without credentials, query or fragment".to_owned()
                    })?;
                Ok(Server::Http { url })
            }
            _ => Err("MCP server input needs a transport".to_owned()),
        }
    }

    /// The `mcp_servers.<name>` value Codex's config takes.
    pub(super) fn config(&self) -> Value {
        let mut config = Map::new();
        match self {
            Server::Command { command, args } => {
                config.insert("command", Value::from(command.clone()));
                config.insert(
                    "args",
                    Value::Array(
                        args.iter()
                            .map(|arg| Value::from(arg.clone()))
                            .collect::<Vec<Value>>()
                            .into(),
                    ),
                );
            }
            Server::Http { url } => {
                config.insert("url", Value::from(url.clone()));
            }
        }
        Value::Object(config)
    }
}

/// `/^[A-Za-z0-9_-]{1,64}$/`: a name the dotted config path can carry.
pub(super) fn is_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= NAME_MAX
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// A string of 1..=2048 characters.
fn bounded(text: Option<&str>) -> Option<String> {
    text.filter(|text| !text.is_empty() && text.chars().count() <= TEXT_MAX)
        .map(|text| text.to_owned())
}

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

/// `new URL(...)`: an `http` or `https` endpoint (the scheme's case is not
/// significant, and surrounding whitespace is trimmed) with no credentials, no
/// search and no fragment. A bare trailing `?` or `#` names an empty search or
/// fragment, which the URL API accepts.
fn is_endpoint(url: &str) -> bool {
    let url = url.trim();
    let rest = ["http://", "https://"].iter().find_map(|scheme| {
        url.get(..scheme.len())
            .filter(|prefix| prefix.eq_ignore_ascii_case(scheme))
            .map(|_| &url[scheme.len()..])
    });
    let Some(rest) = rest else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return false;
    }
    let search = rest
        .split_once('?')
        .map(|(_, after)| after.split('#').next().unwrap_or_default());
    let hash = rest.split_once('#').map(|(_, after)| after);
    search.is_none_or(str::is_empty) && hash.is_none_or(str::is_empty)
}
