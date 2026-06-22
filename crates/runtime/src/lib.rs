use ace_core::{Command, CommandId};
use thiserror::Error;
use tokio::sync::mpsc;

pub mod native_provider;
pub mod threads;
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
    use std::{collections::HashMap, sync::Arc, time::Duration};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum ServerRequestKind {
        CommandApproval,
        FileChangeApproval,
        ToolUserInput,
        McpElicitation,
        PermissionApproval,
        DynamicToolCall,
        AccountTokenRefresh,
        Attestation,
        ApplyPatchApproval,
        ExecApproval,
        Unknown,
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
    pub struct NormalizedServerRequest {
        pub kind: ServerRequestKind,
        pub request_id: String,
        pub method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thread_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub scope: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub selected_policy: Option<String>,
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
        ServerRequest {
            request: Box<NormalizedServerRequest>,
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

    pub type DynProviderDriver = Arc<dyn ProviderDriver>;

    #[derive(Default, Clone)]
    pub struct ProviderRegistry {
        drivers: HashMap<ProviderKind, DynProviderDriver>,
    }

    impl ProviderRegistry {
        #[must_use]
        pub fn new() -> Self {
            Self::default()
        }

        #[must_use]
        pub fn with_driver(mut self, driver: DynProviderDriver) -> Self {
            self.register(driver);
            self
        }

        pub fn register(&mut self, driver: DynProviderDriver) {
            let kind = driver.descriptor().kind;
            self.drivers.insert(kind, driver);
        }

        #[must_use]
        pub fn get(&self, kind: ProviderKind) -> Option<DynProviderDriver> {
            self.drivers.get(&kind).cloned()
        }

        #[must_use]
        pub fn descriptors(&self) -> Vec<ProviderDescriptor> {
            let mut descriptors = self
                .drivers
                .values()
                .map(|driver| driver.descriptor())
                .collect::<Vec<_>>();
            descriptors.sort_by_key(|descriptor| descriptor.kind);
            descriptors
        }

        pub async fn request(
            &self,
            kind: ProviderKind,
            request: ProviderRequest,
        ) -> Result<Value, ProviderRuntimeError> {
            let driver = self
                .get(kind)
                .ok_or(ProviderRuntimeError::ProviderUnavailable { provider: kind })?;
            driver.request(request).await.map_err(Into::into)
        }
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

    #[derive(Debug, thiserror::Error)]
    pub enum ProviderRuntimeError {
        #[error("provider `{provider:?}` is not registered")]
        ProviderUnavailable { provider: ProviderKind },
        #[error(transparent)]
        Driver(#[from] ProviderDriverError),
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use async_trait::async_trait;
        use serde_json::json;
        use std::sync::Mutex;

        struct FakeProviderDriver {
            descriptor: ProviderDescriptor,
            requests: Mutex<Vec<ProviderRequest>>,
        }

        #[async_trait]
        impl ProviderDriver for FakeProviderDriver {
            fn descriptor(&self) -> ProviderDescriptor {
                self.descriptor.clone()
            }

            async fn request(
                &self,
                request: ProviderRequest,
            ) -> Result<Value, ProviderDriverError> {
                self.requests.lock().expect("requests").push(request);
                Ok(json!({ "ok": true }))
            }
        }

        #[tokio::test]
        async fn registry_routes_requests_by_provider_kind() {
            let driver = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: vec![ProviderCapability {
                        key: "codex.app_server".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });
            let registry = ProviderRegistry::new().with_driver(driver.clone());

            let response = registry
                .request(
                    ProviderKind::Codex,
                    ProviderRequest {
                        method: "thread/read".to_string(),
                        params: json!({ "threadId": "thread-1" }),
                        timeout: Duration::from_secs(1),
                    },
                )
                .await
                .expect("request");

            assert_eq!(response["ok"], true);
            assert_eq!(
                driver.requests.lock().expect("requests")[0].method,
                "thread/read"
            );
        }

        #[test]
        fn registry_reports_sorted_provider_descriptors() {
            let codex = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::Codex,
                    capabilities: vec![ProviderCapability {
                        key: "codex.app_server".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });
            let claude = Arc::new(FakeProviderDriver {
                descriptor: ProviderDescriptor {
                    kind: ProviderKind::ClaudeCode,
                    capabilities: vec![ProviderCapability {
                        key: "claude_code.cli".to_string(),
                        version: 1,
                    }],
                },
                requests: Mutex::new(Vec::new()),
            });

            let mut registry = ProviderRegistry::new();
            registry.register(claude);
            registry.register(codex);

            let descriptors = registry.descriptors();
            assert_eq!(descriptors[0].kind, ProviderKind::Codex);
            assert_eq!(descriptors[1].kind, ProviderKind::ClaudeCode);
        }

        #[tokio::test]
        async fn registry_rejects_unregistered_provider() {
            let error = ProviderRegistry::new()
                .request(
                    ProviderKind::Cursor,
                    ProviderRequest {
                        method: "thread/read".to_string(),
                        params: json!({}),
                        timeout: Duration::from_secs(1),
                    },
                )
                .await
                .expect_err("unregistered provider");

            assert!(matches!(
                error,
                ProviderRuntimeError::ProviderUnavailable {
                    provider: ProviderKind::Cursor
                }
            ));
        }
    }
}
