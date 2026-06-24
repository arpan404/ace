use crate::{
    AppServerTransport, CodexError, CodexStdioTransport, CodexTransportRuntimeState,
    CodexUnixSocketTransport, CodexWebSocketTransport, Result, normalize_codex_inbound_event,
};
use crate::{
    CodexGoalSet, CodexGuardianDeniedActionApproval, CodexHandoffToAgent, CodexPermissionCatalog,
    CodexSubagentSteer,
};
use ace_core::{ProviderCapability, ProviderKind};
use ace_runtime::provider::{
    ProviderDescriptor, ProviderDriver, ProviderDriverError, ProviderEvent, ProviderFeature,
    ProviderRequest,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

pub const DEFAULT_CODEX_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
pub const CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAME: &str = "image_generation_prehook";
pub const CODEX_IMAGE_GENERATION_PREFLIGHT_RESULT_TEXT: &str = "Ace image generation preflight is active. Continue by using the native image generation capability now; this tool result is not the final image.";

const CODEX_IMAGE_GENERATION_PREFLIGHT_INSTRUCTIONS: &str = r#"## Image Generation Preflight

When you are about to create or edit a raster image with the native image generation capability, first call the `image_generation_prehook` tool exactly once for that image request. This tool only opens Ace's live image placeholder; it does not create the image. After it returns, continue with the native image generation capability and do not treat the preflight tool result as the final answer."#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexClientInfo {
    pub name: String,
    pub title: String,
    pub version: String,
}

impl Default for CodexClientInfo {
    fn default() -> Self {
        Self {
            name: "ace_desktop".to_string(),
            title: "Ace Desktop".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodexTransportConfig {
    Stdio { command: String, args: Vec<String> },
    UnixSocket { path: PathBuf },
    WebSocket { url: String },
}

impl CodexTransportConfig {
    #[must_use]
    pub fn name(&self) -> &'static str {
        match self {
            Self::Stdio { .. } => "stdio",
            Self::UnixSocket { .. } => "unix_socket",
            Self::WebSocket { .. } => "websocket",
        }
    }

    #[must_use]
    pub fn stdio(command: impl Into<String>, args: Vec<String>) -> Self {
        Self::Stdio {
            command: command.into(),
            args,
        }
    }

    #[must_use]
    pub fn unix_socket(path: impl Into<PathBuf>) -> Self {
        Self::UnixSocket { path: path.into() }
    }

    #[must_use]
    pub fn websocket(url: impl Into<String>) -> Self {
        Self::WebSocket { url: url.into() }
    }
}

impl Default for CodexTransportConfig {
    fn default() -> Self {
        Self::Stdio {
            command: "codex".to_string(),
            args: vec!["app-server".to_string()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexConfig {
    pub transport: CodexTransportConfig,
    pub client_info: CodexClientInfo,
    pub request_timeout: Duration,
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            transport: CodexTransportConfig::default(),
            client_info: CodexClientInfo::default(),
            request_timeout: DEFAULT_CODEX_REQUEST_TIMEOUT,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadStart {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "model_provider")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approval_policy")]
    pub approval_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approvals_reviewer")]
    pub approvals_reviewer: Option<String>,
    #[serde(default)]
    pub ephemeral: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "developer_instructions")]
    pub developer_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[serde(alias = "dynamic_tools")]
    pub dynamic_tools: Vec<Value>,
    #[serde(default, skip_serializing)]
    #[serde(alias = "image_generation_preflight_enabled")]
    pub image_generation_preflight_enabled: bool,
}

impl CodexThreadStart {
    #[must_use]
    pub fn with_image_generation_preflight(mut self) -> Self {
        self.enable_image_generation_preflight();
        self
    }

    pub fn enable_image_generation_preflight(&mut self) {
        self.image_generation_preflight_enabled = true;
        self.ensure_image_generation_preflight();
    }

    #[must_use]
    pub fn prepare_for_provider(mut self) -> Self {
        if self.image_generation_preflight_enabled {
            self.ensure_image_generation_preflight();
        }
        self
    }

    fn ensure_image_generation_preflight(&mut self) {
        if !self
            .dynamic_tools
            .iter()
            .any(is_image_generation_preflight_tool)
        {
            self.dynamic_tools.push(image_generation_preflight_tool());
        }
        append_instruction_string(&mut self.developer_instructions);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnStart {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "reasoning_effort")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "sandbox_policy")]
    pub sandbox_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approval_policy")]
    pub approval_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approvals_reviewer")]
    pub approvals_reviewer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "collaboration_mode")]
    pub collaboration_mode: Option<Value>,
    #[serde(default, skip_serializing)]
    #[serde(alias = "image_generation_preflight_enabled")]
    pub image_generation_preflight_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnSteer {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(alias = "expected_turn_id")]
    pub expected_turn_id: String,
    pub input: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "client_user_message_id")]
    pub client_user_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexReviewStart {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "base_turn_id")]
    pub base_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexNamedQuery {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillRequest {
    pub skill: String,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillsConfigWrite {
    #[serde(default)]
    pub config: Value,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSkillsExtraRootsSet {
    #[serde(default)]
    pub roots: Vec<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginRequest {
    pub plugin: String,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginShareRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "share_id")]
    pub share_id: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginShareSave {
    pub plugin: String,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginShareUpdateTargets {
    #[serde(alias = "share_id")]
    pub share_id: String,
    #[serde(default)]
    pub targets: Vec<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppConfigWrite {
    pub app: String,
    #[serde(default)]
    pub config: Value,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexMarketplaceRequest {
    pub plugin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, flatten, skip_serializing_if = "serde_json::Map::is_empty")]
    pub extra: serde_json::Map<String, Value>,
}

impl CodexTurnStart {
    #[must_use]
    pub fn plan(
        thread_id: impl Into<String>,
        prompt: impl Into<String>,
        model: String,
        reasoning_effort: Option<String>,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            input: vec![json!({ "type": "text", "text": prompt.into() })],
            model: None,
            reasoning_effort: None,
            cwd: None,
            sandbox_policy: None,
            approval_policy: None,
            approvals_reviewer: None,
            collaboration_mode: Some(json!({
                "mode": "plan",
                "settings": {
                    "model": model,
                    "developer_instructions": null,
                    "reasoning_effort": reasoning_effort,
                }
            })),
            image_generation_preflight_enabled: false,
        }
    }

    #[must_use]
    pub fn is_plan_mode(&self) -> bool {
        self.collaboration_mode
            .as_ref()
            .and_then(|mode| mode.get("mode"))
            .and_then(Value::as_str)
            == Some("plan")
    }

    #[must_use]
    pub fn with_image_generation_preflight(mut self) -> Self {
        self.enable_image_generation_preflight();
        self
    }

    pub fn enable_image_generation_preflight(&mut self) {
        self.image_generation_preflight_enabled = true;
        self.ensure_image_generation_preflight();
    }

    fn prepare_for_provider(mut self) -> Self {
        if self.image_generation_preflight_enabled {
            self.ensure_image_generation_preflight();
        }
        self
    }

    fn ensure_image_generation_preflight(&mut self) {
        append_image_generation_preflight_instructions(&mut self.collaboration_mode);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexPlanImplementation {
    #[serde(alias = "thread_id")]
    pub thread_id: String,
    pub plan: Value,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "reasoning_effort")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "sandbox_policy")]
    pub sandbox_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approval_policy")]
    pub approval_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(alias = "approvals_reviewer")]
    pub approvals_reviewer: Option<String>,
}

impl CodexPlanImplementation {
    #[must_use]
    pub fn into_turn_start(self, thread_id: String) -> CodexTurnStart {
        CodexTurnStart {
            thread_id,
            input: vec![json!({ "type": "text", "text": self.prompt })],
            model: self.model,
            reasoning_effort: self.reasoning_effort,
            cwd: self.cwd,
            sandbox_policy: self.sandbox_policy,
            approval_policy: self.approval_policy,
            approvals_reviewer: self.approvals_reviewer,
            collaboration_mode: None,
            image_generation_preflight_enabled: false,
        }
    }
}

#[must_use]
pub fn image_generation_preflight_result() -> Value {
    json!({
        "success": true,
        "contentItems": [
            {
                "type": "inputText",
                "text": CODEX_IMAGE_GENERATION_PREFLIGHT_RESULT_TEXT,
            }
        ],
    })
}

#[must_use]
pub fn is_image_generation_preflight_request(method: &str, params: &Value) -> bool {
    if method != "item/tool/call" && method != "dynamicTool/call" {
        return false;
    }
    dynamic_tool_name(params)
        .as_deref()
        .map(normalized_dynamic_tool_name)
        .is_some_and(|tool| {
            matches!(
                tool.as_str(),
                "image_generation_prehook"
                    | "image generation prehook"
                    | "imagegen"
                    | "image gen"
                    | "image generation"
            )
        })
}

fn image_generation_preflight_tool() -> Value {
    json!({
        "name": CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAME,
        "description": "Open Ace's live image-generation placeholder before using the native image generation capability. This tool does not generate an image; call it once immediately before native raster image generation.",
        "inputSchema": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Brief description of the image that will be generated."
                },
                "size": {
                    "type": "string",
                    "description": "Requested image dimensions, such as 1536x1024 or 1024x1536."
                },
                "width": {
                    "type": "number",
                    "description": "Requested image width in pixels, when known."
                },
                "height": {
                    "type": "number",
                    "description": "Requested image height in pixels, when known."
                },
                "aspectRatio": {
                    "type": "string",
                    "description": "Requested aspect ratio, when known."
                }
            }
        }
    })
}

fn is_image_generation_preflight_tool(tool: &Value) -> bool {
    tool.get("name")
        .and_then(Value::as_str)
        .map(normalized_dynamic_tool_name)
        .is_some_and(|tool| tool == "image generation prehook")
}

fn append_image_generation_preflight_instructions(collaboration_mode: &mut Option<Value>) {
    let settings = collaboration_mode
        .get_or_insert_with(|| json!({ "mode": "default", "settings": {} }))
        .as_object_mut()
        .and_then(|mode| mode.get_mut("settings"))
        .and_then(Value::as_object_mut);
    let Some(settings) = settings else {
        return;
    };
    let existing = settings
        .get("developer_instructions")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut instructions = if existing.is_empty() {
        None
    } else {
        Some(existing.to_string())
    };
    append_instruction_string(&mut instructions);
    if let Some(instructions) = instructions {
        settings.insert(
            "developer_instructions".to_string(),
            Value::String(instructions),
        );
    }
}

fn append_instruction_string(instructions: &mut Option<String>) {
    if instructions
        .as_deref()
        .is_some_and(|existing| existing.contains("Image Generation Preflight"))
    {
        return;
    }
    *instructions = Some(match instructions.take() {
        Some(existing) if !existing.trim().is_empty() => {
            format!("{existing}\n\n{CODEX_IMAGE_GENERATION_PREFLIGHT_INSTRUCTIONS}")
        }
        _ => CODEX_IMAGE_GENERATION_PREFLIGHT_INSTRUCTIONS.to_string(),
    });
}

