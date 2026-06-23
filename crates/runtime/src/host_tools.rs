use crate::{
    provider::{NormalizedServerRequest, ServerRequestKind},
    tools::{
        ProviderToolMetadata, SemanticToolCall, ToolActionKind, ToolNormalizationInput,
        ToolRunStatus, ToolSurface, ToolTransport, normalize_tool_call,
    },
};
use ace_core::{ProviderCapability, ProviderKind};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};

const DEFAULT_MAX_ARGUMENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostToolDescriptor {
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
    pub transport: ToolTransport,
    pub surface: ToolSurface,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<ToolActionKind>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<ProviderCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub input_schema: Value,
    pub requires_user_approval: bool,
    pub max_argument_bytes: usize,
    pub timeout: Duration,
}

impl HostToolDescriptor {
    #[must_use]
    pub fn new(name: impl Into<String>, transport: ToolTransport, surface: ToolSurface) -> Self {
        Self {
            name: name.into(),
            aliases: Vec::new(),
            transport,
            surface,
            actions: Vec::new(),
            capabilities: Vec::new(),
            description: None,
            input_schema: Value::Null,
            requires_user_approval: false,
            max_argument_bytes: DEFAULT_MAX_ARGUMENT_BYTES,
            timeout: Duration::from_secs(30),
        }
    }

    #[must_use]
    pub fn with_capability(mut self, key: impl Into<String>, version: u32) -> Self {
        self.capabilities.push(ProviderCapability {
            key: key.into(),
            version,
        });
        self
    }

    #[must_use]
    pub fn effective_capabilities(&self) -> Vec<ProviderCapability> {
        let mut capabilities = self.capabilities.clone();
        capabilities.push(ProviderCapability {
            key: format!("host_tool.transport.{}", serde_name(self.transport)),
            version: 1,
        });
        capabilities.push(ProviderCapability {
            key: format!("host_tool.surface.{}", serde_name(self.surface)),
            version: 1,
        });
        capabilities.extend(self.actions.iter().map(|action| ProviderCapability {
            key: format!("host_tool.action.{}", serde_name(*action)),
            version: 1,
        }));
        dedupe_capabilities(capabilities)
    }

