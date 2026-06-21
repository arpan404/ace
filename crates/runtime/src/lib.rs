use ace_core::{Command, CommandId};
use thiserror::Error;
use tokio::sync::mpsc;

pub mod tools;

#[derive(Debug, Clone)]
pub struct RuntimeCommand {
    pub id: CommandId,
    pub command: Command,
}

#[derive(Debug, Clone)]
pub struct RuntimeHandle {
    commands: mpsc::Sender<RuntimeCommand>,
}

impl RuntimeHandle {
    #[must_use]
    pub fn new(commands: mpsc::Sender<RuntimeCommand>) -> Self {
        Self { commands }
    }

    pub async fn submit(&self, command: Command) -> Result<CommandId, RuntimeError> {
        let id = CommandId::new();
        self.commands
            .send(RuntimeCommand { id, command })
            .await
            .map_err(|_| RuntimeError::Stopped)?;
        Ok(id)
    }
}

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("runtime is stopped")]
    Stopped,
}

pub mod provider {
    use crate::tools::SemanticToolCall;
    use ace_core::{ProviderCapability, ProviderKind};
    use async_trait::async_trait;
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::time::Duration;

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ProviderDescriptor {
        pub kind: ProviderKind,
        pub capabilities: Vec<ProviderCapability>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    pub struct ProviderRequest {
        pub method: String,
        #[serde(default)]
        pub params: Value,
        pub timeout: Duration,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum ThreadItemKind {
        UserMessage,
        HookPrompt,
        AgentMessage,
        Plan,
        Reasoning,
        CommandExecution,
        FileChange,
        McpToolCall,
        DynamicToolCall,
        CollabAgentToolCall,
        SubAgentActivity,
        WebSearch,
        ImageView,
        ImageGeneration,
        EnteredReviewMode,
        ExitedReviewMode,
        ContextCompaction,
        Unknown,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ThreadItemStatus {
        Started,
        Updated,
        Completed,
        Failed,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct ProviderMetadata {
        pub provider: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub method: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub schema_version: Option<String>,
        #[serde(default)]
        pub raw_payload: Value,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub struct NormalizedThreadItem {
        pub kind: ThreadItemKind,
        pub status: ThreadItemStatus,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub parent_thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub child_thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub sender: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub role: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub text: Option<String>,
        #[serde(default)]
        pub metadata: Value,
        pub provider: ProviderMetadata,
    }

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum ProviderEvent {
        RawNotification {
            method: String,
            #[serde(default)]
            params: Value,
        },
        RawServerRequest {
            id: String,
            method: String,
            #[serde(default)]
            params: Value,
        },
        SemanticTool {
            tool: Box<SemanticToolCall>,
        },
        ThreadItem {
            item: Box<NormalizedThreadItem>,
        },
        StderrLine {
            line: String,
        },
        Exited,
    }

    #[async_trait]
    pub trait ProviderDriver: Send + Sync + 'static {
        fn descriptor(&self) -> ProviderDescriptor;
        async fn request(&self, request: ProviderRequest) -> Result<Value, ProviderDriverError>;
    }

    #[derive(Debug, thiserror::Error)]
    pub enum ProviderDriverError {
        #[error("provider `{provider}` request `{method}` failed: {message}")]
        RequestFailed {
            provider: String,
            method: String,
            message: String,
        },
    }
}