fn dynamic_tool_name(params: &Value) -> Option<String> {
    string_at(params, "tool")
        .or_else(|| string_at(params, "toolName"))
        .or_else(|| string_at(params, "tool_name"))
        .or_else(|| {
            params
                .get("tool")
                .and_then(|tool| tool.get("name"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
}

fn normalized_dynamic_tool_name(name: impl AsRef<str>) -> String {
    name.as_ref()
        .trim()
        .to_ascii_lowercase()
        .replace(['-', '_'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexProviderRequest {
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Clone)]
pub struct CodexClient<T: AppServerTransport> {
    transport: Arc<T>,
    timeout: Duration,
    initialize_result: Arc<StdMutex<Option<Value>>>,
}

impl CodexClient<CodexStdioTransport> {
    pub async fn spawn(config: CodexConfig) -> Result<Self> {
        let CodexTransportConfig::Stdio { command, args } = &config.transport else {
            return Err(CodexError::InvalidMessage(
                "CodexClient::spawn requires stdio transport config".to_string(),
            ));
        };
        let transport = CodexStdioTransport::spawn(command, args).await?;
        let client = Self::new(transport, config.request_timeout);
        client.initialize(config.client_info).await?;
        Ok(client)
    }
}

impl CodexClient<CodexUnixSocketTransport> {
    pub async fn connect_unix(config: CodexConfig) -> Result<Self> {
        let CodexTransportConfig::UnixSocket { path } = &config.transport else {
            return Err(CodexError::InvalidMessage(
                "CodexClient::connect_unix requires Unix socket transport config".to_string(),
            ));
        };
        let transport = CodexUnixSocketTransport::connect(path).await?;
        let client = Self::new(transport, config.request_timeout);
        client.initialize(config.client_info).await?;
        Ok(client)
    }
}

impl CodexClient<CodexWebSocketTransport> {
    pub async fn connect_websocket(config: CodexConfig) -> Result<Self> {
        let CodexTransportConfig::WebSocket { url } = &config.transport else {
            return Err(CodexError::InvalidMessage(
                "CodexClient::connect_websocket requires websocket transport config".to_string(),
            ));
        };
        let transport = CodexWebSocketTransport::connect(url).await?;
        let client = Self::new(transport, config.request_timeout);
        client.initialize(config.client_info).await?;
        Ok(client)
    }
}

#[derive(Clone)]
pub enum CodexLiveClient {
    Stdio(CodexClient<CodexStdioTransport>),
    UnixSocket(CodexClient<CodexUnixSocketTransport>),
    WebSocket(CodexClient<CodexWebSocketTransport>),
}

impl CodexLiveClient {
    pub async fn connect(config: CodexConfig) -> Result<Self> {
        match &config.transport {
            CodexTransportConfig::Stdio { .. } => CodexClient::spawn(config).await.map(Self::Stdio),
            CodexTransportConfig::UnixSocket { .. } => CodexClient::connect_unix(config)
                .await
                .map(Self::UnixSocket),
            CodexTransportConfig::WebSocket { .. } => CodexClient::connect_websocket(config)
                .await
                .map(Self::WebSocket),
        }
    }

    #[must_use]
    pub fn transport_name(&self) -> &'static str {
        match self {
            Self::Stdio(_) => "stdio",
            Self::UnixSocket(_) => "unix_socket",
            Self::WebSocket(_) => "websocket",
        }
    }

    pub async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.raw_request(method, params).await,
            Self::UnixSocket(client) => client.raw_request(method, params).await,
            Self::WebSocket(client) => client.raw_request(method, params).await,
        }
    }

    pub async fn next_provider_events(&self) -> Option<Vec<ProviderEvent>> {
        match self {
            Self::Stdio(client) => client.next_provider_events().await,
            Self::UnixSocket(client) => client.next_provider_events().await,
            Self::WebSocket(client) => client.next_provider_events().await,
        }
    }

    pub async fn stderr_tail(&self) -> Vec<String> {
        match self {
            Self::Stdio(client) => client.stderr_tail().await,
            Self::UnixSocket(client) => client.stderr_tail().await,
            Self::WebSocket(client) => client.stderr_tail().await,
        }
    }

    pub async fn shutdown(&self, timeout: Duration) -> Result<()> {
        match self {
            Self::Stdio(client) => client.shutdown(timeout).await,
            Self::UnixSocket(client) => client.shutdown(timeout).await,
            Self::WebSocket(client) => client.shutdown(timeout).await,
        }
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        match self {
            Self::Stdio(client) => client.is_closed(),
            Self::UnixSocket(client) => client.is_closed(),
            Self::WebSocket(client) => client.is_closed(),
        }
    }

    #[must_use]
    pub fn is_initialized(&self) -> bool {
        match self {
            Self::Stdio(client) => client.is_initialized(),
            Self::UnixSocket(client) => client.is_initialized(),
            Self::WebSocket(client) => client.is_initialized(),
        }
    }

    #[must_use]
    pub fn initialize_result(&self) -> Option<Value> {
        match self {
            Self::Stdio(client) => client.initialize_result(),
            Self::UnixSocket(client) => client.initialize_result(),
            Self::WebSocket(client) => client.initialize_result(),
        }
    }

    pub async fn runtime_state(&self) -> CodexTransportRuntimeState {
        match self {
            Self::Stdio(client) => client.runtime_state().await,
            Self::UnixSocket(client) => client.runtime_state().await,
            Self::WebSocket(client) => client.runtime_state().await,
        }
    }

    pub async fn respond_tool_result(&self, request_id: i64, result: Value) -> Result<()> {
        match self {
            Self::Stdio(client) => client.respond_tool_result(request_id, result).await,
            Self::UnixSocket(client) => client.respond_tool_result(request_id, result).await,
            Self::WebSocket(client) => client.respond_tool_result(request_id, result).await,
        }
    }

    pub async fn respond_tool_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()> {
        match self {
            Self::Stdio(client) => client.respond_tool_error(request_id, code, message).await,
            Self::UnixSocket(client) => client.respond_tool_error(request_id, code, message).await,
            Self::WebSocket(client) => client.respond_tool_error(request_id, code, message).await,
        }
    }

    pub async fn start_thread(&self, request: CodexThreadStart) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.start_thread(request).await,
            Self::UnixSocket(client) => client.start_thread(request).await,
            Self::WebSocket(client) => client.start_thread(request).await,
        }
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.resume_thread(thread_id).await,
            Self::UnixSocket(client) => client.resume_thread(thread_id).await,
            Self::WebSocket(client) => client.resume_thread(thread_id).await,
        }
    }

    pub async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fork_thread(thread_id, ephemeral).await,
            Self::UnixSocket(client) => client.fork_thread(thread_id, ephemeral).await,
            Self::WebSocket(client) => client.fork_thread(thread_id, ephemeral).await,
        }
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.read_thread(thread_id).await,
            Self::UnixSocket(client) => client.read_thread(thread_id).await,
            Self::WebSocket(client) => client.read_thread(thread_id).await,
        }
    }

    pub async fn list_threads(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.list_threads(params).await,
            Self::UnixSocket(client) => client.list_threads(params).await,
            Self::WebSocket(client) => client.list_threads(params).await,
        }
    }

    pub async fn list_loaded_threads(&self) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.list_loaded_threads().await,
            Self::UnixSocket(client) => client.list_loaded_threads().await,
            Self::WebSocket(client) => client.list_loaded_threads().await,
        }
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.archive_thread(thread_id).await,
            Self::UnixSocket(client) => client.archive_thread(thread_id).await,
            Self::WebSocket(client) => client.archive_thread(thread_id).await,
        }
    }

    pub async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.unarchive_thread(thread_id).await,
            Self::UnixSocket(client) => client.unarchive_thread(thread_id).await,
            Self::WebSocket(client) => client.unarchive_thread(thread_id).await,
        }
    }

    pub async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.delete_thread(thread_id).await,
            Self::UnixSocket(client) => client.delete_thread(thread_id).await,
            Self::WebSocket(client) => client.delete_thread(thread_id).await,
        }
    }

    pub async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.unsubscribe_thread(thread_id).await,
            Self::UnixSocket(client) => client.unsubscribe_thread(thread_id).await,
            Self::WebSocket(client) => client.unsubscribe_thread(thread_id).await,
        }
    }

    pub async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.set_thread_name(thread_id, name).await,
            Self::UnixSocket(client) => client.set_thread_name(thread_id, name).await,
            Self::WebSocket(client) => client.set_thread_name(thread_id, name).await,
        }
    }

    pub async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.update_thread_metadata(thread_id, metadata).await,
            Self::UnixSocket(client) => client.update_thread_metadata(thread_id, metadata).await,
            Self::WebSocket(client) => client.update_thread_metadata(thread_id, metadata).await,
        }
    }

    pub async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.compact_thread(thread_id).await,
            Self::UnixSocket(client) => client.compact_thread(thread_id).await,
            Self::WebSocket(client) => client.compact_thread(thread_id).await,
        }
    }

    pub async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.rollback_thread(thread_id, turn_id).await,
            Self::UnixSocket(client) => client.rollback_thread(thread_id, turn_id).await,
            Self::WebSocket(client) => client.rollback_thread(thread_id, turn_id).await,
        }
    }

    pub async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.inject_thread_items(thread_id, items).await,
            Self::UnixSocket(client) => client.inject_thread_items(thread_id, items).await,
            Self::WebSocket(client) => client.inject_thread_items(thread_id, items).await,
        }
    }

    pub async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.start_turn(request).await,
            Self::UnixSocket(client) => client.start_turn(request).await,
            Self::WebSocket(client) => client.start_turn(request).await,
        }
    }

    pub async fn steer_turn(&self, request: CodexTurnSteer) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.steer_turn(request).await,
            Self::UnixSocket(client) => client.steer_turn(request).await,
            Self::WebSocket(client) => client.steer_turn(request).await,
        }
    }

    pub async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.continue_plan_in_thread(request).await,
            Self::UnixSocket(client) => client.continue_plan_in_thread(request).await,
            Self::WebSocket(client) => client.continue_plan_in_thread(request).await,
        }
    }

    pub async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fork_plan_for_implementation(request).await,
            Self::UnixSocket(client) => client.fork_plan_for_implementation(request).await,
            Self::WebSocket(client) => client.fork_plan_for_implementation(request).await,
        }
    }

    pub async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.side_implementation(request).await,
            Self::UnixSocket(client) => client.side_implementation(request).await,
            Self::WebSocket(client) => client.side_implementation(request).await,
        }
    }

    pub async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.interrupt_turn(thread_id).await,
            Self::UnixSocket(client) => client.interrupt_turn(thread_id).await,
            Self::WebSocket(client) => client.interrupt_turn(thread_id).await,
        }
    }

    pub async fn config_requirements_read(&self) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.config_requirements_read().await,
            Self::UnixSocket(client) => client.config_requirements_read().await,
            Self::WebSocket(client) => client.config_requirements_read().await,
        }
    }

    pub async fn permission_profile_list(&self) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.permission_profile_list().await,
            Self::UnixSocket(client) => client.permission_profile_list().await,
            Self::WebSocket(client) => client.permission_profile_list().await,
        }
    }

    pub async fn permission_catalog(&self) -> Result<CodexPermissionCatalog> {
        match self {
            Self::Stdio(client) => client.permission_catalog().await,
            Self::UnixSocket(client) => client.permission_catalog().await,
            Self::WebSocket(client) => client.permission_catalog().await,
        }
    }

    pub async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.approve_guardian_denied_action(request).await,
            Self::UnixSocket(client) => client.approve_guardian_denied_action(request).await,
            Self::WebSocket(client) => client.approve_guardian_denied_action(request).await,
        }
    }

    pub async fn goal_set(&self, request: CodexGoalSet) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.goal_set(request).await,
            Self::UnixSocket(client) => client.goal_set(request).await,
            Self::WebSocket(client) => client.goal_set(request).await,
        }
    }

    pub async fn goal_get(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.goal_get(thread_id).await,
            Self::UnixSocket(client) => client.goal_get(thread_id).await,
            Self::WebSocket(client) => client.goal_get(thread_id).await,
        }
    }

    pub async fn goal_clear(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.goal_clear(thread_id).await,
            Self::UnixSocket(client) => client.goal_clear(thread_id).await,
            Self::WebSocket(client) => client.goal_clear(thread_id).await,
        }
    }

    pub async fn goal_pause(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.goal_pause(thread_id).await,
            Self::UnixSocket(client) => client.goal_pause(thread_id).await,
            Self::WebSocket(client) => client.goal_pause(thread_id).await,
        }
    }

    pub async fn goal_resume(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.goal_resume(thread_id).await,
            Self::UnixSocket(client) => client.goal_resume(thread_id).await,
            Self::WebSocket(client) => client.goal_resume(thread_id).await,
        }
    }

    pub async fn subagent_list(&self, thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.subagent_list(thread_id).await,
            Self::UnixSocket(client) => client.subagent_list(thread_id).await,
            Self::WebSocket(client) => client.subagent_list(thread_id).await,
        }
    }

    pub async fn subagent_read(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.subagent_read(thread_id, subagent_thread_id).await,
            Self::UnixSocket(client) => client.subagent_read(thread_id, subagent_thread_id).await,
            Self::WebSocket(client) => client.subagent_read(thread_id, subagent_thread_id).await,
        }
    }

    pub async fn subagent_steer(&self, request: CodexSubagentSteer) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.subagent_steer(request).await,
            Self::UnixSocket(client) => client.subagent_steer(request).await,
            Self::WebSocket(client) => client.subagent_steer(request).await,
        }
    }

    pub async fn subagent_stop(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.subagent_stop(thread_id, subagent_thread_id).await,
            Self::UnixSocket(client) => client.subagent_stop(thread_id, subagent_thread_id).await,
            Self::WebSocket(client) => client.subagent_stop(thread_id, subagent_thread_id).await,
        }
    }

    pub async fn subagent_close(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.subagent_close(thread_id, subagent_thread_id).await,
            Self::UnixSocket(client) => client.subagent_close(thread_id, subagent_thread_id).await,
            Self::WebSocket(client) => client.subagent_close(thread_id, subagent_thread_id).await,
        }
    }

    pub async fn handoff_to_agent(&self, request: CodexHandoffToAgent) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.handoff_to_agent(request).await,
            Self::UnixSocket(client) => client.handoff_to_agent(request).await,
            Self::WebSocket(client) => client.handoff_to_agent(request).await,
        }
    }

    pub async fn review_start(&self, request: CodexReviewStart) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.review_start(request).await,
            Self::UnixSocket(client) => client.review_start(request).await,
            Self::WebSocket(client) => client.review_start(request).await,
        }
    }

    pub async fn thread_shell_command(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_shell_command(params).await,
            Self::UnixSocket(client) => client.thread_shell_command(params).await,
            Self::WebSocket(client) => client.thread_shell_command(params).await,
        }
    }

    pub async fn command_exec(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.command_exec(params).await,
            Self::UnixSocket(client) => client.command_exec(params).await,
            Self::WebSocket(client) => client.command_exec(params).await,
        }
    }

    pub async fn command_write_stdin(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.command_write_stdin(params).await,
            Self::UnixSocket(client) => client.command_write_stdin(params).await,
            Self::WebSocket(client) => client.command_write_stdin(params).await,
        }
    }

    pub async fn command_resize(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.command_resize(params).await,
            Self::UnixSocket(client) => client.command_resize(params).await,
            Self::WebSocket(client) => client.command_resize(params).await,
        }
    }

    pub async fn command_terminate(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.command_terminate(params).await,
            Self::UnixSocket(client) => client.command_terminate(params).await,
            Self::WebSocket(client) => client.command_terminate(params).await,
        }
    }

    pub async fn process_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.process_list(params).await,
            Self::UnixSocket(client) => client.process_list(params).await,
            Self::WebSocket(client) => client.process_list(params).await,
        }
    }

    pub async fn process_clean(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.process_clean(params).await,
            Self::UnixSocket(client) => client.process_clean(params).await,
            Self::WebSocket(client) => client.process_clean(params).await,
        }
    }

    pub async fn process_spawn(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.process_spawn(params).await,
            Self::UnixSocket(client) => client.process_spawn(params).await,
            Self::WebSocket(client) => client.process_spawn(params).await,
        }
    }

    pub async fn process_write_stdin(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.process_write_stdin(params).await,
            Self::UnixSocket(client) => client.process_write_stdin(params).await,
            Self::WebSocket(client) => client.process_write_stdin(params).await,
        }
    }

    pub async fn process_resize_pty(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.process_resize_pty(params).await,
            Self::UnixSocket(client) => client.process_resize_pty(params).await,
            Self::WebSocket(client) => client.process_resize_pty(params).await,
        }
    }

    pub async fn process_kill(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.process_kill(params).await,
            Self::UnixSocket(client) => client.process_kill(params).await,
            Self::WebSocket(client) => client.process_kill(params).await,
        }
    }

    pub async fn background_terminals_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.background_terminals_list(params).await,
            Self::UnixSocket(client) => client.background_terminals_list(params).await,
            Self::WebSocket(client) => client.background_terminals_list(params).await,
        }
    }

    pub async fn background_terminals_clean(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.background_terminals_clean(params).await,
            Self::UnixSocket(client) => client.background_terminals_clean(params).await,
            Self::WebSocket(client) => client.background_terminals_clean(params).await,
        }
    }

    pub async fn background_terminal_terminate(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.background_terminal_terminate(params).await,
            Self::UnixSocket(client) => client.background_terminal_terminate(params).await,
            Self::WebSocket(client) => client.background_terminal_terminate(params).await,
        }
    }

    pub async fn fs_read_file(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_read_file(params).await,
            Self::UnixSocket(client) => client.fs_read_file(params).await,
            Self::WebSocket(client) => client.fs_read_file(params).await,
        }
    }

    pub async fn fs_write_file(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_write_file(params).await,
            Self::UnixSocket(client) => client.fs_write_file(params).await,
            Self::WebSocket(client) => client.fs_write_file(params).await,
        }
    }

    pub async fn fs_read_directory(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_read_directory(params).await,
            Self::UnixSocket(client) => client.fs_read_directory(params).await,
            Self::WebSocket(client) => client.fs_read_directory(params).await,
        }
    }

    pub async fn fs_create_directory(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_create_directory(params).await,
            Self::UnixSocket(client) => client.fs_create_directory(params).await,
            Self::WebSocket(client) => client.fs_create_directory(params).await,
        }
    }

    pub async fn fs_copy(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_copy(params).await,
            Self::UnixSocket(client) => client.fs_copy(params).await,
            Self::WebSocket(client) => client.fs_copy(params).await,
        }
    }

    pub async fn fs_remove(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_remove(params).await,
            Self::UnixSocket(client) => client.fs_remove(params).await,
            Self::WebSocket(client) => client.fs_remove(params).await,
        }
    }

    pub async fn fs_metadata(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_metadata(params).await,
            Self::UnixSocket(client) => client.fs_metadata(params).await,
            Self::WebSocket(client) => client.fs_metadata(params).await,
        }
    }

    pub async fn fs_watch(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_watch(params).await,
            Self::UnixSocket(client) => client.fs_watch(params).await,
            Self::WebSocket(client) => client.fs_watch(params).await,
        }
    }

    pub async fn fs_unwatch(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fs_unwatch(params).await,
            Self::UnixSocket(client) => client.fs_unwatch(params).await,
            Self::WebSocket(client) => client.fs_unwatch(params).await,
        }
    }

    pub async fn mcp_status(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.mcp_status(params).await,
            Self::UnixSocket(client) => client.mcp_status(params).await,
            Self::WebSocket(client) => client.mcp_status(params).await,
        }
    }

    pub async fn mcp_resource_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.mcp_resource_read(params).await,
            Self::UnixSocket(client) => client.mcp_resource_read(params).await,
            Self::WebSocket(client) => client.mcp_resource_read(params).await,
        }
    }

    pub async fn mcp_oauth_login(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.mcp_oauth_login(params).await,
            Self::UnixSocket(client) => client.mcp_oauth_login(params).await,
            Self::WebSocket(client) => client.mcp_oauth_login(params).await,
        }
    }

    pub async fn mcp_tool_call(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.mcp_tool_call(params).await,
            Self::UnixSocket(client) => client.mcp_tool_call(params).await,
            Self::WebSocket(client) => client.mcp_tool_call(params).await,
        }
    }

    pub async fn skills_list(&self, request: CodexNamedQuery) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.skills_list(request).await,
            Self::UnixSocket(client) => client.skills_list(request).await,
            Self::WebSocket(client) => client.skills_list(request).await,
        }
    }

    pub async fn skills_read(&self, request: CodexSkillRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.skills_read(request).await,
            Self::UnixSocket(client) => client.skills_read(request).await,
            Self::WebSocket(client) => client.skills_read(request).await,
        }
    }

    pub async fn skills_install(&self, request: CodexSkillRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.skills_install(request).await,
            Self::UnixSocket(client) => client.skills_install(request).await,
            Self::WebSocket(client) => client.skills_install(request).await,
        }
    }

    pub async fn skills_config_write(&self, request: CodexSkillsConfigWrite) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.skills_config_write(request).await,
            Self::UnixSocket(client) => client.skills_config_write(request).await,
            Self::WebSocket(client) => client.skills_config_write(request).await,
        }
    }

    pub async fn skills_extra_roots_set(&self, request: CodexSkillsExtraRootsSet) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.skills_extra_roots_set(request).await,
            Self::UnixSocket(client) => client.skills_extra_roots_set(request).await,
            Self::WebSocket(client) => client.skills_extra_roots_set(request).await,
        }
    }

    pub async fn plugins_installed(&self, request: CodexNamedQuery) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugins_installed(request).await,
            Self::UnixSocket(client) => client.plugins_installed(request).await,
            Self::WebSocket(client) => client.plugins_installed(request).await,
        }
    }

    pub async fn plugins_list(&self, request: CodexNamedQuery) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugins_list(request).await,
            Self::UnixSocket(client) => client.plugins_list(request).await,
            Self::WebSocket(client) => client.plugins_list(request).await,
        }
    }

    pub async fn plugins_read(&self, request: CodexPluginRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugins_read(request).await,
            Self::UnixSocket(client) => client.plugins_read(request).await,
            Self::WebSocket(client) => client.plugins_read(request).await,
        }
    }

    pub async fn plugins_install(&self, request: CodexPluginRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugins_install(request).await,
            Self::UnixSocket(client) => client.plugins_install(request).await,
            Self::WebSocket(client) => client.plugins_install(request).await,
        }
    }

    pub async fn plugins_uninstall(&self, request: CodexPluginRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugins_uninstall(request).await,
            Self::UnixSocket(client) => client.plugins_uninstall(request).await,
            Self::WebSocket(client) => client.plugins_uninstall(request).await,
        }
    }

    pub async fn plugin_share_checkout(&self, request: CodexPluginShareRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugin_share_checkout(request).await,
            Self::UnixSocket(client) => client.plugin_share_checkout(request).await,
            Self::WebSocket(client) => client.plugin_share_checkout(request).await,
        }
    }

    pub async fn plugin_share_delete(&self, request: CodexPluginShareRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugin_share_delete(request).await,
            Self::UnixSocket(client) => client.plugin_share_delete(request).await,
            Self::WebSocket(client) => client.plugin_share_delete(request).await,
        }
    }

    pub async fn plugin_share_list(&self, request: CodexPluginShareRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugin_share_list(request).await,
            Self::UnixSocket(client) => client.plugin_share_list(request).await,
            Self::WebSocket(client) => client.plugin_share_list(request).await,
        }
    }

    pub async fn plugin_share_save(&self, request: CodexPluginShareSave) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugin_share_save(request).await,
            Self::UnixSocket(client) => client.plugin_share_save(request).await,
            Self::WebSocket(client) => client.plugin_share_save(request).await,
        }
    }

    pub async fn plugin_share_update_targets(
        &self,
        request: CodexPluginShareUpdateTargets,
    ) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.plugin_share_update_targets(request).await,
            Self::UnixSocket(client) => client.plugin_share_update_targets(request).await,
            Self::WebSocket(client) => client.plugin_share_update_targets(request).await,
        }
    }

    pub async fn apps_list(&self, request: CodexNamedQuery) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.apps_list(request).await,
            Self::UnixSocket(client) => client.apps_list(request).await,
            Self::WebSocket(client) => client.apps_list(request).await,
        }
    }

    pub async fn apps_config_write(&self, request: CodexAppConfigWrite) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.apps_config_write(request).await,
            Self::UnixSocket(client) => client.apps_config_write(request).await,
            Self::WebSocket(client) => client.apps_config_write(request).await,
        }
    }

    pub async fn marketplace_add(&self, request: CodexMarketplaceRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.marketplace_add(request).await,
            Self::UnixSocket(client) => client.marketplace_add(request).await,
            Self::WebSocket(client) => client.marketplace_add(request).await,
        }
    }

    pub async fn marketplace_remove(&self, request: CodexMarketplaceRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.marketplace_remove(request).await,
            Self::UnixSocket(client) => client.marketplace_remove(request).await,
            Self::WebSocket(client) => client.marketplace_remove(request).await,
        }
    }

    pub async fn marketplace_upgrade(&self, request: CodexMarketplaceRequest) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.marketplace_upgrade(request).await,
            Self::UnixSocket(client) => client.marketplace_upgrade(request).await,
            Self::WebSocket(client) => client.marketplace_upgrade(request).await,
        }
    }

    pub async fn model_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.model_list(params).await,
            Self::UnixSocket(client) => client.model_list(params).await,
            Self::WebSocket(client) => client.model_list(params).await,
        }
    }

    pub async fn model_provider_capabilities_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.model_provider_capabilities_read(params).await,
            Self::UnixSocket(client) => client.model_provider_capabilities_read(params).await,
            Self::WebSocket(client) => client.model_provider_capabilities_read(params).await,
        }
    }

    pub async fn account_login_start(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_login_start(params).await,
            Self::UnixSocket(client) => client.account_login_start(params).await,
            Self::WebSocket(client) => client.account_login_start(params).await,
        }
    }

    pub async fn account_login_cancel(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_login_cancel(params).await,
            Self::UnixSocket(client) => client.account_login_cancel(params).await,
            Self::WebSocket(client) => client.account_login_cancel(params).await,
        }
    }

    pub async fn account_logout(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_logout(params).await,
            Self::UnixSocket(client) => client.account_logout(params).await,
            Self::WebSocket(client) => client.account_logout(params).await,
        }
    }

    pub async fn account_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_read(params).await,
            Self::UnixSocket(client) => client.account_read(params).await,
            Self::WebSocket(client) => client.account_read(params).await,
        }
    }

    pub async fn account_rate_limit_reset_credit_consume(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_rate_limit_reset_credit_consume(params).await,
            Self::UnixSocket(client) => {
                client.account_rate_limit_reset_credit_consume(params).await
            }
            Self::WebSocket(client) => client.account_rate_limit_reset_credit_consume(params).await,
        }
    }

    pub async fn account_rate_limits_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_rate_limits_read(params).await,
            Self::UnixSocket(client) => client.account_rate_limits_read(params).await,
            Self::WebSocket(client) => client.account_rate_limits_read(params).await,
        }
    }

    pub async fn account_usage_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_usage_read(params).await,
            Self::UnixSocket(client) => client.account_usage_read(params).await,
            Self::WebSocket(client) => client.account_usage_read(params).await,
        }
    }

    pub async fn account_send_add_credits_nudge_email(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.account_send_add_credits_nudge_email(params).await,
            Self::UnixSocket(client) => client.account_send_add_credits_nudge_email(params).await,
            Self::WebSocket(client) => client.account_send_add_credits_nudge_email(params).await,
        }
    }

    pub async fn windows_sandbox_readiness(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.windows_sandbox_readiness(params).await,
            Self::UnixSocket(client) => client.windows_sandbox_readiness(params).await,
            Self::WebSocket(client) => client.windows_sandbox_readiness(params).await,
        }
    }

    pub async fn windows_sandbox_setup_start(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.windows_sandbox_setup_start(params).await,
            Self::UnixSocket(client) => client.windows_sandbox_setup_start(params).await,
            Self::WebSocket(client) => client.windows_sandbox_setup_start(params).await,
        }
    }

    pub async fn config_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.config_read(params).await,
            Self::UnixSocket(client) => client.config_read(params).await,
            Self::WebSocket(client) => client.config_read(params).await,
        }
    }

    pub async fn config_value_write(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.config_value_write(params).await,
            Self::UnixSocket(client) => client.config_value_write(params).await,
            Self::WebSocket(client) => client.config_value_write(params).await,
        }
    }

    pub async fn config_batch_write(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.config_batch_write(params).await,
            Self::UnixSocket(client) => client.config_batch_write(params).await,
            Self::WebSocket(client) => client.config_batch_write(params).await,
        }
    }

    pub async fn config_mcp_server_reload(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.config_mcp_server_reload(params).await,
            Self::UnixSocket(client) => client.config_mcp_server_reload(params).await,
            Self::WebSocket(client) => client.config_mcp_server_reload(params).await,
        }
    }

    pub async fn collaboration_mode_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.collaboration_mode_list(params).await,
            Self::UnixSocket(client) => client.collaboration_mode_list(params).await,
            Self::WebSocket(client) => client.collaboration_mode_list(params).await,
        }
    }

    pub async fn environment_add(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.environment_add(params).await,
            Self::UnixSocket(client) => client.environment_add(params).await,
            Self::WebSocket(client) => client.environment_add(params).await,
        }
    }

    pub async fn memory_reset(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.memory_reset(params).await,
            Self::UnixSocket(client) => client.memory_reset(params).await,
            Self::WebSocket(client) => client.memory_reset(params).await,
        }
    }

    pub async fn experimental_feature_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.experimental_feature_list(params).await,
            Self::UnixSocket(client) => client.experimental_feature_list(params).await,
            Self::WebSocket(client) => client.experimental_feature_list(params).await,
        }
    }

    pub async fn experimental_feature_enablement_set(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.experimental_feature_enablement_set(params).await,
            Self::UnixSocket(client) => client.experimental_feature_enablement_set(params).await,
            Self::WebSocket(client) => client.experimental_feature_enablement_set(params).await,
        }
    }

    pub async fn external_agent_config_detect(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.external_agent_config_detect(params).await,
            Self::UnixSocket(client) => client.external_agent_config_detect(params).await,
            Self::WebSocket(client) => client.external_agent_config_detect(params).await,
        }
    }

    pub async fn external_agent_config_import(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.external_agent_config_import(params).await,
            Self::UnixSocket(client) => client.external_agent_config_import(params).await,
            Self::WebSocket(client) => client.external_agent_config_import(params).await,
        }
    }

    pub async fn feedback_upload(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.feedback_upload(params).await,
            Self::UnixSocket(client) => client.feedback_upload(params).await,
            Self::WebSocket(client) => client.feedback_upload(params).await,
        }
    }

    pub async fn fuzzy_file_search(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fuzzy_file_search(params).await,
            Self::UnixSocket(client) => client.fuzzy_file_search(params).await,
            Self::WebSocket(client) => client.fuzzy_file_search(params).await,
        }
    }

    pub async fn fuzzy_file_search_session_start(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fuzzy_file_search_session_start(params).await,
            Self::UnixSocket(client) => client.fuzzy_file_search_session_start(params).await,
            Self::WebSocket(client) => client.fuzzy_file_search_session_start(params).await,
        }
    }

    pub async fn fuzzy_file_search_session_stop(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fuzzy_file_search_session_stop(params).await,
            Self::UnixSocket(client) => client.fuzzy_file_search_session_stop(params).await,
            Self::WebSocket(client) => client.fuzzy_file_search_session_stop(params).await,
        }
    }

    pub async fn fuzzy_file_search_session_update(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.fuzzy_file_search_session_update(params).await,
            Self::UnixSocket(client) => client.fuzzy_file_search_session_update(params).await,
            Self::WebSocket(client) => client.fuzzy_file_search_session_update(params).await,
        }
    }

    pub async fn hooks_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.hooks_list(params).await,
            Self::UnixSocket(client) => client.hooks_list(params).await,
            Self::WebSocket(client) => client.hooks_list(params).await,
        }
    }

    pub async fn remote_control_client_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_client_list(params).await,
            Self::UnixSocket(client) => client.remote_control_client_list(params).await,
            Self::WebSocket(client) => client.remote_control_client_list(params).await,
        }
    }

    pub async fn remote_control_client_revoke(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_client_revoke(params).await,
            Self::UnixSocket(client) => client.remote_control_client_revoke(params).await,
            Self::WebSocket(client) => client.remote_control_client_revoke(params).await,
        }
    }

    pub async fn remote_control_disable(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_disable(params).await,
            Self::UnixSocket(client) => client.remote_control_disable(params).await,
            Self::WebSocket(client) => client.remote_control_disable(params).await,
        }
    }

    pub async fn remote_control_enable(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_enable(params).await,
            Self::UnixSocket(client) => client.remote_control_enable(params).await,
            Self::WebSocket(client) => client.remote_control_enable(params).await,
        }
    }

    pub async fn remote_control_pairing_start(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_pairing_start(params).await,
            Self::UnixSocket(client) => client.remote_control_pairing_start(params).await,
            Self::WebSocket(client) => client.remote_control_pairing_start(params).await,
        }
    }

    pub async fn remote_control_pairing_status(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_pairing_status(params).await,
            Self::UnixSocket(client) => client.remote_control_pairing_status(params).await,
            Self::WebSocket(client) => client.remote_control_pairing_status(params).await,
        }
    }

    pub async fn remote_control_status_read(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.remote_control_status_read(params).await,
            Self::UnixSocket(client) => client.remote_control_status_read(params).await,
            Self::WebSocket(client) => client.remote_control_status_read(params).await,
        }
    }

    pub async fn thread_decrement_elicitation(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_decrement_elicitation(params).await,
            Self::UnixSocket(client) => client.thread_decrement_elicitation(params).await,
            Self::WebSocket(client) => client.thread_decrement_elicitation(params).await,
        }
    }

    pub async fn thread_increment_elicitation(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_increment_elicitation(params).await,
            Self::UnixSocket(client) => client.thread_increment_elicitation(params).await,
            Self::WebSocket(client) => client.thread_increment_elicitation(params).await,
        }
    }

    pub async fn thread_memory_mode_set(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_memory_mode_set(params).await,
            Self::UnixSocket(client) => client.thread_memory_mode_set(params).await,
            Self::WebSocket(client) => client.thread_memory_mode_set(params).await,
        }
    }

    pub async fn thread_realtime_append_audio(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_realtime_append_audio(params).await,
            Self::UnixSocket(client) => client.thread_realtime_append_audio(params).await,
            Self::WebSocket(client) => client.thread_realtime_append_audio(params).await,
        }
    }

    pub async fn thread_realtime_append_speech(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_realtime_append_speech(params).await,
            Self::UnixSocket(client) => client.thread_realtime_append_speech(params).await,
            Self::WebSocket(client) => client.thread_realtime_append_speech(params).await,
        }
    }

    pub async fn thread_realtime_append_text(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_realtime_append_text(params).await,
            Self::UnixSocket(client) => client.thread_realtime_append_text(params).await,
            Self::WebSocket(client) => client.thread_realtime_append_text(params).await,
        }
    }

    pub async fn thread_realtime_list_voices(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_realtime_list_voices(params).await,
            Self::UnixSocket(client) => client.thread_realtime_list_voices(params).await,
            Self::WebSocket(client) => client.thread_realtime_list_voices(params).await,
        }
    }

    pub async fn thread_realtime_start(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_realtime_start(params).await,
            Self::UnixSocket(client) => client.thread_realtime_start(params).await,
            Self::WebSocket(client) => client.thread_realtime_start(params).await,
        }
    }

    pub async fn thread_realtime_stop(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_realtime_stop(params).await,
            Self::UnixSocket(client) => client.thread_realtime_stop(params).await,
            Self::WebSocket(client) => client.thread_realtime_stop(params).await,
        }
    }

    pub async fn thread_search(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_search(params).await,
            Self::UnixSocket(client) => client.thread_search(params).await,
            Self::WebSocket(client) => client.thread_search(params).await,
        }
    }

    pub async fn thread_settings_update(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_settings_update(params).await,
            Self::UnixSocket(client) => client.thread_settings_update(params).await,
            Self::WebSocket(client) => client.thread_settings_update(params).await,
        }
    }

    pub async fn thread_turns_items_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_turns_items_list(params).await,
            Self::UnixSocket(client) => client.thread_turns_items_list(params).await,
            Self::WebSocket(client) => client.thread_turns_items_list(params).await,
        }
    }

    pub async fn thread_turns_list(&self, params: Value) -> Result<Value> {
        match self {
            Self::Stdio(client) => client.thread_turns_list(params).await,
            Self::UnixSocket(client) => client.thread_turns_list(params).await,
            Self::WebSocket(client) => client.thread_turns_list(params).await,
        }
    }
}