    #[must_use]
    pub fn with_effective_capabilities(mut self) -> Self {
        self.capabilities = self.effective_capabilities();
        self
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostToolInvocation {
    pub request_id: String,
    pub provider: ProviderKind,
    pub descriptor_name: Option<String>,
    pub tool_name: String,
    pub server_name: Option<String>,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub arguments: Value,
    pub raw_payload: Value,
}

impl HostToolInvocation {
    #[must_use]
    pub fn semantic_tool(
        &self,
        descriptor: Option<&HostToolDescriptor>,
        status: ToolRunStatus,
    ) -> SemanticToolCall {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some(self.provider.runtime_id().to_string());
        provider.item_id = self.item_id.clone();
        provider.turn_id = self.turn_id.clone();
        provider.thread_id = self.thread_id.clone();
        provider.server_name = self.server_name.clone();
        provider.tool_name = Some(self.tool_name.clone());
        provider.operation = operation_from_arguments(&self.arguments)
            .or_else(|| {
                string_at_deep(&self.raw_payload, "operation")
                    .or_else(|| string_at_deep(&self.raw_payload, "op"))
                    .or_else(|| string_at_deep(&self.raw_payload, "action"))
            })
            .or_else(|| {
                descriptor
                    .and_then(|descriptor| descriptor.actions.first())
                    .map(|action| operation_for_action(*action).to_string())
            })
            .or_else(|| Some(self.tool_name.clone()));
        provider.raw_args = self.arguments.clone();
        provider.raw_payload = self.raw_payload.clone();

        normalize_tool_call(ToolNormalizationInput {
            transport: descriptor
                .map(|descriptor| descriptor.transport)
                .unwrap_or(ToolTransport::DynamicTool),
            status,
            provider,
            item_type: Some("dynamicToolCall".to_string()),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostToolResult {
    pub output: Value,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub metadata: Value,
}

#[async_trait]
pub trait HostToolHandler: Send + Sync + 'static {
    fn descriptor(&self) -> HostToolDescriptor;

    async fn invoke(&self, invocation: HostToolInvocation)
    -> Result<HostToolResult, HostToolError>;
}

pub type DynHostToolHandler = Arc<dyn HostToolHandler>;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HostToolError {
    #[error("host tool name is empty")]
    EmptyName,
    #[error("host tool `{name}` is already registered")]
    DuplicateName { name: String },
    #[error("host tool `{name}` is not registered")]
    NotFound { name: String },
    #[error("server request kind `{kind:?}` cannot be converted to a host tool invocation")]
    UnsupportedServerRequest { kind: ServerRequestKind },
    #[error("server request is missing a tool name")]
    MissingToolName,
    #[error("host tool arguments exceed {limit} bytes")]
    ArgumentsTooLarge { limit: usize },
    #[error("host tool failed: {message}")]
    Handler { message: String },
}

#[derive(Default, Clone)]
pub struct HostToolRegistry {
    handlers: HashMap<String, DynHostToolHandler>,
    aliases: HashMap<String, String>,
}

impl HostToolRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_default_bridge_contracts() -> Self {
        let mut registry = Self::new();
        registry
            .register_default_bridge_contracts()
            .expect("default bridge host tool contracts are valid");
        registry
    }

    pub fn register_default_bridge_contracts(&mut self) -> Result<(), HostToolError> {
        self.register(Arc::new(UnavailableHostTool::new(
            browser_bridge_descriptor(),
        )))?;
        self.register(Arc::new(UnavailableHostTool::new(
            computer_bridge_descriptor(),
        )))?;
        Ok(())
    }

    pub fn register(&mut self, handler: DynHostToolHandler) -> Result<(), HostToolError> {
        let descriptor = handler.descriptor();
        let canonical = normalize_name(&descriptor.name)?;
        if self.handlers.contains_key(&canonical) || self.aliases.contains_key(&canonical) {
            return Err(HostToolError::DuplicateName { name: canonical });
        }
        for alias in &descriptor.aliases {
            let alias = normalize_name(alias)?;
            if self.handlers.contains_key(&alias) || self.aliases.contains_key(&alias) {
                return Err(HostToolError::DuplicateName { name: alias });
            }
        }

        for alias in &descriptor.aliases {
            self.aliases
                .insert(normalize_name(alias)?, canonical.clone());
        }
        self.handlers.insert(canonical, handler);
        Ok(())
    }

    #[must_use]
    pub fn descriptors(&self) -> Vec<HostToolDescriptor> {
        let mut descriptors = self
            .handlers
            .values()
            .map(|handler| handler.descriptor())
            .map(HostToolDescriptor::with_effective_capabilities)
            .collect::<Vec<_>>();
        descriptors.sort_by(|left, right| left.name.cmp(&right.name));
        descriptors
    }

    #[must_use]
    pub fn resolve(&self, name: &str) -> Option<(String, DynHostToolHandler)> {
        let normalized = normalize_name(name).ok()?;
        let canonical = self.aliases.get(&normalized).cloned().unwrap_or(normalized);
        self.handlers
            .get(&canonical)
            .cloned()
            .map(|handler| (canonical, handler))
    }

    pub fn invocation_from_server_request(
        &self,
        provider: ProviderKind,
        request: &NormalizedServerRequest,
    ) -> Result<HostToolInvocation, HostToolError> {
        let invocation = host_tool_invocation_from_server_request(provider, request)?;
        let (canonical, handler) =
            self.resolve(&invocation.tool_name)
                .ok_or_else(|| HostToolError::NotFound {
                    name: invocation.tool_name.clone(),
                })?;
        let descriptor = handler.descriptor();
        enforce_argument_limit(&invocation.arguments, descriptor.max_argument_bytes)?;
        Ok(HostToolInvocation {
            descriptor_name: Some(canonical),
            ..invocation
        })
    }

    pub async fn invoke_server_request(
        &self,
        provider: ProviderKind,
        request: &NormalizedServerRequest,
    ) -> Result<HostToolResult, HostToolError> {
        let invocation = self.invocation_from_server_request(provider, request)?;
        self.invoke_invocation(invocation).await
    }

    pub async fn invoke_invocation(
        &self,
        mut invocation: HostToolInvocation,
    ) -> Result<HostToolResult, HostToolError> {
        let descriptor_name = if let Some(descriptor_name) = invocation.descriptor_name.clone() {
            descriptor_name
        } else {
            let (canonical, _) =
                self.resolve(&invocation.tool_name)
                    .ok_or_else(|| HostToolError::NotFound {
                        name: invocation.tool_name.clone(),
                    })?;
            invocation.descriptor_name = Some(canonical.clone());
            canonical
        };
        let handler = self
            .handlers
            .get(&descriptor_name)
            .cloned()
            .ok_or_else(|| HostToolError::NotFound {
                name: descriptor_name.clone(),
            })?;
        let descriptor = handler.descriptor();
        enforce_argument_limit(&invocation.arguments, descriptor.max_argument_bytes)?;
        handler.invoke(invocation).await
    }
}

struct UnavailableHostTool {
    descriptor: HostToolDescriptor,
}

impl UnavailableHostTool {
    fn new(descriptor: HostToolDescriptor) -> Self {
        Self { descriptor }
    }
}

#[async_trait]
impl HostToolHandler for UnavailableHostTool {
    fn descriptor(&self) -> HostToolDescriptor {
        self.descriptor.clone()
    }

    async fn invoke(
        &self,
        _invocation: HostToolInvocation,
    ) -> Result<HostToolResult, HostToolError> {
        Err(HostToolError::Handler {
            message: format!(
                "{} bridge is not connected",
                serde_name(self.descriptor.surface)
            ),
        })
    }
}

pub fn host_tool_invocation_from_server_request(
    provider: ProviderKind,
    request: &NormalizedServerRequest,
) -> Result<HostToolInvocation, HostToolError> {
    match request.kind {
        ServerRequestKind::DynamicToolCall
        | ServerRequestKind::ToolUserInput
        | ServerRequestKind::McpElicitation => {}
        kind => return Err(HostToolError::UnsupportedServerRequest { kind }),
    }

    let tool_name = first_string([
        string_at_deep(&request.metadata, "toolName").as_deref(),
        string_at_deep(&request.metadata, "tool_name").as_deref(),
        string_at_deep(&request.metadata, "tool").as_deref(),
        string_at_deep(&request.metadata, "name").as_deref(),
        string_at_deep(&request.provider.raw_payload, "toolName").as_deref(),
        string_at_deep(&request.provider.raw_payload, "tool_name").as_deref(),
        string_at_deep(&request.provider.raw_payload, "tool").as_deref(),
        string_at_deep(&request.provider.raw_payload, "name").as_deref(),
    ])
    .ok_or(HostToolError::MissingToolName)?;

    let arguments = first_value([
        value_at_deep(&request.metadata, "arguments"),
        value_at_deep(&request.metadata, "args"),
        value_at_deep(&request.metadata, "input"),
        value_at_deep(&request.metadata, "params"),
        value_at_deep(&request.provider.raw_payload, "arguments"),
        value_at_deep(&request.provider.raw_payload, "args"),
        value_at_deep(&request.provider.raw_payload, "input"),
        value_at_deep(&request.provider.raw_payload, "params"),
    ])
    .unwrap_or(Value::Null);

    Ok(HostToolInvocation {
        request_id: request.request_id.clone(),
        provider,
        descriptor_name: None,
        tool_name,
        server_name: first_string([
            string_at_deep(&request.metadata, "serverName").as_deref(),
            string_at_deep(&request.metadata, "server_name").as_deref(),
            string_at_deep(&request.metadata, "server").as_deref(),
            string_at_deep(&request.provider.raw_payload, "serverName").as_deref(),
            string_at_deep(&request.provider.raw_payload, "server_name").as_deref(),
            string_at_deep(&request.provider.raw_payload, "server").as_deref(),
        ]),
        thread_id: request.thread_id.clone(),
        turn_id: request.turn_id.clone(),
        item_id: request.item_id.clone(),
        arguments,
        raw_payload: request.provider.raw_payload.clone(),
    })
}

fn enforce_argument_limit(arguments: &Value, limit: usize) -> Result<(), HostToolError> {
    let byte_len = serde_json::to_vec(arguments)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX);
    if byte_len > limit {
        return Err(HostToolError::ArgumentsTooLarge { limit });
    }
    Ok(())
}

fn operation_for_action(action: ToolActionKind) -> &'static str {
    match action {
        ToolActionKind::BrowserClick | ToolActionKind::ComputerClick => "click",
        ToolActionKind::BrowserType | ToolActionKind::ComputerType => "type",
        ToolActionKind::BrowserNavigate => "navigate_tab_url",
        ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot => "screenshot",
        ToolActionKind::BrowserInspect => "inspect",
        ToolActionKind::BrowserLogs | ToolActionKind::BrowserConsole => "console_logs",
        ToolActionKind::BrowserTab => "tab",
        ToolActionKind::BrowserScroll => "scroll",
        ToolActionKind::BrowserKey => "keypress",
        ToolActionKind::BrowserClipboard => "clipboard",
        ToolActionKind::BrowserWait => "wait",
        ToolActionKind::BrowserViewport => "resize_viewport",
        ToolActionKind::BrowserZoom => "zoom",
        ToolActionKind::ComputerScroll => "scroll",
        ToolActionKind::ComputerKey => "keypress",
        ToolActionKind::ComputerApp => "app",
        ToolActionKind::TerminalRun => "command",
        ToolActionKind::TerminalWrite => "stdin",
        ToolActionKind::TerminalResize => "resize",
        ToolActionKind::TerminalTerminate => "terminate",
        ToolActionKind::TerminalOutput => "output",
        ToolActionKind::FileRead => "read_file",
        ToolActionKind::FileEdit => "write_file",
        ToolActionKind::FilePatch => "apply_patch",
        ToolActionKind::FileSearch => "search_files",
        ToolActionKind::GitCommit => "git_commit",
        ToolActionKind::GitPush => "git_push",
        ToolActionKind::GithubIssue => "github_issue",
        ToolActionKind::GithubPullRequest => "github_pull_request",
        ToolActionKind::GithubCheck => "github_check",
        ToolActionKind::GithubCommit => "github_commit",
        ToolActionKind::GithubSearch => "github_search",
        ToolActionKind::WebSearch => "web_search",
        ToolActionKind::ImageView => "image_view",
        ToolActionKind::ImageGenerate => "image_generation",
        ToolActionKind::SubagentSpawn => "subagent_spawn",
        ToolActionKind::SubagentSteer => "subagent_steer",
        ToolActionKind::SubagentStop => "subagent_stop",
        ToolActionKind::PlanContinue => "plan_continue",
        ToolActionKind::PlanFork => "plan_fork",
        ToolActionKind::PlanSideImplementation => "plan_side_implementation",
        ToolActionKind::HandoffAgent => "handoff_agent",
        ToolActionKind::HandoffLocation => "handoff_location",
        ToolActionKind::ReviewStart => "review_start",
        ToolActionKind::SkillList => "skill_list",
        ToolActionKind::SkillRead => "skill_read",
        ToolActionKind::SkillInstall => "skill_install",
        ToolActionKind::SkillConfigure => "skill_configure",
        ToolActionKind::PluginList => "plugin_list",
        ToolActionKind::PluginRead => "plugin_read",
        ToolActionKind::PluginInstall => "plugin_install",
        ToolActionKind::PluginUninstall => "plugin_uninstall",
        ToolActionKind::PluginShare => "plugin_share",
        ToolActionKind::PluginMarketplaceAdd => "plugin_marketplace_add",
        ToolActionKind::PluginMarketplaceRemove => "plugin_marketplace_remove",
        ToolActionKind::PluginMarketplaceUpgrade => "plugin_marketplace_upgrade",
        ToolActionKind::AppList => "app_list",
        ToolActionKind::AppConfigure => "app_configure",
        ToolActionKind::ToolRun => "tool",
    }
}

fn operation_from_arguments(arguments: &Value) -> Option<String> {
    string_at_deep(arguments, "operation")
        .or_else(|| string_at_deep(arguments, "op"))
        .or_else(|| string_at_deep(arguments, "action"))
}

fn browser_bridge_descriptor() -> HostToolDescriptor {
    let mut descriptor = HostToolDescriptor::new(
        "browser.bridge",
        ToolTransport::BrowserBridge,
        ToolSurface::Browser,
    );
    descriptor.aliases = vec![
        "ace_browser".to_string(),
        "browser".to_string(),
        "browser_use".to_string(),
    ];
    descriptor.actions = vec![
        ToolActionKind::BrowserNavigate,
        ToolActionKind::BrowserClick,
        ToolActionKind::BrowserType,
        ToolActionKind::BrowserScroll,
        ToolActionKind::BrowserKey,
        ToolActionKind::BrowserScreenshot,
        ToolActionKind::BrowserInspect,
        ToolActionKind::BrowserLogs,
        ToolActionKind::BrowserConsole,
        ToolActionKind::BrowserTab,
        ToolActionKind::BrowserClipboard,
        ToolActionKind::BrowserWait,
        ToolActionKind::BrowserViewport,
        ToolActionKind::BrowserZoom,
    ];
    descriptor.capabilities = vec![
        ProviderCapability {
            key: "host_tool.browser.tabs".to_string(),
            version: 1,
        },
        ProviderCapability {
            key: "host_tool.bridge.status.unavailable".to_string(),
            version: 1,
        },
    ];
    descriptor.description =
        Some("App-owned Browser bridge contract; handler attaches from the UI process".to_string());
    descriptor.requires_user_approval = true;
    descriptor
}

fn computer_bridge_descriptor() -> HostToolDescriptor {
    let mut descriptor = HostToolDescriptor::new(
        "computer.bridge",
        ToolTransport::ComputerBridge,
        ToolSurface::Computer,
    );
    descriptor.aliases = vec![
        "ace_computer".to_string(),
        "computer".to_string(),
        "computer_use".to_string(),
        "computer-use".to_string(),
    ];
    descriptor.actions = vec![
        ToolActionKind::ComputerClick,
        ToolActionKind::ComputerType,
        ToolActionKind::ComputerScroll,
        ToolActionKind::ComputerKey,
        ToolActionKind::ComputerScreenshot,
        ToolActionKind::ComputerApp,
    ];
    descriptor.capabilities = vec![
        ProviderCapability {
            key: "host_tool.computer.accessibility".to_string(),
            version: 1,
        },
        ProviderCapability {
            key: "host_tool.bridge.status.unavailable".to_string(),
            version: 1,
        },
    ];
    descriptor.description = Some(
        "App-owned Computer Use bridge contract; handler attaches from the UI process".to_string(),
    );
    descriptor.requires_user_approval = true;
    descriptor
}

fn serde_name<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToString::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn dedupe_capabilities(mut capabilities: Vec<ProviderCapability>) -> Vec<ProviderCapability> {
    capabilities.sort_by(|left, right| {
        left.key
            .cmp(&right.key)
            .then_with(|| right.version.cmp(&left.version))
    });
    capabilities.dedup_by(|left, right| left.key == right.key);
    capabilities
}

fn normalize_name(name: &str) -> Result<String, HostToolError> {
    let normalized = name.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return Err(HostToolError::EmptyName);
    }
    Ok(normalized)
}

fn first_string<const N: usize>(values: [Option<&str>; N]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn first_value<const N: usize>(values: [Option<Value>; N]) -> Option<Value> {
    values.into_iter().flatten().next()
}

fn string_at_deep(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(Value::String(text)) = map.get(key) {
                return Some(text.clone());
            }
            map.values().find_map(|value| string_at_deep(value, key))
        }
        Value::Array(values) => values.iter().find_map(|value| string_at_deep(value, key)),
        _ => None,
    }
}

