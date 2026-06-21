use ace_runtime::tools::SemanticToolCall;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ProviderRuntimeEvent {
    ToolStarted {
        tool: SemanticToolCall,
    },
    ToolUpdated {
        tool: SemanticToolCall,
    },
    ToolOutputDelta {
        tool: SemanticToolCall,
        delta: String,
    },
    ToolCompleted {
        tool: SemanticToolCall,
    },
    ToolFailed {
        tool: SemanticToolCall,
        message: String,
    },
    ToolApprovalRequested {
        tool: SemanticToolCall,
    },
}

impl ProviderRuntimeEvent {
    #[must_use]
    pub fn tool(tool: SemanticToolCall) -> Self {
        match tool.display.status {
            ace_runtime::tools::ToolRunStatus::Started => Self::ToolStarted { tool },
            ace_runtime::tools::ToolRunStatus::Updated => Self::ToolUpdated { tool },
            ace_runtime::tools::ToolRunStatus::Completed => Self::ToolCompleted { tool },
            ace_runtime::tools::ToolRunStatus::Failed => Self::ToolFailed {
                tool,
                message: "tool failed".to_string(),
            },
            ace_runtime::tools::ToolRunStatus::ApprovalRequested => {
                Self::ToolApprovalRequested { tool }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use ace_runtime::tools::{
        ProviderToolMetadata, ToolNormalizationInput, ToolRunStatus, ToolTransport,
        normalize_tool_call,
    };
    use serde_json::json;

    use super::*;

    #[test]
    fn provider_runtime_event_uses_semantic_tool_shape() {
        let mut provider = ProviderToolMetadata::new();
        provider.tool_name = Some("ace_browser".to_string());
        provider.operation = Some("cua_click".to_string());
        provider.raw_args = json!({ "operation": "cua_click", "label": "Run" });
        let tool = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Mcp,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("mcpToolCall".to_string()),
        });

        let event = ProviderRuntimeEvent::tool(tool);
        let encoded = serde_json::to_value(event).expect("encode");
        assert_eq!(encoded["type"], "tool_completed");
        assert_eq!(encoded["tool"]["surface"], "browser");
        assert_eq!(encoded["tool"]["action"], "browser.click");
        assert_eq!(
            encoded["tool"]["display"]["title"],
            "Clicked Run in Browser"
        );
    }
}
