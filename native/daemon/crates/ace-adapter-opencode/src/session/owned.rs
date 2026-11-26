// SPDX-License-Identifier: Apache-2.0
//! OpenCode's own v2 server process (`packages/adapter-opencode/src/owned-server.ts`):
//! the arguments and environment it is spawned with, the readiness line it
//! announces, and the authorization header its loopback port answers to.
//!
//! The spawn itself is the shell's (`server.rs`'s `start`); everything here is
//! pure, so a test pins the line, the environment and the header without a
//! process.

use ace_json::Value;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use indexmap::IndexMap;

use crate::translate::boundaries::check_loopback;
use crate::translate::data::fields;

/// `maxLineBytes` (`owned-server.ts:37`): its stdout carries one readiness line.
pub const MAX_LINE_BYTES: usize = 65536;
/// The supervisor's name for the process (`owned-server.ts:36`).
pub const NAME: &str = "opencode-server";
/// `serve --stdio --hostname 127.0.0.1 --port 0` (`owned-server.ts:29`).
pub const ARGS: [&str; 6] = ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"];

/// ace's own credentials, never the server's (`agent-env.ts:28`-`:39`).
const ACE_SECRETS: [&str; 8] = [
    "ACE_MCP_BEARER_TOKEN",
    "ACE_MCP_TOKEN",
    "ACE_DAEMON_TOKEN",
    "ACE_DAEMON_TOKEN_FILE",
    "ACE_MARKET_SIGNER_TOKEN",
    "ACE_GRANT_KEY",
    "ACE_GRANT_PREVIOUS_KEY",
    "ACE_ACCOUNT_ENCRYPTION_KEY",
];

/// The server's environment (`owned-server.ts:26`-`:33`): ace's credentials
/// gone, the password only in `OPENCODE_PASSWORD`, and its own two password
/// names dropped so the server takes the one it was given.
pub fn spawn_env(env: &[(String, String)], password: &str) -> IndexMap<String, String> {
    let mut out: IndexMap<String, String> = env.iter().cloned().collect();
    for name in ACE_SECRETS {
        out.shift_remove(name);
    }
    out.insert(String::from("OPENCODE_PASSWORD"), password.to_owned());
    out.shift_remove("OPENCODE_SERVER_PASSWORD");
    out.shift_remove("OPENCODE_SERVER_USERNAME");
    out
}

/// `basicAuthorization(password)`: the header the server's loopback port wants.
pub fn basic_authorization(password: &str) -> String {
    format!(
        "Basic {}",
        STANDARD.encode(format!("opencode:{password}").as_bytes())
    )
}

/// Why a readiness line was refused. The TypeScript rejects with these texts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ReadinessError {
    #[error("Invalid OpenCode readiness URL")]
    InvalidUrl,
}

/// One stdout line: `Some(url)` when it is the readiness line, `None` when it is
/// any other output (`owned-server.ts:52`-`:74`). Only the announced URL is read:
/// other lines may hold configuration secrets.
pub fn readiness(line: &str) -> Result<Option<String>, ReadinessError> {
    let Ok(value) = ace_json::parse(line) else {
        return Ok(None);
    };
    let Some(Value::String(url)) = fields(&value).get("url") else {
        return Ok(None);
    };
    check_loopback(url.as_str()).map_err(|_| ReadinessError::InvalidUrl)?;
    Ok(Some(url.as_str().to_owned()))
}

#[cfg(test)]
mod tests;