impl<T: AppServerTransport> CodexClient<T> {
    #[must_use]
    pub fn new(transport: T, timeout: Duration) -> Self {
        Self {
            transport: Arc::new(transport),
            timeout,
            initialize_result: Arc::new(StdMutex::new(None)),
        }
    }

    pub async fn initialize(&self, client_info: CodexClientInfo) -> Result<Value> {
        let response = self
            .raw_request(
                "initialize",
                json!({
                    "clientInfo": client_info,
                    "capabilities": {
                        "experimentalApi": true
                    }
                }),
            )
            .await?;
        self.transport.notify("initialized", json!({})).await?;
        *self
            .initialize_result
            .lock()
            .expect("initialize result lock poisoned") = Some(response.clone());
        Ok(response)
    }

    pub async fn raw_request(&self, method: &str, params: Value) -> Result<Value> {
        self.transport.request(method, params, self.timeout).await
    }

    pub async fn start_thread(&self, request: CodexThreadStart) -> Result<Value> {
        self.raw_request(
            "thread/start",
            serde_json::to_value(request.prepare_for_provider())?,
        )
        .await
    }

    pub async fn resume_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/resume", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn fork_thread(&self, thread_id: &str, ephemeral: bool) -> Result<Value> {
        self.raw_request(
            "thread/fork",
            json!({
                "threadId": thread_id,
                "ephemeral": ephemeral,
            }),
        )
        .await
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/read", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn list_threads(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/list", params).await
    }

    pub async fn list_loaded_threads(&self) -> Result<Value> {
        self.raw_request("thread/loaded/list", json!({})).await
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/archive", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn unarchive_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/unarchive", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn delete_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/delete", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn unsubscribe_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/unsubscribe", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn set_thread_name(&self, thread_id: &str, name: &str) -> Result<Value> {
        self.raw_request(
            "thread/name/set",
            json!({
                "threadId": thread_id,
                "name": name,
            }),
        )
        .await
    }

    pub async fn update_thread_metadata(&self, thread_id: &str, metadata: Value) -> Result<Value> {
        self.raw_request(
            "thread/metadata/update",
            json!({
                "threadId": thread_id,
                "metadata": metadata,
            }),
        )
        .await
    }

    pub async fn compact_thread(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/compact/start", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn rollback_thread(&self, thread_id: &str, turn_id: &str) -> Result<Value> {
        self.raw_request(
            "thread/rollback",
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
            }),
        )
        .await
    }

    pub async fn inject_thread_items(&self, thread_id: &str, items: Vec<Value>) -> Result<Value> {
        self.raw_request(
            "thread/inject_items",
            json!({
                "threadId": thread_id,
                "items": items,
            }),
        )
        .await
    }

    pub async fn start_turn(&self, request: CodexTurnStart) -> Result<Value> {
        self.raw_request(
            "turn/start",
            serde_json::to_value(request.prepare_for_provider())?,
        )
        .await
    }

    pub async fn steer_turn(&self, request: CodexTurnSteer) -> Result<Value> {
        self.raw_request(
            "turn/steer",
            json!({
                "threadId": request.thread_id,
                "expectedTurnId": request.expected_turn_id,
                "input": request.input,
                "clientUserMessageId": request.client_user_message_id,
            }),
        )
        .await
    }

    pub async fn continue_plan_in_thread(&self, request: CodexPlanImplementation) -> Result<Value> {
        let thread_id = request.thread_id.clone();
        self.inject_thread_items(&thread_id, vec![accepted_plan_item(request.plan.clone())])
            .await?;
        let turn = request.into_turn_start(thread_id.clone());
        let turn_response = self.start_turn(turn).await?;
        Ok(json!({
            "threadId": thread_id,
            "turn": turn_response,
            "forked": false,
            "ephemeral": false,
        }))
    }

    pub async fn fork_plan_for_implementation(
        &self,
        request: CodexPlanImplementation,
    ) -> Result<Value> {
        self.implement_plan_in_fork(request, false).await
    }

    pub async fn side_implementation(&self, request: CodexPlanImplementation) -> Result<Value> {
        self.implement_plan_in_fork(request, true).await
    }

    async fn implement_plan_in_fork(
        &self,
        request: CodexPlanImplementation,
        ephemeral: bool,
    ) -> Result<Value> {
        let parent_thread_id = request.thread_id.clone();
        let fork_response = self.fork_thread(&parent_thread_id, ephemeral).await?;
        let thread_id = extract_thread_id(&fork_response).ok_or_else(|| {
            CodexError::InvalidMessage(
                "thread/fork response did not include a thread id".to_string(),
            )
        })?;
        self.inject_thread_items(&thread_id, vec![accepted_plan_item(request.plan.clone())])
            .await?;
        let turn = request.into_turn_start(thread_id.clone());
        let turn_response = self.start_turn(turn).await?;
        Ok(json!({
            "threadId": thread_id,
            "parentThreadId": parent_thread_id,
            "fork": fork_response,
            "turn": turn_response,
            "forked": true,
            "ephemeral": ephemeral,
        }))
    }

    pub async fn interrupt_turn(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("turn/interrupt", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn config_requirements_read(&self) -> Result<Value> {
        self.raw_request("configRequirements/read", json!({})).await
    }

    pub async fn permission_profile_list(&self) -> Result<Value> {
        self.raw_request("permissionProfile/list", json!({})).await
    }

    pub async fn permission_catalog(&self) -> Result<CodexPermissionCatalog> {
        let requirements = self.config_requirements_read().await?;
        let profiles = self.permission_profile_list().await?;
        Ok(CodexPermissionCatalog::from_sources(requirements, profiles))
    }

    pub async fn approve_guardian_denied_action(
        &self,
        request: CodexGuardianDeniedActionApproval,
    ) -> Result<Value> {
        self.raw_request(
            "thread/approveGuardianDeniedAction",
            serde_json::to_value(request)?,
        )
        .await
    }

    pub async fn goal_set(&self, request: CodexGoalSet) -> Result<Value> {
        self.raw_request(
            "thread/goal/set",
            json!({
                "threadId": request.thread_id,
                "objective": request.objective,
                "tokenBudget": request.token_budget,
            }),
        )
        .await
    }

    pub async fn goal_get(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/goal/get", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn goal_clear(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("thread/goal/clear", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn goal_pause(&self, thread_id: &str) -> Result<Value> {
        self.raw_request(
            "thread/goal/set",
            json!({ "threadId": thread_id, "status": "paused" }),
        )
        .await
    }

    pub async fn goal_resume(&self, thread_id: &str) -> Result<Value> {
        self.raw_request(
            "thread/goal/set",
            json!({ "threadId": thread_id, "status": "active" }),
        )
        .await
    }

    pub async fn subagent_list(&self, thread_id: &str) -> Result<Value> {
        self.raw_request("subagent/list", json!({ "threadId": thread_id }))
            .await
    }

    pub async fn subagent_read(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.raw_request(
            "subagent/read",
            json!({
                "threadId": thread_id,
                "subagentThreadId": subagent_thread_id,
            }),
        )
        .await
    }

    pub async fn subagent_steer(&self, request: CodexSubagentSteer) -> Result<Value> {
        self.raw_request(
            "subagent/steer",
            json!({
                "threadId": request.thread_id,
                "subagentThreadId": request.subagent_thread_id,
                "prompt": request.prompt,
            }),
        )
        .await
    }

    pub async fn subagent_stop(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.raw_request(
            "subagent/stop",
            json!({
                "threadId": thread_id,
                "subagentThreadId": subagent_thread_id,
            }),
        )
        .await
    }

    pub async fn subagent_close(&self, thread_id: &str, subagent_thread_id: &str) -> Result<Value> {
        self.raw_request(
            "subagent/close",
            json!({
                "threadId": thread_id,
                "subagentThreadId": subagent_thread_id,
            }),
        )
        .await
    }

    pub async fn handoff_to_agent(&self, request: CodexHandoffToAgent) -> Result<Value> {
        self.raw_request("thread/handoffToAgent", serde_json::to_value(request)?)
            .await
    }

    pub async fn review_start(&self, request: CodexReviewStart) -> Result<Value> {
        self.raw_request("review/start", serde_json::to_value(request)?)
            .await
    }

    pub async fn thread_shell_command(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/shellCommand", params).await
    }

    pub async fn command_exec(&self, params: Value) -> Result<Value> {
        self.raw_request("command/exec", params).await
    }

    pub async fn command_write_stdin(&self, params: Value) -> Result<Value> {
        self.raw_request("command/exec/write", params).await
    }

    pub async fn command_resize(&self, params: Value) -> Result<Value> {
        self.raw_request("command/exec/resize", params).await
    }

    pub async fn command_terminate(&self, params: Value) -> Result<Value> {
        self.raw_request("command/exec/terminate", params).await
    }

    pub async fn process_list(&self, params: Value) -> Result<Value> {
        self.raw_request("process/list", params).await
    }

    pub async fn process_clean(&self, params: Value) -> Result<Value> {
        self.raw_request("process/clean", params).await
    }

    pub async fn process_spawn(&self, params: Value) -> Result<Value> {
        self.raw_request("process/spawn", params).await
    }

    pub async fn process_write_stdin(&self, params: Value) -> Result<Value> {
        self.raw_request("process/writeStdin", params).await
    }

    pub async fn process_resize_pty(&self, params: Value) -> Result<Value> {
        self.raw_request("process/resizePty", params).await
    }

    pub async fn process_kill(&self, params: Value) -> Result<Value> {
        self.raw_request("process/kill", params).await
    }

    pub async fn background_terminals_list(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/backgroundTerminals/list", params)
            .await
    }

    pub async fn background_terminals_clean(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/backgroundTerminals/clean", params)
            .await
    }

    pub async fn background_terminal_terminate(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/backgroundTerminals/terminate", params)
            .await
    }

    pub async fn fs_read_file(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/readFile", params).await
    }

    pub async fn fs_write_file(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/writeFile", params).await
    }

    pub async fn fs_read_directory(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/readDirectory", params).await
    }

    pub async fn fs_create_directory(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/createDirectory", params).await
    }

    pub async fn fs_copy(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/copy", params).await
    }

    pub async fn fs_remove(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/remove", params).await
    }

    pub async fn fs_metadata(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/getMetadata", params).await
    }

    pub async fn fs_watch(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/watch", params).await
    }

    pub async fn fs_unwatch(&self, params: Value) -> Result<Value> {
        self.raw_request("fs/unwatch", params).await
    }

    pub async fn mcp_status(&self, params: Value) -> Result<Value> {
        self.raw_request("mcpServerStatus/list", params).await
    }

    pub async fn mcp_resource_read(&self, params: Value) -> Result<Value> {
        self.raw_request("mcpServer/resource/read", params).await
    }

    pub async fn mcp_oauth_login(&self, params: Value) -> Result<Value> {
        self.raw_request("mcpServer/oauth/login", params).await
    }

    pub async fn mcp_tool_call(&self, params: Value) -> Result<Value> {
        self.raw_request("mcpServer/tool/call", params).await
    }

    pub async fn skills_list(&self, request: CodexNamedQuery) -> Result<Value> {
        self.raw_request("skills/list", serde_json::to_value(request)?)
            .await
    }

    pub async fn skills_read(&self, request: CodexSkillRequest) -> Result<Value> {
        self.raw_request("plugin/skill/read", serde_json::to_value(request)?)
            .await
    }

    pub async fn skills_install(&self, request: CodexSkillRequest) -> Result<Value> {
        self.raw_request("skills/install", serde_json::to_value(request)?)
            .await
    }

    pub async fn skills_config_write(&self, request: CodexSkillsConfigWrite) -> Result<Value> {
        self.raw_request("skills/config/write", serde_json::to_value(request)?)
            .await
    }

    pub async fn skills_extra_roots_set(&self, request: CodexSkillsExtraRootsSet) -> Result<Value> {
        self.raw_request("skills/extraRoots/set", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugins_installed(&self, request: CodexNamedQuery) -> Result<Value> {
        self.raw_request("plugin/installed", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugins_list(&self, request: CodexNamedQuery) -> Result<Value> {
        self.raw_request("plugin/list", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugins_read(&self, request: CodexPluginRequest) -> Result<Value> {
        self.raw_request("plugin/read", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugins_install(&self, request: CodexPluginRequest) -> Result<Value> {
        self.raw_request("plugin/install", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugins_uninstall(&self, request: CodexPluginRequest) -> Result<Value> {
        self.raw_request("plugin/uninstall", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugin_share_checkout(&self, request: CodexPluginShareRequest) -> Result<Value> {
        self.raw_request("plugin/share/checkout", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugin_share_delete(&self, request: CodexPluginShareRequest) -> Result<Value> {
        self.raw_request("plugin/share/delete", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugin_share_list(&self, request: CodexPluginShareRequest) -> Result<Value> {
        self.raw_request("plugin/share/list", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugin_share_save(&self, request: CodexPluginShareSave) -> Result<Value> {
        self.raw_request("plugin/share/save", serde_json::to_value(request)?)
            .await
    }

    pub async fn plugin_share_update_targets(
        &self,
        request: CodexPluginShareUpdateTargets,
    ) -> Result<Value> {
        self.raw_request("plugin/share/updateTargets", serde_json::to_value(request)?)
            .await
    }

    pub async fn apps_list(&self, request: CodexNamedQuery) -> Result<Value> {
        self.raw_request("app/list", serde_json::to_value(request)?)
            .await
    }

    pub async fn apps_config_write(&self, request: CodexAppConfigWrite) -> Result<Value> {
        self.raw_request("apps/configWrite", serde_json::to_value(request)?)
            .await
    }

    pub async fn remote_connection_list(&self, params: Value) -> Result<Value> {
        self.raw_request("remote/connectionList", params).await
    }

    pub async fn remote_handoff(&self, params: Value) -> Result<Value> {
        self.raw_request("remote/handoff", params).await
    }

    pub async fn account_login_start(&self, params: Value) -> Result<Value> {
        self.raw_request("account/login/start", params).await
    }

    pub async fn account_login_cancel(&self, params: Value) -> Result<Value> {
        self.raw_request("account/login/cancel", params).await
    }

    pub async fn account_logout(&self, params: Value) -> Result<Value> {
        self.raw_request("account/logout", params).await
    }

    pub async fn account_read(&self, params: Value) -> Result<Value> {
        self.raw_request("account/read", params).await
    }

    pub async fn account_rate_limit_reset_credit_consume(&self, params: Value) -> Result<Value> {
        self.raw_request("account/rateLimitResetCredit/consume", params)
            .await
    }

    pub async fn account_rate_limits_read(&self, params: Value) -> Result<Value> {
        self.raw_request("account/rateLimits/read", params).await
    }

    pub async fn account_usage_read(&self, params: Value) -> Result<Value> {
        self.raw_request("account/usage/read", params).await
    }

    pub async fn account_send_add_credits_nudge_email(&self, params: Value) -> Result<Value> {
        self.raw_request("account/sendAddCreditsNudgeEmail", params)
            .await
    }

    pub async fn windows_sandbox_readiness(&self, params: Value) -> Result<Value> {
        self.raw_request("windowsSandbox/readiness", params).await
    }

    pub async fn windows_sandbox_setup_start(&self, params: Value) -> Result<Value> {
        self.raw_request("windowsSandbox/setupStart", params).await
    }

    pub async fn config_read(&self, params: Value) -> Result<Value> {
        self.raw_request("config/read", params).await
    }

    pub async fn config_value_write(&self, params: Value) -> Result<Value> {
        self.raw_request("config/value/write", params).await
    }

    pub async fn config_batch_write(&self, params: Value) -> Result<Value> {
        self.raw_request("config/batchWrite", params).await
    }

    pub async fn config_mcp_server_reload(&self, params: Value) -> Result<Value> {
        self.raw_request("config/mcpServer/reload", params).await
    }

    pub async fn collaboration_mode_list(&self, params: Value) -> Result<Value> {
        self.raw_request("collaborationMode/list", params).await
    }

    pub async fn environment_add(&self, params: Value) -> Result<Value> {
        self.raw_request("environment/add", params).await
    }

    pub async fn memory_reset(&self, params: Value) -> Result<Value> {
        self.raw_request("memory/reset", params).await
    }

    pub async fn experimental_feature_list(&self, params: Value) -> Result<Value> {
        self.raw_request("experimentalFeature/list", params).await
    }

    pub async fn experimental_feature_enablement_set(&self, params: Value) -> Result<Value> {
        self.raw_request("experimentalFeature/enablement/set", params)
            .await
    }

    pub async fn external_agent_config_detect(&self, params: Value) -> Result<Value> {
        self.raw_request("externalAgentConfig/detect", params).await
    }

    pub async fn external_agent_config_import(&self, params: Value) -> Result<Value> {
        self.raw_request("externalAgentConfig/import", params).await
    }

    pub async fn feedback_upload(&self, params: Value) -> Result<Value> {
        self.raw_request("feedback/upload", params).await
    }

    pub async fn fuzzy_file_search(&self, params: Value) -> Result<Value> {
        self.raw_request("fuzzyFileSearch", params).await
    }

    pub async fn fuzzy_file_search_session_start(&self, params: Value) -> Result<Value> {
        self.raw_request("fuzzyFileSearch/sessionStart", params)
            .await
    }

    pub async fn fuzzy_file_search_session_stop(&self, params: Value) -> Result<Value> {
        self.raw_request("fuzzyFileSearch/sessionStop", params)
            .await
    }

    pub async fn fuzzy_file_search_session_update(&self, params: Value) -> Result<Value> {
        self.raw_request("fuzzyFileSearch/sessionUpdate", params)
            .await
    }

    pub async fn hooks_list(&self, params: Value) -> Result<Value> {
        self.raw_request("hooks/list", params).await
    }

    pub async fn remote_control_client_list(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/client/list", params).await
    }

    pub async fn remote_control_client_revoke(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/client/revoke", params)
            .await
    }

    pub async fn remote_control_disable(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/disable", params).await
    }

    pub async fn remote_control_enable(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/enable", params).await
    }

    pub async fn remote_control_pairing_start(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/pairing/start", params)
            .await
    }

    pub async fn remote_control_pairing_status(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/pairing/status", params)
            .await
    }

    pub async fn remote_control_status_read(&self, params: Value) -> Result<Value> {
        self.raw_request("remoteControl/status/read", params).await
    }

    pub async fn thread_decrement_elicitation(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/decrement_elicitation", params)
            .await
    }

    pub async fn thread_increment_elicitation(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/increment_elicitation", params)
            .await
    }

    pub async fn thread_memory_mode_set(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/memoryMode/set", params).await
    }

    pub async fn thread_realtime_append_audio(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/realtime/appendAudio", params)
            .await
    }

    pub async fn thread_realtime_append_speech(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/realtime/appendSpeech", params)
            .await
    }

    pub async fn thread_realtime_append_text(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/realtime/appendText", params).await
    }

    pub async fn thread_realtime_list_voices(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/realtime/listVoices", params).await
    }

    pub async fn thread_realtime_start(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/realtime/start", params).await
    }

    pub async fn thread_realtime_stop(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/realtime/stop", params).await
    }

    pub async fn thread_search(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/search", params).await
    }

    pub async fn thread_settings_update(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/settings/update", params).await
    }

    pub async fn thread_turns_items_list(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/turns/items/list", params).await
    }

    pub async fn thread_turns_list(&self, params: Value) -> Result<Value> {
        self.raw_request("thread/turns/list", params).await
    }

    pub async fn marketplace_add(&self, request: CodexMarketplaceRequest) -> Result<Value> {
        self.raw_request("marketplace/add", serde_json::to_value(request)?)
            .await
    }

    pub async fn marketplace_remove(&self, request: CodexMarketplaceRequest) -> Result<Value> {
        self.raw_request("marketplace/remove", serde_json::to_value(request)?)
            .await
    }

    pub async fn marketplace_upgrade(&self, request: CodexMarketplaceRequest) -> Result<Value> {
        self.raw_request("marketplace/upgrade", serde_json::to_value(request)?)
            .await
    }

    pub async fn model_list(&self, params: Value) -> Result<Value> {
        self.raw_request("model/list", params).await
    }

    pub async fn model_provider_capabilities_read(&self, params: Value) -> Result<Value> {
        self.raw_request("modelProvider/capabilities/read", params)
            .await
    }

    pub async fn next_provider_events(&self) -> Option<Vec<ProviderEvent>> {
        self.transport
            .recv()
            .await
            .map(|event| normalize_codex_inbound_event(&event))
    }

    pub async fn stderr_tail(&self) -> Vec<String> {
        self.transport.stderr_tail().await
    }

    pub async fn shutdown(&self, timeout: Duration) -> Result<()> {
        self.transport.shutdown(timeout).await
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.transport.is_closed()
    }

    #[must_use]
    pub fn is_initialized(&self) -> bool {
        self.initialize_result
            .lock()
            .expect("initialize result lock poisoned")
            .is_some()
    }

    #[must_use]
    pub fn initialize_result(&self) -> Option<Value> {
        self.initialize_result
            .lock()
            .expect("initialize result lock poisoned")
            .clone()
    }

    pub async fn runtime_state(&self) -> CodexTransportRuntimeState {
        self.transport.runtime_state().await
    }

    pub async fn respond_tool_result(&self, request_id: i64, result: Value) -> Result<()> {
        self.transport.respond_result(request_id, result).await
    }

    pub async fn respond_tool_error(
        &self,
        request_id: i64,
        code: i64,
        message: &str,
    ) -> Result<()> {
        self.transport
            .respond_error(request_id, code, message)
            .await
    }
}

#[must_use]
pub fn accepted_plan_item(plan: Value) -> Value {
    json!({
        "type": "plan",
        "status": "accepted",
        "content": plan,
    })
}

fn extract_thread_id(response: &Value) -> Option<String> {
    response
        .pointer("/thread/id")
        .or_else(|| response.pointer("/thread/threadId"))
        .or_else(|| response.get("threadId"))
        .or_else(|| response.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

#[derive(Clone)]
pub struct CodexAdapter<T: AppServerTransport> {
    client: CodexClient<T>,
}

impl<T: AppServerTransport> CodexAdapter<T> {
    #[must_use]
    pub fn new(client: CodexClient<T>) -> Self {
        Self { client }
    }

    #[must_use]
    pub fn client(&self) -> &CodexClient<T> {
        &self.client
    }
}

#[async_trait]
impl<T: AppServerTransport + 'static> ProviderDriver for CodexAdapter<T> {
    fn descriptor(&self) -> ProviderDescriptor {
        ProviderDescriptor {
            kind: ProviderKind::Codex,
            capabilities: vec![
                ProviderCapability {
                    key: "codex.app_server".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.app_server_transport.stdio".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.app_server_transport.unix_socket".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.app_server_transport.websocket".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.experimental_api".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.compatibility_inventory".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.execution_location.local".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "codex.execution_location.worktree".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.adapter_contract".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.semantic_tools".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.normalized_events".to_string(),
                    version: 1,
                },
                ProviderCapability {
                    key: "provider.normalized_server_requests".to_string(),
                    version: 1,
                },
            ],
        }
    }

    fn features(&self) -> Vec<ProviderFeature> {
        crate::codex_provider_features()
    }

    async fn request(
        &self,
        request: ProviderRequest,
    ) -> std::result::Result<Value, ProviderDriverError> {
        self.client
            .raw_request(&request.method, request.params)
            .await
            .map_err(|error| ProviderDriverError::RequestFailed {
                provider: "codex".to_string(),
                method: request.method,
                message: error.to_string(),
            })
    }
}

impl From<CodexError> for ProviderDriverError {
    fn from(error: CodexError) -> Self {
        Self::RequestFailed {
            provider: "codex".to_string(),
            method: "unknown".to_string(),
            message: error.to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CodexInboundEvent;
    use crate::transport::tests::FakeTransport;
    use serde_json::json;

    #[tokio::test]
    async fn initialize_sends_experimental_api_and_initialized_notification() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "platformFamily": "unix" })));
        let client = CodexClient::new(fake, Duration::from_secs(1));
        assert!(!client.is_initialized());

        let response = client
            .initialize(CodexClientInfo {
                name: "ace_test".to_string(),
                title: "Ace Test".to_string(),
                version: "0.1.0".to_string(),
            })
            .await
            .expect("initialize");
        assert_eq!(response["platformFamily"], "unix");
        assert!(client.is_initialized());
        assert_eq!(
            client.initialize_result().expect("initialize result"),
            json!({ "platformFamily": "unix" })
        );

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "initialize");
        assert_eq!(requests[0].1["capabilities"]["experimentalApi"], true);
        drop(requests);

        let notifications = client
            .transport
            .notifications
            .lock()
            .expect("notifications");
        assert_eq!(notifications[0].0, "initialized");
    }

    #[test]
    fn client_reports_transport_closed_state() {
        let fake = FakeTransport::default();
        *fake.closed.lock().expect("closed") = true;

        let client = CodexClient::new(fake, Duration::from_secs(1));

        assert!(client.is_closed());
    }

    #[tokio::test]
    async fn starts_plan_turn_with_codex_collaboration_mode() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .start_turn(CodexTurnStart::plan(
                "thread-1",
                "make a plan",
                "gpt-5.5".to_string(),
                Some("high".to_string()),
            ))
            .await
            .expect("turn");
        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "turn/start");
        assert_eq!(requests[0].1["collaborationMode"]["mode"], "plan");
        assert_eq!(
            requests[0].1["collaborationMode"]["settings"]["model"],
            "gpt-5.5"
        );
        assert_eq!(
            requests[0].1["collaborationMode"]["settings"]["reasoning_effort"],
            "high"
        );
    }

    #[tokio::test]
    async fn starts_thread_with_image_generation_preflight_dynamic_tool() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "thread": { "id": "thread-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .start_thread(
                CodexThreadStart {
                    cwd: None,
                    model: Some("gpt-5.5".to_string()),
                    model_provider: None,
                    sandbox: None,
                    approval_policy: None,
                    approvals_reviewer: None,
                    ephemeral: None,
                    developer_instructions: None,
                    dynamic_tools: Vec::new(),
                    image_generation_preflight_enabled: false,
                }
                .with_image_generation_preflight(),
            )
            .await
            .expect("thread");

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(
            requests[0].1["dynamicTools"][0]["name"],
            CODEX_IMAGE_GENERATION_PREFLIGHT_TOOL_NAME
        );
        assert!(
            requests[0].1["developerInstructions"]
                .as_str()
                .expect("instructions")
                .contains("Image Generation Preflight")
        );
        assert!(
            requests[0]
                .1
                .get("imageGenerationPreflightEnabled")
                .is_none()
        );
    }

    #[tokio::test]
    async fn starts_turn_with_image_generation_preflight_instructions() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .start_turn(
                CodexTurnStart::plan("thread-1", "create an image", "gpt-5.5".to_string(), None)
                    .with_image_generation_preflight(),
            )
            .await
            .expect("turn");

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "turn/start");
        assert!(requests[0].1.get("dynamicTools").is_none());
        assert!(
            requests[0].1["collaborationMode"]["settings"]["developer_instructions"]
                .as_str()
                .expect("instructions")
                .contains("Image Generation Preflight")
        );
    }

    #[test]
    fn detects_image_generation_preflight_server_requests() {
        assert!(is_image_generation_preflight_request(
            "item/tool/call",
            &json!({ "tool": "image_generation_prehook" })
        ));
        assert!(is_image_generation_preflight_request(
            "dynamicTool/call",
            &json!({ "toolName": "imagegen" })
        ));
        assert!(!is_image_generation_preflight_request(
            "item/tool/call",
            &json!({ "tool": "ace_browser" })
        ));
    }

    #[tokio::test]
    async fn steers_active_turn_with_expected_turn_precondition() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .steer_turn(CodexTurnSteer {
                thread_id: "thread-1".to_string(),
                expected_turn_id: "turn-1".to_string(),
                input: vec![json!({ "type": "text", "text": "add tests too" })],
                client_user_message_id: Some("user-message-1".to_string()),
            })
            .await
            .expect("steer turn");

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "turn/steer");
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["expectedTurnId"], "turn-1");
        assert_eq!(requests[0].1["clientUserMessageId"], "user-message-1");
        assert_eq!(requests[0].1["input"][0]["text"], "add tests too");
    }

    #[tokio::test]
    async fn thread_lifecycle_methods_use_typed_codex_app_server_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client.read_thread("thread-1").await.expect("read");
        client
            .list_threads(json!({ "includeArchived": true, "limit": 20 }))
            .await
            .expect("list");
        client.list_loaded_threads().await.expect("loaded");
        client.archive_thread("thread-1").await.expect("archive");
        client
            .unarchive_thread("thread-1")
            .await
            .expect("unarchive");
        client.delete_thread("thread-1").await.expect("delete");
        client
            .unsubscribe_thread("thread-1")
            .await
            .expect("unsubscribe");
        client
            .set_thread_name("thread-1", "Adapter work")
            .await
            .expect("set name");
        client
            .update_thread_metadata("thread-1", json!({ "project": "ace" }))
            .await
            .expect("metadata");
        client.compact_thread("thread-1").await.expect("compact");
        client
            .rollback_thread("thread-1", "turn-2")
            .await
            .expect("rollback");
        client
            .inject_thread_items("thread-1", vec![json!({ "type": "userMessage" })])
            .await
            .expect("inject");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "thread/read",
                "thread/list",
                "thread/loaded/list",
                "thread/archive",
                "thread/unarchive",
                "thread/delete",
                "thread/unsubscribe",
                "thread/name/set",
                "thread/metadata/update",
                "thread/compact/start",
                "thread/rollback",
                "thread/inject_items",
            ]
        );
        assert_eq!(requests[7].1["name"], "Adapter work");
        assert_eq!(requests[8].1["metadata"]["project"], "ace");
        assert_eq!(requests[10].1["turnId"], "turn-2");
        assert_eq!(requests[11].1["items"][0]["type"], "userMessage");
    }

    #[tokio::test]
    async fn continues_plan_by_injecting_accepted_plan_then_starting_turn() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "injected": 1 })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let response = client
            .continue_plan_in_thread(CodexPlanImplementation {
                thread_id: "thread-1".to_string(),
                plan: json!({ "markdown": "Do it carefully" }),
                prompt: "implement the plan".to_string(),
                model: Some("gpt-5.5".to_string()),
                reasoning_effort: Some("high".to_string()),
                cwd: None,
                sandbox_policy: None,
                approval_policy: None,
                approvals_reviewer: None,
            })
            .await
            .expect("continue plan");

        assert_eq!(response["threadId"], "thread-1");
        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "thread/inject_items");
        assert_eq!(requests[0].1["items"][0]["status"], "accepted");
        assert_eq!(requests[1].0, "turn/start");
        assert_eq!(requests[1].1["threadId"], "thread-1");
        assert_eq!(requests[1].1["model"], "gpt-5.5");
        assert_eq!(requests[1].1["reasoningEffort"], "high");
    }

    #[tokio::test]
    async fn forks_plan_implementation_into_new_or_side_thread() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "thread": { "id": "fork-1" } })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "injected": 1 })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "turn": { "id": "turn-1" } })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let response = client
            .side_implementation(CodexPlanImplementation {
                thread_id: "thread-1".to_string(),
                plan: json!({ "markdown": "Implement in isolation" }),
                prompt: "build it".to_string(),
                model: None,
                reasoning_effort: None,
                cwd: Some("/tmp/repo".to_string()),
                sandbox_policy: None,
                approval_policy: None,
                approvals_reviewer: None,
            })
            .await
            .expect("side implementation");

        assert_eq!(response["threadId"], "fork-1");
        assert_eq!(response["parentThreadId"], "thread-1");
        assert_eq!(response["ephemeral"], true);
        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "thread/fork");
        assert_eq!(requests[0].1["ephemeral"], true);
        assert_eq!(requests[1].0, "thread/inject_items");
        assert_eq!(requests[1].1["threadId"], "fork-1");
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(requests[2].1["threadId"], "fork-1");
        assert_eq!(requests[2].1["cwd"], "/tmp/repo");
    }

    #[tokio::test]
    async fn reads_permission_catalog_and_retries_guardian_denials() {
        let fake = FakeTransport::default();
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({
                "allowedPermissionPresets": ["strict", "auto_review"]
            })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({
                "profiles": [{ "id": "strict" }, { "id": "auto_review" }]
            })));
        fake.responses
            .lock()
            .expect("responses")
            .push_back(Ok(json!({ "approved": true })));
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let catalog = client.permission_catalog().await.expect("catalog");
        assert_eq!(catalog.available_presets.len(), 2);
        client
            .approve_guardian_denied_action(CodexGuardianDeniedActionApproval {
                thread_id: "thread-1".to_string(),
                item_id: Some("item-1".to_string()),
                action_id: Some("action-1".to_string()),
                approved: true,
                reason: Some("user approved retry".to_string()),
                audit: json!({ "reviewer": "user" }),
            })
            .await
            .expect("approve denial");

        let requests = client.transport.requests.lock().expect("requests");
        assert_eq!(requests[0].0, "configRequirements/read");
        assert_eq!(requests[1].0, "permissionProfile/list");
        assert_eq!(requests[2].0, "thread/approveGuardianDeniedAction");
        assert_eq!(requests[2].1["threadId"], "thread-1");
        assert_eq!(requests[2].1["approved"], true);
    }

    #[tokio::test]
    async fn goal_methods_use_typed_codex_app_server_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .goal_set(CodexGoalSet {
                thread_id: "thread-1".to_string(),
                objective: "finish the adapter".to_string(),
                token_budget: Some(10_000),
            })
            .await
            .expect("goal set");
        client.goal_get("thread-1").await.expect("goal get");
        client.goal_pause("thread-1").await.expect("goal pause");
        client.goal_resume("thread-1").await.expect("goal resume");
        client.goal_clear("thread-1").await.expect("goal clear");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "thread/goal/set",
                "thread/goal/get",
                "thread/goal/set",
                "thread/goal/set",
                "thread/goal/clear"
            ]
        );
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["objective"], "finish the adapter");
        assert_eq!(requests[0].1["tokenBudget"], 10_000);
        assert_eq!(requests[2].1["status"], "paused");
        assert_eq!(requests[3].1["status"], "active");
    }

    #[tokio::test]
    async fn subagent_and_handoff_methods_use_typed_codex_app_server_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client.subagent_list("thread-1").await.expect("list");
        client
            .subagent_read("thread-1", "subagent-1")
            .await
            .expect("read");
        client
            .subagent_steer(CodexSubagentSteer {
                thread_id: "thread-1".to_string(),
                subagent_thread_id: "subagent-1".to_string(),
                prompt: "focus on tests".to_string(),
            })
            .await
            .expect("steer");
        client
            .subagent_stop("thread-1", "subagent-1")
            .await
            .expect("stop");
        client
            .subagent_close("thread-1", "subagent-1")
            .await
            .expect("close");
        client
            .handoff_to_agent(CodexHandoffToAgent {
                thread_id: "thread-1".to_string(),
                prompt: "take over implementation".to_string(),
                agent_role: Some("implementer".to_string()),
                nickname: Some("builder".to_string()),
                model: Some("gpt-5.5".to_string()),
                reasoning_effort: Some("high".to_string()),
                sandbox_policy: Some(json!({ "mode": "workspace-write" })),
                approval_policy: Some(json!({ "mode": "on-request" })),
                approvals_reviewer: Some("user".to_string()),
                skills: vec!["rust".to_string()],
                mcp_config: json!({ "servers": [] }),
            })
            .await
            .expect("handoff");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "subagent/list",
                "subagent/read",
                "subagent/steer",
                "subagent/stop",
                "subagent/close",
                "thread/handoffToAgent",
            ]
        );
        assert_eq!(requests[2].1["prompt"], "focus on tests");
        assert_eq!(requests[5].1["agentRole"], "implementer");
        assert_eq!(requests[5].1["skills"][0], "rust");
    }

    #[tokio::test]
    async fn version_gated_tool_methods_use_documented_codex_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .review_start(CodexReviewStart {
                thread_id: "thread-1".to_string(),
                detached: Some(true),
                base_turn_id: Some("turn-1".to_string()),
            })
            .await
            .expect("review");
        client
            .thread_shell_command(json!({ "threadId": "thread-1", "command": "pwd" }))
            .await
            .expect("thread shell command");
        client
            .command_exec(json!({ "command": "cargo test" }))
            .await
            .expect("exec");
        client
            .command_write_stdin(json!({ "processId": "p1", "stdin": "q" }))
            .await
            .expect("stdin");
        client
            .command_resize(json!({ "processId": "p1", "cols": 120, "rows": 40 }))
            .await
            .expect("resize");
        client
            .command_terminate(json!({ "processId": "p1" }))
            .await
            .expect("terminate");
        client.process_list(json!({})).await.expect("process list");
        client
            .process_clean(json!({}))
            .await
            .expect("process clean");
        client
            .fs_read_file(json!({ "path": "src/lib.rs" }))
            .await
            .expect("read file");
        client
            .fs_write_file(json!({ "path": "src/lib.rs", "contents": "pub fn main() {}" }))
            .await
            .expect("write file");
        client
            .fs_read_directory(json!({ "path": "src", "recursive": false }))
            .await
            .expect("read directory");
        client
            .fs_create_directory(json!({ "path": "src/generated" }))
            .await
            .expect("create directory");
        client
            .fs_copy(json!({ "fromPath": "src/lib.rs", "toPath": "src/lib.copy.rs" }))
            .await
            .expect("copy");
        client
            .fs_remove(json!({ "path": "src/lib.copy.rs" }))
            .await
            .expect("remove");
        client
            .fs_metadata(json!({ "path": "src/lib.rs" }))
            .await
            .expect("metadata");
        client
            .fs_watch(json!({ "path": "src" }))
            .await
            .expect("watch");
        client
            .fs_unwatch(json!({ "path": "src" }))
            .await
            .expect("unwatch");
        client.mcp_status(json!({})).await.expect("mcp status");
        client
            .mcp_resource_read(json!({ "server": "docs", "uri": "file://readme" }))
            .await
            .expect("resource");
        client
            .mcp_oauth_login(json!({ "server": "github" }))
            .await
            .expect("oauth");
        client
            .mcp_tool_call(json!({ "server": "github", "tool": "list_issues" }))
            .await
            .expect("tool call");
        client
            .skills_list(CodexNamedQuery::default())
            .await
            .expect("skills list");
        client
            .skills_read(CodexSkillRequest {
                skill: "rust".to_string(),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("skills read");
        client
            .skills_install(CodexSkillRequest {
                skill: "rust".to_string(),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("skills install");
        client
            .skills_config_write(CodexSkillsConfigWrite {
                config: json!({ "enabled": ["rust"] }),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("skills config");
        client
            .skills_extra_roots_set(CodexSkillsExtraRootsSet {
                roots: vec!["/tmp/skills".to_string()],
                extra: serde_json::Map::new(),
            })
            .await
            .expect("skills extra roots");
        client
            .plugins_installed(CodexNamedQuery::default())
            .await
            .expect("plugins installed");
        client
            .plugins_list(CodexNamedQuery::default())
            .await
            .expect("plugins list");
        client
            .plugins_read(CodexPluginRequest {
                plugin: "browser".to_string(),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugins read");
        client
            .plugins_install(CodexPluginRequest {
                plugin: "browser".to_string(),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugins install");
        client
            .plugins_uninstall(CodexPluginRequest {
                plugin: "browser".to_string(),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugins uninstall");
        client
            .plugin_share_checkout(CodexPluginShareRequest {
                plugin: None,
                share_id: Some("share-1".to_string()),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugin share checkout");
        client
            .plugin_share_delete(CodexPluginShareRequest {
                plugin: None,
                share_id: Some("share-1".to_string()),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugin share delete");
        client
            .plugin_share_list(CodexPluginShareRequest::default())
            .await
            .expect("plugin share list");
        client
            .plugin_share_save(CodexPluginShareSave {
                plugin: "browser".to_string(),
                targets: vec!["team".to_string()],
                metadata: None,
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugin share save");
        client
            .plugin_share_update_targets(CodexPluginShareUpdateTargets {
                share_id: "share-1".to_string(),
                targets: vec!["team".to_string()],
                extra: serde_json::Map::new(),
            })
            .await
            .expect("plugin share update targets");
        client
            .apps_list(CodexNamedQuery::default())
            .await
            .expect("apps list");
        client
            .apps_config_write(CodexAppConfigWrite {
                app: "browser".to_string(),
                config: json!({}),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("apps config");
        client
            .remote_connection_list(json!({}))
            .await
            .expect("remote list");
        client
            .remote_handoff(json!({ "threadId": "thread-1", "host": "devbox" }))
            .await
            .expect("remote handoff");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "review/start",
                "thread/shellCommand",
                "command/exec",
                "command/exec/write",
                "command/exec/resize",
                "command/exec/terminate",
                "process/list",
                "process/clean",
                "fs/readFile",
                "fs/writeFile",
                "fs/readDirectory",
                "fs/createDirectory",
                "fs/copy",
                "fs/remove",
                "fs/getMetadata",
                "fs/watch",
                "fs/unwatch",
                "mcpServerStatus/list",
                "mcpServer/resource/read",
                "mcpServer/oauth/login",
                "mcpServer/tool/call",
                "skills/list",
                "plugin/skill/read",
                "skills/install",
                "skills/config/write",
                "skills/extraRoots/set",
                "plugin/installed",
                "plugin/list",
                "plugin/read",
                "plugin/install",
                "plugin/uninstall",
                "plugin/share/checkout",
                "plugin/share/delete",
                "plugin/share/list",
                "plugin/share/save",
                "plugin/share/updateTargets",
                "app/list",
                "apps/configWrite",
                "remote/connectionList",
                "remote/handoff",
            ]
        );
        assert_eq!(requests[0].1["threadId"], "thread-1");
        assert_eq!(requests[0].1["detached"], true);
        assert_eq!(requests[0].1["baseTurnId"], "turn-1");
        assert_eq!(requests[1].1["command"], "pwd");
        assert_eq!(requests[2].1["command"], "cargo test");
        assert_eq!(requests[12].1["fromPath"], "src/lib.rs");
        assert_eq!(requests[20].1["tool"], "list_issues");
        assert_eq!(requests[22].1["skill"], "rust");
        assert_eq!(requests[31].1["shareId"], "share-1");
        assert_eq!(requests[34].1["targets"][0], "team");
        assert_eq!(requests.last().expect("remote handoff").1["host"], "devbox");
    }

    #[tokio::test]
    async fn account_and_windows_methods_use_documented_codex_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client
            .account_login_start(json!({ "provider": "chatgpt" }))
            .await
            .expect("login start");
        client
            .account_login_cancel(json!({ "flowId": "flow-1" }))
            .await
            .expect("login cancel");
        client
            .account_logout(json!({ "accountId": "acct-1" }))
            .await
            .expect("logout");
        client.account_read(json!({})).await.expect("account read");
        client
            .account_rate_limit_reset_credit_consume(json!({
                "accountId": "acct-1",
                "source": "rate-limit-banner"
            }))
            .await
            .expect("rate-limit reset credit consume");
        client
            .account_rate_limits_read(json!({ "accountId": "acct-1" }))
            .await
            .expect("rate limits");
        client
            .account_usage_read(json!({ "accountId": "acct-1" }))
            .await
            .expect("usage");
        client
            .account_send_add_credits_nudge_email(json!({ "accountId": "acct-1" }))
            .await
            .expect("nudge");
        client
            .windows_sandbox_readiness(json!({}))
            .await
            .expect("windows readiness");
        client
            .windows_sandbox_setup_start(json!({ "mode": "default" }))
            .await
            .expect("windows setup");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "account/login/start",
                "account/login/cancel",
                "account/logout",
                "account/read",
                "account/rateLimitResetCredit/consume",
                "account/rateLimits/read",
                "account/usage/read",
                "account/sendAddCreditsNudgeEmail",
                "windowsSandbox/readiness",
                "windowsSandbox/setupStart",
            ]
        );
        assert_eq!(requests[0].1["provider"], "chatgpt");
        let windows_setup = requests
            .iter()
            .find(|(method, _)| method == "windowsSandbox/setupStart")
            .expect("windows setup request");
        assert_eq!(windows_setup.1["mode"], "default");
    }

    #[tokio::test]
    async fn config_marketplace_and_external_methods_use_documented_codex_calls() {
        let fake = FakeTransport::default();
        let client = CodexClient::new(fake, Duration::from_secs(1));

        client.config_read(json!({})).await.expect("config read");
        client
            .config_value_write(json!({ "key": "model", "value": "gpt-5" }))
            .await
            .expect("config write");
        client
            .config_batch_write(json!({ "values": { "model": "gpt-5" } }))
            .await
            .expect("config batch");
        client
            .config_mcp_server_reload(json!({ "server": "github" }))
            .await
            .expect("mcp reload");
        client
            .experimental_feature_list(json!({}))
            .await
            .expect("feature list");
        client
            .experimental_feature_enablement_set(json!({ "feature": "plan_mode", "enabled": true }))
            .await
            .expect("feature enablement");
        client
            .external_agent_config_detect(json!({ "cwd": "/tmp/repo" }))
            .await
            .expect("external detect");
        client
            .external_agent_config_import(json!({ "agent": "codex" }))
            .await
            .expect("external import");
        client
            .feedback_upload(json!({ "kind": "bug" }))
            .await
            .expect("feedback upload");
        client
            .fuzzy_file_search(json!({ "query": "main" }))
            .await
            .expect("fuzzy search");
        client.hooks_list(json!({})).await.expect("hooks list");
        client
            .marketplace_add(CodexMarketplaceRequest {
                plugin: "browser".to_string(),
                target: Some("personal".to_string()),
                version: None,
                extra: serde_json::Map::new(),
            })
            .await
            .expect("marketplace add");
        client
            .marketplace_remove(CodexMarketplaceRequest {
                plugin: "browser".to_string(),
                target: Some("personal".to_string()),
                version: None,
                extra: serde_json::Map::new(),
            })
            .await
            .expect("marketplace remove");
        client
            .marketplace_upgrade(CodexMarketplaceRequest {
                plugin: "browser".to_string(),
                target: None,
                version: Some("latest".to_string()),
                extra: serde_json::Map::new(),
            })
            .await
            .expect("marketplace upgrade");
        client
            .model_list(json!({ "provider": "openai" }))
            .await
            .expect("model list");
        client
            .model_provider_capabilities_read(json!({ "provider": "openai" }))
            .await
            .expect("model provider capabilities");

        let requests = client.transport.requests.lock().expect("requests");
        let methods = requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            [
                "config/read",
                "config/value/write",
                "config/batchWrite",
                "config/mcpServer/reload",
                "experimentalFeature/list",
                "experimentalFeature/enablement/set",
                "externalAgentConfig/detect",
                "externalAgentConfig/import",
                "feedback/upload",
                "fuzzyFileSearch",
                "hooks/list",
                "marketplace/add",
                "marketplace/remove",
                "marketplace/upgrade",
                "model/list",
                "modelProvider/capabilities/read",
            ]
        );
        assert_eq!(requests[1].1["key"], "model");
        assert_eq!(requests[9].1["query"], "main");
        assert_eq!(requests[11].1["target"], "personal");
        assert_eq!(requests[13].1["version"], "latest");
        assert_eq!(requests[14].1["provider"], "openai");
        assert_eq!(requests[15].1["provider"], "openai");
    }

    #[tokio::test]
    async fn exposes_semantic_provider_events_from_inbound_codex_items() {
        let fake = FakeTransport::default();
        fake.inbound
            .lock()
            .expect("inbound")
            .push_back(CodexInboundEvent::Notification {
                method: "item/completed".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": {
                        "id": "item-1",
                        "type": "mcpToolCall",
                        "serverName": "browser",
                        "toolName": "ace_browser",
                        "input": {
                            "operation": "cua_click",
                            "label": "Continue"
                        }
                    }
                }),
            });
        let client = CodexClient::new(fake, Duration::from_secs(1));

        let events = client.next_provider_events().await.expect("events");
        assert!(matches!(
            &events[0],
            ProviderEvent::SemanticTool { tool }
                if tool.display.title == "Clicked Continue in Browser"
        ));
    }

    #[test]
    fn adapter_descriptor_advertises_codex_and_semantic_tools() {
        let client = CodexClient::new(FakeTransport::default(), Duration::from_secs(1));
        let adapter = CodexAdapter::new(client);
        let descriptor = adapter.descriptor();

        assert_eq!(descriptor.kind, ProviderKind::Codex);
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "provider.adapter_contract")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "provider.semantic_tools")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.compatibility_inventory")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.app_server_transport.stdio")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.app_server_transport.unix_socket")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.app_server_transport.websocket")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.execution_location.local")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .any(|capability| capability.key == "codex.execution_location.worktree")
        );
        assert!(
            descriptor
                .capabilities
                .iter()
                .all(|capability| capability.key != "codex.execution_location.cloud")
        );
    }
}
