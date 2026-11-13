//! `AceTools`: Spade as an MCP client of the daemon's loopback `/mcp` endpoint
//! (docs/ace-integration.md, "Spade uses ace's tools through the daemon"), on `spade-mcp`.
//!
//! Every request carries `X-Ace-Notifications: stream`. Without it the daemon serves a
//! 2025-11-25 client statelessly, with no session and no list-change stream. Spade sends no
//! `X-Ace-Tools` or `X-Ace-Client`, which gets the full listing with its hints. One session is
//! kept and opened again when it is lost. The daemon keeps at most four per bearer and the
//! bearer is new on every Spade start, so nothing here outlives the process. Requests never go
//! through a proxy: the daemon is on this machine.

use serde_json::Value;
use spade_mcp::{HeaderName, HeaderValue, McpClient, McpConfig};
use tokio::sync::watch;

pub use crate::config::ToolsConfig;
pub use spade_mcp::map;
pub use spade_mcp::{McpTool as AceTool, McpToolResult as AceToolResult, Part, Risk, ToolsError};

/// Asks the daemon for a session with a list-change stream (`packages/mcp-server/src/http.ts`).
const NOTIFICATIONS_HEADER: &str = "x-ace-notifications";

/// The `_meta` key naming the bot a call is made for (`actingForMetaKey` in
/// `packages/mcp-server/src/http.ts`).
pub const ACTING_FOR: &str = "ace/acting-for";

/// The public error code ace's browser and screen tools answer while the person drives the bot's
/// computer (`person_driving` in `packages/mcp-server/src/public-error.ts`).
pub const PERSON_DRIVING: &str = "person_driving";

pub struct AceTools(McpClient);

impl AceTools {
    /// Nothing is sent until the first `tools` or `call`.
    pub fn new(config: ToolsConfig) -> Self {
        let mcp = McpConfig::new(config.url().as_str(), config.timeout())
            .bearer(config.token().clone())
            .header(
                HeaderName::from_static(NOTIFICATIONS_HEADER),
                HeaderValue::from_static("stream"),
            )
            .direct();
        Self(McpClient::new(mcp))
    }

    /// Withdraws this client's credential: its session is cancelled with anything still queued,
    /// and every later listing or call fails as not run without sending anything.
    pub fn close(&self) {
        self.0.close();
    }

    /// Counts the daemon's tool list changes; the next `tools` call fetches it again.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.0.changes()
    }

    /// Every tool the daemon offers this credential, all pages.
    pub async fn tools(&self) -> Result<Vec<AceTool>, ToolsError> {
        self.0.tools().await
    }

    /// Calls one tool. `arguments` is a JSON object, or null for none. A call is sent at most
    /// once: `NotRun` means it did not run, `OutcomeUnknown` and `Timeout` that it may have.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<AceToolResult, ToolsError> {
        self.0.call(name, arguments).await
    }

    /// [`AceTools::call`] made for one Spade bot (ADR 0142): `_meta` names it as
    /// `ace/acting-for`, so its browser and screen calls run in that bot's own hidden thread.
    /// `bot` comes from Spade's own state for the turn, never from the model's arguments.
    pub async fn call_for(
        &self,
        name: &str,
        arguments: Value,
        bot: &str,
    ) -> Result<AceToolResult, ToolsError> {
        let mut meta = serde_json::Map::new();
        meta.insert(ACTING_FOR.into(), Value::String(bot.to_owned()));
        self.0.call_with_meta(name, arguments, meta).await
    }
}
