// SPDX-License-Identifier: Apache-2.0
//! A tool's detail as it stands (`tool-final.ts`).

use crate::translate::mcp::mcp_arguments;
use crate::translate::quirks::QuirksKind;
use crate::translate::state::ToolState;
use crate::translate::tool_raw::complete_tool_raw;
use crate::translate::tools::tool_detail;
use ace_json::Value;

/// Every path picks MCP arguments from collected input once finalized.
pub fn current_tool_detail(tool: &ToolState, quirks: QuirksKind) -> Value {
    let mut detail = tool_detail(&Value::Object(tool.data.clone()), quirks);
    if detail.get("kind").and_then(Value::as_str) == Some("mcp")
        && let Some(completed) = tool.completed_input.clone()
        && let Some(obj) = detail.as_object_mut()
    {
        obj.insert("arguments".to_owned(), mcp_arguments(&completed));
    }
    detail
}

/// All terminal paths publish the same collected input.
pub fn finalize_tool(tool: &mut ToolState, quirks: QuirksKind) -> Value {
    complete_tool_raw(tool);
    current_tool_detail(tool, quirks)
}
