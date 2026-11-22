//! What a connected app's call was approved as, checked on the session that sends it (ADR 0202,
//! amendment 5). The gate decides a call on the tool's definition as listed then (its name,
//! description and input schema) and on the session it was listed by. Between that decision and
//! the send, a relist or a renewed sign-in may change what the server offers under the same name,
//! so right before each send the sending session must still list the tool with that definition,
//! and still be the session (its generation) the decision was made on, or the call isn't sent.
//! A renewal this very call makes to send it keeps the generation it was decided on, since it
//! never ran before; the definition is checked again on the renewed session.
//!
//! A digest is what the server claims about the tool, never proof of what it does.

use sha2::{Digest, Sha256};
use spade_mcp::{McpClient, McpTool, ToolsError};

use crate::{CallError, Connectors};

/// A digest of `tool`'s definition as its server lists it: everything the gate reads in it, its
/// own name, description, input schema, annotations (risk, whether it sent any, open world),
/// `_meta` (a declared effect among it), page and who may call it.
pub fn definition(tool: &McpTool) -> String {
    let text = serde_json::json!([
        tool.name,
        tool.description,
        tool.input_schema,
        format!("{:?}", tool.risk),
        tool.annotated,
        tool.open_world,
        tool.meta,
        tool.page,
        tool.for_model,
        tool.for_app,
    ])
    .to_string();
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// What a call was approved as: the tool's definition and the session's generation then.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expect {
    pub definition: String,
    pub generation: u64,
}

impl Connectors {
    /// The generation of `connector`'s session now: it changes whenever its client is replaced
    /// (a renewed sign-in, a restarted session).
    pub fn generation(&self, connector: &str) -> u64 {
        let live = self.live.read().unwrap_or_else(|p| p.into_inner());
        live.get(connector).map_or(0, |session| session.generation)
    }

    /// Whether a call approved as `expect` may be sent on `client`, of session `generation`:
    /// the session must be the one it was approved on, or one this very call's renewal opened
    /// (`ours`), and that client's own listing must offer the tool to the model with the
    /// definition it was approved for.
    pub(crate) async fn check(
        &self,
        name: &str,
        tool: &str,
        expect: &Expect,
        client: &McpClient,
        generation: u64,
        ours: Option<u64>,
    ) -> Checked {
        if generation != expect.generation && ours != Some(generation) {
            return Checked::No(CallError::NotRun(format!(
                "{name}'s session changed since this call was approved, so it wasn't sent"
            )));
        }
        let listed = match client.tools().await {
            Ok(listed) => listed,
            Err(ToolsError::Refused) => return Checked::Refused,
            Err(error) => {
                return Checked::No(CallError::NotRun(format!(
                    "{name}'s tools couldn't be read to check this call, so it wasn't sent: {error}"
                )));
            }
        };
        let same = listed.iter().any(|offered| {
            offered.name == tool && offered.for_model && definition(offered) == expect.definition
        });
        if same {
            Checked::Same
        } else {
            Checked::No(CallError::NotRun(format!(
                "{name} changed this tool since the call was approved, so it wasn't sent"
            )))
        }
    }
}

/// What checking a call against what it was approved as found.
pub(crate) enum Checked {
    /// The same session (or this call's own renewal of it), listing the same tool: send it.
    Same,
    /// The listing itself was refused: the sign-in expired. Nothing was sent; renew, check
    /// again, and send once.
    Refused,
    /// Not sent, and why.
    No(CallError),
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};
    use spade_mcp::{McpTool, Risk};

    use super::definition;

    fn tool() -> McpTool {
        McpTool {
            name: "create_page".into(),
            description: "Creates a page.".into(),
            input_schema: json!({ "type": "object" }),
            risk: Risk::Write,
            annotated: false,
            open_world: None,
            meta: Map::new(),
            page: None,
            for_model: true,
            for_app: true,
        }
    }

    #[test]
    fn a_tool_that_says_anything_else_about_itself_has_another_definition() {
        let base = definition(&tool());
        let changed = [
            McpTool {
                risk: Risk::Read,
                annotated: true,
                ..tool()
            },
            McpTool {
                open_world: Some(true),
                ..tool()
            },
            McpTool {
                for_model: false,
                ..tool()
            },
            McpTool {
                page: Some("ui://page".into()),
                ..tool()
            },
            McpTool {
                meta: Map::from_iter([("ace/effect".to_owned(), json!("read"))]),
                ..tool()
            },
        ];
        for each in changed {
            assert_ne!(definition(&each), base, "{each:?}");
        }
        assert_eq!(definition(&tool()), base);
    }
}
