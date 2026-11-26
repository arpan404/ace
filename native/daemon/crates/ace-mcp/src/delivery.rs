// SPDX-License-Identifier: Apache-2.0
//! What `guide` and `tools_find` hand back with the tools they name, ported from
//! `tool-delivery.ts`.
//!
//! Schemas travel inline only where the model would otherwise never see them, so no session
//! pays for one schema twice: a core client reloads its list (a step late for some clients), a
//! static one never does, and Codex's code-mode models read tools through `exec`.

use crate::toolsets::{AceClient, ToolListing};

/// How a session receives a named tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolDelivery {
    /// Return each tool's input schema with its name.
    pub schemas: bool,
    /// How to call the named tools, where that is not simply by name.
    pub how: Option<&'static str>,
}

/// Codex's code-mode models reach MCP tools only from inside `exec`.
pub const CODEX_CALL_FORM: &str = "Inside exec, call these as await tools.mcp__ace__<name>(args); without exec, load them with your tool_search, then call mcp__ace__<name>.";
const VIA_TOOLS_CALL: &str = "Call these with tools_call {name, arguments}.";
/// A Codex session on the fixed list: its destructive tools are listed by name.
const CODEX_VIA_TOOLS_CALL: &str = "Call these with tools_call {name, arguments}; inside exec, await tools.mcp__ace__tools_call({name, arguments}). A destructive one is in your list: call it by name.";
/// A core client reloads its list, and may do so a step late.
const UNTIL_RELOADED: &str = "These join your tool list when it reloads; call one by name once listed, or with tools_call {name, arguments} before.";

/// What a guide returns about its family's tools.
pub fn guide_delivery(listing: ToolListing, client: Option<AceClient>) -> ToolDelivery {
    if client == Some(AceClient::Codex) {
        return codex_delivery(listing);
    }
    match listing {
        ToolListing::Static => ToolDelivery {
            schemas: true,
            how: Some(VIA_TOOLS_CALL),
        },
        ToolListing::Core => ToolDelivery {
            schemas: false,
            how: Some(UNTIL_RELOADED),
        },
        ToolListing::All => ToolDelivery {
            schemas: false,
            how: None,
        },
    }
}

/// What `tools_find` returns about its matches.
pub fn find_delivery(listing: ToolListing, client: Option<AceClient>) -> ToolDelivery {
    if client == Some(AceClient::Codex) {
        return codex_delivery(listing);
    }
    match listing {
        ToolListing::Static => ToolDelivery {
            schemas: true,
            how: Some(VIA_TOOLS_CALL),
        },
        ToolListing::Core => ToolDelivery {
            schemas: false,
            how: Some(UNTIL_RELOADED),
        },
        ToolListing::All => ToolDelivery {
            schemas: true,
            how: None,
        },
    }
}

/// Codex never shows a code-mode model a schema, so it always gets them inline; it never reloads
/// its list, so a session on the fixed list reaches the rest through `tools_call`.
fn codex_delivery(listing: ToolListing) -> ToolDelivery {
    ToolDelivery {
        schemas: true,
        how: Some(if listing == ToolListing::Static {
            CODEX_VIA_TOOLS_CALL
        } else {
            CODEX_CALL_FORM
        }),
    }
}

#[cfg(test)]
mod tests {
    // Ported from `tool-delivery.ts`'s contract and the guide/`tools_find` results the
    // `tool-guidance.process` and `tool-search` cases read.
    use super::*;

    #[test]
    fn a_guide_withdraws_schemas_where_the_list_already_carries_them() {
        assert_eq!(
            guide_delivery(ToolListing::All, None),
            ToolDelivery {
                schemas: false,
                how: None
            }
        );
        assert_eq!(
            guide_delivery(ToolListing::Core, None),
            ToolDelivery {
                schemas: false,
                how: Some(UNTIL_RELOADED)
            }
        );
        assert_eq!(
            guide_delivery(ToolListing::Static, None),
            ToolDelivery {
                schemas: true,
                how: Some(VIA_TOOLS_CALL)
            }
        );
        // Only Codex reads tools differently; a cursor session is an ordinary client here.
        assert_eq!(
            guide_delivery(ToolListing::All, Some(AceClient::Cursor)),
            guide_delivery(ToolListing::All, None)
        );
    }

    #[test]
    fn tools_find_carries_schemas_only_where_the_model_would_not_see_them() {
        assert_eq!(
            find_delivery(ToolListing::All, None),
            ToolDelivery {
                schemas: true,
                how: None
            }
        );
        assert_eq!(
            find_delivery(ToolListing::Core, None),
            ToolDelivery {
                schemas: false,
                how: Some(UNTIL_RELOADED)
            }
        );
        assert_eq!(
            find_delivery(ToolListing::Static, None),
            ToolDelivery {
                schemas: true,
                how: Some(VIA_TOOLS_CALL)
            }
        );
    }

    #[test]
    fn codex_always_gets_its_schemas_and_its_exec_call_form() {
        for listing in [ToolListing::All, ToolListing::Core] {
            assert_eq!(
                guide_delivery(listing, Some(AceClient::Codex)),
                ToolDelivery {
                    schemas: true,
                    how: Some(CODEX_CALL_FORM)
                }
            );
            assert_eq!(
                find_delivery(listing, Some(AceClient::Codex)),
                ToolDelivery {
                    schemas: true,
                    how: Some(CODEX_CALL_FORM)
                }
            );
        }
        assert_eq!(
            guide_delivery(ToolListing::Static, Some(AceClient::Codex)),
            ToolDelivery {
                schemas: true,
                how: Some(CODEX_VIA_TOOLS_CALL)
            }
        );
        assert_eq!(
            find_delivery(ToolListing::Static, Some(AceClient::Codex)),
            ToolDelivery {
                schemas: true,
                how: Some(CODEX_VIA_TOOLS_CALL)
            }
        );
    }
}