fn value_at_deep(value: &Value, key: &str) -> Option<Value> {
    match value {
        Value::Object(map) => {
            if let Some(value) = map.get(key) {
                return Some(value.clone());
            }
            map.values().find_map(|value| value_at_deep(value, key))
        }
        Value::Array(values) => values.iter().find_map(|value| value_at_deep(value, key)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::provider::{ProviderMetadata, ServerRequestKind};
    use serde_json::json;
    use std::sync::Mutex;

    struct RecordingTool {
        descriptor: HostToolDescriptor,
        invocations: Mutex<Vec<HostToolInvocation>>,
    }

    #[async_trait]
    impl HostToolHandler for RecordingTool {
        fn descriptor(&self) -> HostToolDescriptor {
            self.descriptor.clone()
        }

        async fn invoke(
            &self,
            invocation: HostToolInvocation,
        ) -> Result<HostToolResult, HostToolError> {
            self.invocations
                .lock()
                .expect("invocations")
                .push(invocation);
            Ok(HostToolResult {
                output: json!({ "ok": true }),
                metadata: Value::Null,
            })
        }
    }

    fn request(kind: ServerRequestKind, metadata: Value) -> NormalizedServerRequest {
        NormalizedServerRequest {
            kind,
            request_id: "42".to_string(),
            method: "dynamicTool/call".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("item-1".to_string()),
            prompt: Some("Run browser tool?".to_string()),
            scope: Some("tool".to_string()),
            title: None,
            selected_policy: None,
            detail: Default::default(),
            metadata,
            provider: ProviderMetadata {
                provider: "codex".to_string(),
                method: Some("dynamicTool/call".to_string()),
                schema_version: None,
                raw_payload: json!({
                    "toolName": "ace_browser",
                    "arguments": { "operation": "navigate_tab_url", "url": "http://localhost:5173" }
                }),
            },
        }
    }

    #[test]
    fn registry_resolves_canonical_names_and_aliases() {
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string(), "browser".to_string()];
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];
        descriptor.capabilities = vec![ProviderCapability {
            key: "host_tool.browser.tabs".to_string(),
            version: 2,
        }];

        let mut registry = HostToolRegistry::new();
        registry
            .register(Arc::new(RecordingTool {
                descriptor,
                invocations: Mutex::new(Vec::new()),
            }))
            .expect("register");

        assert!(registry.resolve("BROWSER.OPEN").is_some());
        assert!(registry.resolve("ace_browser").is_some());
        let descriptor = &registry.descriptors()[0];
        assert_eq!(descriptor.name, "browser.open");
        assert!(descriptor.capabilities.contains(&ProviderCapability {
            key: "host_tool.browser.tabs".to_string(),
            version: 2,
        }));
        assert!(descriptor.capabilities.contains(&ProviderCapability {
            key: "host_tool.transport.browser_bridge".to_string(),
            version: 1,
        }));
        assert!(descriptor.capabilities.contains(&ProviderCapability {
            key: "host_tool.surface.browser".to_string(),
            version: 1,
        }));
        assert!(descriptor.capabilities.contains(&ProviderCapability {
            key: "host_tool.action.browser.navigate".to_string(),
            version: 1,
        }));
    }

    #[test]
    fn effective_capabilities_are_stable_and_versioned() {
        let mut descriptor = HostToolDescriptor::new(
            "computer.click",
            ToolTransport::ComputerBridge,
            ToolSurface::Computer,
        );
        descriptor.actions = vec![ToolActionKind::ComputerClick, ToolActionKind::ComputerClick];
        descriptor.capabilities = vec![
            ProviderCapability {
                key: "host_tool.action.computer.click".to_string(),
                version: 3,
            },
            ProviderCapability {
                key: "host_tool.computer.accessibility".to_string(),
                version: 1,
            },
        ];

        let capabilities = descriptor.effective_capabilities();
        assert_eq!(
            capabilities
                .iter()
                .filter(|capability| capability.key == "host_tool.action.computer.click")
                .count(),
            1
        );
        assert!(capabilities.contains(&ProviderCapability {
            key: "host_tool.action.computer.click".to_string(),
            version: 3,
        }));
        assert!(capabilities.contains(&ProviderCapability {
            key: "host_tool.transport.computer_bridge".to_string(),
            version: 1,
        }));
        assert!(capabilities.contains(&ProviderCapability {
            key: "host_tool.surface.computer".to_string(),
            version: 1,
        }));
        assert!(capabilities.contains(&ProviderCapability {
            key: "host_tool.computer.accessibility".to_string(),
            version: 1,
        }));
    }

    #[test]
    fn registry_rejects_duplicate_aliases() {
        let mut first = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        first.aliases = vec!["ace_browser".to_string()];
        let mut second = HostToolDescriptor::new(
            "browser.click",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        second.aliases = vec!["ACE_BROWSER".to_string()];

        let mut registry = HostToolRegistry::new();
        registry
            .register(Arc::new(RecordingTool {
                descriptor: first,
                invocations: Mutex::new(Vec::new()),
            }))
            .expect("register first");
        let error = registry
            .register(Arc::new(RecordingTool {
                descriptor: second,
                invocations: Mutex::new(Vec::new()),
            }))
            .expect_err("duplicate alias");
        assert_eq!(
            error,
            HostToolError::DuplicateName {
                name: "ace_browser".to_string()
            }
        );
    }

    #[test]
    fn dynamic_tool_server_request_becomes_host_tool_invocation() {
        let request = request(
            ServerRequestKind::DynamicToolCall,
            json!({
                "toolName": "ace_browser",
                "arguments": {
                    "operation": "navigate_tab_url",
                    "url": "http://localhost:5173"
                }
            }),
        );

        let invocation = host_tool_invocation_from_server_request(ProviderKind::Codex, &request)
            .expect("invocation");
        assert_eq!(invocation.request_id, "42");
        assert_eq!(invocation.provider, ProviderKind::Codex);
        assert_eq!(invocation.tool_name, "ace_browser");
        assert_eq!(invocation.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(invocation.arguments["operation"], "navigate_tab_url");
        assert_eq!(invocation.raw_payload["toolName"], "ace_browser");
    }

    #[test]
    fn invocation_keeps_semantic_browser_display() {
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];
        let request = request(ServerRequestKind::DynamicToolCall, json!({}));
        let invocation = host_tool_invocation_from_server_request(ProviderKind::Codex, &request)
            .expect("invocation");

        let tool = invocation.semantic_tool(Some(&descriptor), ToolRunStatus::Started);
        assert_eq!(tool.transport, ToolTransport::BrowserBridge);
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserNavigate);
        assert_eq!(
            tool.display.title,
            "Opening http://localhost:5173 in Browser"
        );
        assert_eq!(tool.provider.raw_payload["toolName"], "ace_browser");
    }

    #[test]
    fn descriptor_action_drives_semantic_display_when_arguments_are_sparse() {
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.actions = vec![ToolActionKind::BrowserNavigate];
        let invocation = HostToolInvocation {
            request_id: "42".to_string(),
            provider: ProviderKind::Codex,
            descriptor_name: Some("browser.open".to_string()),
            tool_name: "ace_browser".to_string(),
            server_name: None,
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("tool-1".to_string()),
            arguments: Value::Null,
            raw_payload: json!({ "toolName": "ace_browser" }),
        };

        let tool = invocation.semantic_tool(Some(&descriptor), ToolRunStatus::Started);
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserNavigate);
        assert_eq!(tool.display.title, "Opening Browser page");
    }

    #[tokio::test]
    async fn registry_invokes_registered_tool_and_enforces_argument_limit() {
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string()];
        descriptor.max_argument_bytes = 64;
        let handler = Arc::new(RecordingTool {
            descriptor,
            invocations: Mutex::new(Vec::new()),
        });
        let mut registry = HostToolRegistry::new();
        registry.register(handler.clone()).expect("register");

        let result = registry
            .invoke_server_request(
                ProviderKind::Codex,
                &request(
                    ServerRequestKind::DynamicToolCall,
                    json!({ "toolName": "ace_browser", "arguments": { "url": "x" } }),
                ),
            )
            .await
            .expect("invoke");
        assert_eq!(result.output["ok"], true);
        assert_eq!(handler.invocations.lock().expect("invocations").len(), 1);

        let error = registry
            .invoke_server_request(
                ProviderKind::Codex,
                &request(
                    ServerRequestKind::DynamicToolCall,
                    json!({
                        "toolName": "ace_browser",
                        "arguments": { "text": "x".repeat(128) }
                    }),
                ),
            )
            .await
            .expect_err("argument limit");
        assert_eq!(error, HostToolError::ArgumentsTooLarge { limit: 64 });
    }

    #[tokio::test]
    async fn registry_invokes_prebuilt_invocation_without_reparsing_request() {
        let mut descriptor = HostToolDescriptor::new(
            "browser.open",
            ToolTransport::BrowserBridge,
            ToolSurface::Browser,
        );
        descriptor.aliases = vec!["ace_browser".to_string()];
        let handler = Arc::new(RecordingTool {
            descriptor,
            invocations: Mutex::new(Vec::new()),
        });
        let mut registry = HostToolRegistry::new();
        registry.register(handler.clone()).expect("register");

        let result = registry
            .invoke_invocation(HostToolInvocation {
                request_id: "42".to_string(),
                provider: ProviderKind::Codex,
                descriptor_name: None,
                tool_name: "ace_browser".to_string(),
                server_name: None,
                thread_id: Some("thread-1".to_string()),
                turn_id: None,
                item_id: Some("tool-1".to_string()),
                arguments: json!({ "url": "http://localhost:5173" }),
                raw_payload: json!({ "toolName": "ace_browser" }),
            })
            .await
            .expect("invoke");
        assert_eq!(result.output["ok"], true);
        let invocations = handler.invocations.lock().expect("invocations");
        assert_eq!(invocations.len(), 1);
        assert_eq!(
            invocations[0].descriptor_name.as_deref(),
            Some("browser.open")
        );
    }

    #[tokio::test]
    async fn default_bridge_contracts_are_advertised_but_unavailable_until_attached() {
        let registry = HostToolRegistry::with_default_bridge_contracts();
        let descriptors = registry.descriptors();
        assert_eq!(
            descriptors
                .iter()
                .map(|descriptor| descriptor.name.as_str())
                .collect::<Vec<_>>(),
            ["browser.bridge", "computer.bridge"]
        );

        let browser = descriptors
            .iter()
            .find(|descriptor| descriptor.name == "browser.bridge")
            .expect("browser descriptor");
        assert_eq!(browser.transport, ToolTransport::BrowserBridge);
        assert_eq!(browser.surface, ToolSurface::Browser);
        assert!(browser.aliases.contains(&"ace_browser".to_string()));
        assert!(browser.actions.contains(&ToolActionKind::BrowserClick));
        assert!(browser.actions.contains(&ToolActionKind::BrowserNavigate));
        assert!(
            browser
                .capabilities
                .iter()
                .any(|capability| capability.key == "host_tool.bridge.status.unavailable")
        );

        let computer = descriptors
            .iter()
            .find(|descriptor| descriptor.name == "computer.bridge")
            .expect("computer descriptor");
        assert_eq!(computer.transport, ToolTransport::ComputerBridge);
        assert_eq!(computer.surface, ToolSurface::Computer);
        assert!(computer.aliases.contains(&"computer_use".to_string()));
        assert!(computer.actions.contains(&ToolActionKind::ComputerClick));
        assert!(
            computer
                .actions
                .contains(&ToolActionKind::ComputerScreenshot)
        );

        let error = registry
            .invoke_server_request(
                ProviderKind::Codex,
                &request(
                    ServerRequestKind::DynamicToolCall,
                    json!({
                        "toolName": "ace_browser",
                        "arguments": {
                            "operation": "cua_click",
                            "label": "Deploy"
                        }
                    }),
                ),
            )
            .await
            .expect_err("bridge unavailable");
        assert_eq!(
            error,
            HostToolError::Handler {
                message: "browser bridge is not connected".to_string()
            }
        );
    }

    #[test]
    fn invocation_prefers_provider_operation_over_default_descriptor_action() {
        let registry = HostToolRegistry::with_default_bridge_contracts();
        let (_, handler) = registry.resolve("ace_browser").expect("browser bridge");
        let descriptor = handler.descriptor();
        let invocation = HostToolInvocation {
            request_id: "42".to_string(),
            provider: ProviderKind::Codex,
            descriptor_name: Some("browser.bridge".to_string()),
            tool_name: "ace_browser".to_string(),
            server_name: None,
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            item_id: Some("tool-1".to_string()),
            arguments: json!({
                "operation": "cua_click",
                "label": "Deploy"
            }),
            raw_payload: json!({ "toolName": "ace_browser" }),
        };

        let tool = invocation.semantic_tool(Some(&descriptor), ToolRunStatus::Completed);
        assert_eq!(tool.action, ToolActionKind::BrowserClick);
        assert_eq!(tool.display.title, "Clicked Deploy in Browser");
    }

    #[test]
    fn unsupported_server_requests_are_not_host_tools() {
        let error = host_tool_invocation_from_server_request(
            ProviderKind::Codex,
            &request(ServerRequestKind::CommandApproval, json!({})),
        )
        .expect_err("unsupported request");
        assert_eq!(
            error,
            HostToolError::UnsupportedServerRequest {
                kind: ServerRequestKind::CommandApproval
            }
        );
    }
}
