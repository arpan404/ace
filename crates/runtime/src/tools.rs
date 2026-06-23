use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider::ServerRequestKind;
use crate::server_requests::server_request_kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolTransport {
    CodexBuiltin,
    CodexDynamic,
    DynamicTool,
    Mcp,
    AppConnector,
    BrowserBridge,
    ComputerBridge,
    Shell,
    Filesystem,
    Process,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSurface {
    Browser,
    Computer,
    Terminal,
    Filesystem,
    Git,
    Github,
    WebSearch,
    Image,
    Subagent,
    Plan,
    Realtime,
    Handoff,
    Review,
    Skill,
    Plugin,
    App,
    GenericMcp,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolActionKind {
    #[serde(rename = "browser.click")]
    BrowserClick,
    #[serde(rename = "browser.type")]
    BrowserType,
    #[serde(rename = "browser.navigate")]
    BrowserNavigate,
    #[serde(rename = "browser.screenshot")]
    BrowserScreenshot,
    #[serde(rename = "browser.inspect")]
    BrowserInspect,
    #[serde(rename = "browser.logs")]
    BrowserLogs,
    #[serde(rename = "browser.tab")]
    BrowserTab,
    #[serde(rename = "browser.console")]
    BrowserConsole,
    #[serde(rename = "browser.scroll")]
    BrowserScroll,
    #[serde(rename = "browser.key")]
    BrowserKey,
    #[serde(rename = "browser.clipboard")]
    BrowserClipboard,
    #[serde(rename = "browser.wait")]
    BrowserWait,
    #[serde(rename = "browser.viewport")]
    BrowserViewport,
    #[serde(rename = "browser.zoom")]
    BrowserZoom,
    #[serde(rename = "computer.click")]
    ComputerClick,
    #[serde(rename = "computer.type")]
    ComputerType,
    #[serde(rename = "computer.scroll")]
    ComputerScroll,
    #[serde(rename = "computer.key")]
    ComputerKey,
    #[serde(rename = "computer.screenshot")]
    ComputerScreenshot,
    #[serde(rename = "computer.app")]
    ComputerApp,
    #[serde(rename = "terminal.run")]
    TerminalRun,
    #[serde(rename = "terminal.write")]
    TerminalWrite,
    #[serde(rename = "terminal.resize")]
    TerminalResize,
    #[serde(rename = "terminal.terminate")]
    TerminalTerminate,
    #[serde(rename = "terminal.output")]
    TerminalOutput,
    #[serde(rename = "file.read")]
    FileRead,
    #[serde(rename = "file.edit")]
    FileEdit,
    #[serde(rename = "file.patch")]
    FilePatch,
    #[serde(rename = "file.search")]
    FileSearch,
    #[serde(rename = "git.commit")]
    GitCommit,
    #[serde(rename = "git.push")]
    GitPush,
    #[serde(rename = "github.issue")]
    GithubIssue,
    #[serde(rename = "github.pr")]
    GithubPullRequest,
    #[serde(rename = "github.check")]
    GithubCheck,
    #[serde(rename = "github.commit")]
    GithubCommit,
    #[serde(rename = "github.search")]
    GithubSearch,
    #[serde(rename = "web.search")]
    WebSearch,
    #[serde(rename = "image.view")]
    ImageView,
    #[serde(rename = "image.generate")]
    ImageGenerate,
    #[serde(rename = "subagent.spawn")]
    SubagentSpawn,
    #[serde(rename = "subagent.steer")]
    SubagentSteer,
    #[serde(rename = "subagent.stop")]
    SubagentStop,
    #[serde(rename = "subagent.close")]
    SubagentClose,
    #[serde(rename = "plan.continue")]
    PlanContinue,
    #[serde(rename = "plan.fork")]
    PlanFork,
    #[serde(rename = "plan.side_implementation")]
    PlanSideImplementation,
    #[serde(rename = "realtime.start")]
    RealtimeStart,
    #[serde(rename = "realtime.stop")]
    RealtimeStop,
    #[serde(rename = "realtime.append_text")]
    RealtimeAppendText,
    #[serde(rename = "realtime.append_speech")]
    RealtimeAppendSpeech,
    #[serde(rename = "realtime.append_audio")]
    RealtimeAppendAudio,
    #[serde(rename = "realtime.list_voices")]
    RealtimeListVoices,
    #[serde(rename = "handoff.agent")]
    HandoffAgent,
    #[serde(rename = "handoff.location")]
    HandoffLocation,
    #[serde(rename = "review.start")]
    ReviewStart,
    #[serde(rename = "skill.list")]
    SkillList,
    #[serde(rename = "skill.read")]
    SkillRead,
    #[serde(rename = "skill.install")]
    SkillInstall,
    #[serde(rename = "skill.configure")]
    SkillConfigure,
    #[serde(rename = "plugin.list")]
    PluginList,
    #[serde(rename = "plugin.read")]
    PluginRead,
    #[serde(rename = "plugin.install")]
    PluginInstall,
    #[serde(rename = "plugin.uninstall")]
    PluginUninstall,
    #[serde(rename = "plugin.share")]
    PluginShare,
    #[serde(rename = "plugin.marketplace_add")]
    PluginMarketplaceAdd,
    #[serde(rename = "plugin.marketplace_remove")]
    PluginMarketplaceRemove,
    #[serde(rename = "plugin.marketplace_upgrade")]
    PluginMarketplaceUpgrade,
    #[serde(rename = "app.list")]
    AppList,
    #[serde(rename = "app.configure")]
    AppConfigure,
    #[serde(rename = "tool.run")]
    ToolRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRunStatus {
    Started,
    Updated,
    Completed,
    Failed,
    ApprovalRequested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolTargetKind {
    Url,
    Selector,
    Element,
    Coordinates,
    File,
    Command,
    Repository,
    Issue,
    PullRequest,
    Application,
    Window,
    Terminal,
    Agent,
    Text,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolTarget {
    pub kind: ToolTargetKind,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolDisplay {
    pub title: String,
    pub summary: Option<String>,
    pub target: Option<ToolTarget>,
    pub status: ToolRunStatus,
    pub icon_key: String,
    #[serde(default)]
    pub technical_metadata: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderToolMetadata {
    pub provider: Option<String>,
    pub method: Option<String>,
    pub item_id: Option<String>,
    pub turn_id: Option<String>,
    pub thread_id: Option<String>,
    pub server_name: Option<String>,
    pub tool_name: Option<String>,
    pub operation: Option<String>,
    pub raw_args: Value,
    pub raw_result: Value,
    pub raw_payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SemanticToolCall {
    pub transport: ToolTransport,
    pub surface: ToolSurface,
    pub action: ToolActionKind,
    pub display: ToolDisplay,
    pub provider: ProviderToolMetadata,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolNormalizationInput {
    pub transport: ToolTransport,
    pub status: ToolRunStatus,
    pub provider: ProviderToolMetadata,
    pub item_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderToolEventNormalizationInput {
    pub provider: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderServerRequestToolNormalizationInput {
    pub provider: String,
    pub request_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl ProviderToolMetadata {
    #[must_use]
    pub fn new() -> Self {
        Self {
            provider: None,
            method: None,
            item_id: None,
            turn_id: None,
            thread_id: None,
            server_name: None,
            tool_name: None,
            operation: None,
            raw_args: Value::Null,
            raw_result: Value::Null,
            raw_payload: Value::Null,
        }
    }
}

impl Default for ProviderToolMetadata {
    fn default() -> Self {
        Self::new()
    }
}

#[must_use]
pub fn normalize_tool_call(input: ToolNormalizationInput) -> SemanticToolCall {
    let facts = ToolFacts::from_input(&input);
    let (surface, action) = infer_surface_action(&input, &facts);
    let target = infer_target(surface, action, &input, &facts);
    let display = display_for(input.status, surface, action, target, &input, &facts);

    SemanticToolCall {
        transport: input.transport,
        surface,
        action,
        display,
        provider: input.provider,
    }
}

#[must_use]
pub fn normalize_provider_tool_event(
    input: ProviderToolEventNormalizationInput,
) -> Option<SemanticToolCall> {
    let status = match input.method.as_str() {
        "item/started" => ToolRunStatus::Started,
        "item/completed" => ToolRunStatus::Completed,
        "item/commandExecution/outputDelta"
        | "item/commandExecution/terminalInteraction"
        | "item/fileChange/outputDelta"
        | "item/fileChange/patchUpdated"
        | "item/mcpToolCall/progress"
        | "item/dynamicToolCall/progress"
        | "item/collabAgentToolCall/progress"
        | "item/subAgentActivity/delta"
        | "command/exec/outputDelta"
        | "process/outputDelta" => ToolRunStatus::Updated,
        "item/failed" => ToolRunStatus::Failed,
        "item/commandExecution/requestApproval"
        | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" => ToolRunStatus::ApprovalRequested,
        _ => return None,
    };

    let item = input.params.get("item").unwrap_or(&input.params);
    let item_type = string_at(item, "type")
        .or_else(|| item_type_from_method(&input.method))
        .unwrap_or_else(|| input.method.clone());
    if !is_tool_item_type(&item_type) {
        return None;
    }

    let mut provider = ProviderToolMetadata::new();
    provider.provider = Some(input.provider);
    provider.method = Some(input.method.clone());
    provider.thread_id = string_at(&input.params, "threadId");
    provider.turn_id = string_at(&input.params, "turnId");
    provider.item_id = string_at(&input.params, "itemId").or_else(|| string_at(item, "id"));
    provider.tool_name = tool_name_for_item(&item_type, item);
    provider.server_name = string_at_deep(item, "serverName")
        .or_else(|| string_at_deep(item, "server_name"))
        .or_else(|| string_at_deep(item, "server"))
        .or_else(|| string_at_deep(item, "mcpServer"));
    provider.operation = operation_for_item(&item_type, item);
    provider.raw_args = args_for_item(item);
    provider.raw_result = item.get("result").cloned().unwrap_or(Value::Null);
    provider.raw_payload = input.params;

    let transport = transport_for_item(&item_type, &provider);
    Some(normalize_tool_call(ToolNormalizationInput {
        transport,
        status,
        provider,
        item_type: Some(item_type),
    }))
}

#[must_use]
pub fn normalize_provider_server_request_tool(
    input: ProviderServerRequestToolNormalizationInput,
) -> Option<SemanticToolCall> {
    let kind = server_request_kind(&input.method);
    let item_type = tool_item_type_for_server_request(kind)?;
    let mut provider = ProviderToolMetadata::new();
    provider.provider = Some(input.provider);
    provider.method = Some(input.method);
    provider.thread_id = string_at(&input.params, "threadId")
        .or_else(|| string_at(&input.params, "thread_id"))
        .or_else(|| nested_string_at(&input.params, "/thread", &["id", "threadId", "thread_id"]));
    provider.turn_id =
        string_at(&input.params, "turnId").or_else(|| string_at(&input.params, "turn_id"));
    provider.item_id = string_at(&input.params, "itemId")
        .or_else(|| string_at(&input.params, "item_id"))
        .or_else(|| string_at(&input.params, "sourceItemId"))
        .or_else(|| string_at(&input.params, "source_item_id"))
        .or_else(|| string_at(&input.params, "toolCallId"))
        .or_else(|| string_at(&input.params, "tool_call_id"))
        .or(Some(input.request_id));
    provider.server_name = string_at_deep(&input.params, "serverName")
        .or_else(|| string_at_deep(&input.params, "server_name"))
        .or_else(|| string_at_deep(&input.params, "server"))
        .or_else(|| string_at_deep(&input.params, "mcpServer"));
    provider.tool_name = tool_name_for_server_request(kind, &input.params);
    provider.operation = operation_for_server_request(kind, &input.params);
    provider.raw_args = args_for_server_request(&input.params);
    provider.raw_result = input.params.get("result").cloned().unwrap_or(Value::Null);
    provider.raw_payload = input.params;

    Some(normalize_tool_call(ToolNormalizationInput {
        transport: transport_for_server_request(kind, &provider),
        status: ToolRunStatus::ApprovalRequested,
        provider,
        item_type: Some(item_type.to_string()),
    }))
}

struct ToolFacts {
    op: String,
    tool: String,
    server: String,
    haystack: String,
}

impl ToolFacts {
    fn from_input(input: &ToolNormalizationInput) -> Self {
        let op = first_string([
            input.provider.operation.as_deref(),
            string_at_deep(&input.provider.raw_args, "operation").as_deref(),
            string_at_deep(&input.provider.raw_args, "action").as_deref(),
            string_at_deep(&input.provider.raw_args, "action_type").as_deref(),
            string_at_deep(&input.provider.raw_args, "name").as_deref(),
        ])
        .unwrap_or_default();
        let tool = first_string([
            input.provider.tool_name.as_deref(),
            string_at_deep(&input.provider.raw_args, "toolName").as_deref(),
            string_at_deep(&input.provider.raw_args, "tool_name").as_deref(),
            string_at_deep(&input.provider.raw_args, "tool").as_deref(),
            string_at_deep(&input.provider.raw_args, "name").as_deref(),
        ])
        .unwrap_or_default();
        let server = first_string([
            input.provider.server_name.as_deref(),
            string_at_deep(&input.provider.raw_args, "serverName").as_deref(),
            string_at_deep(&input.provider.raw_args, "server_name").as_deref(),
            string_at_deep(&input.provider.raw_args, "server").as_deref(),
            string_at_deep(&input.provider.raw_payload, "serverName").as_deref(),
            string_at_deep(&input.provider.raw_payload, "server_name").as_deref(),
            string_at_deep(&input.provider.raw_payload, "server").as_deref(),
        ])
        .unwrap_or_default();
        let haystack = [
            input.item_type.as_deref().unwrap_or_default(),
            input.provider.method.as_deref().unwrap_or_default(),
            &server,
            &tool,
            &op,
            string_at_deep(&input.provider.raw_payload, "type")
                .as_deref()
                .unwrap_or_default(),
        ]
        .join(" ");
        let haystack = format!("{haystack} {}", spaced_words(&haystack))
            .to_lowercase()
            .replace(['_', '-', '.', '/'], " ");

        Self {
            op,
            tool,
            server,
            haystack,
        }
    }
}

fn infer_surface_action(
    input: &ToolNormalizationInput,
    facts: &ToolFacts,
) -> (ToolSurface, ToolActionKind) {
    if let Some(mapped) = skill_action(facts) {
        return (ToolSurface::Skill, mapped);
    }
    if let Some(mapped) = plugin_action(facts) {
        return (ToolSurface::Plugin, mapped);
    }
    if let Some(mapped) = app_action(facts) {
        return (ToolSurface::App, mapped);
    }
    if let Some(mapped) = browser_action(input.transport, facts) {
        return (ToolSurface::Browser, mapped);
    }
    if let Some(mapped) = computer_action(input.transport, facts, &input.provider.raw_args) {
        return (ToolSurface::Computer, mapped);
    }
    if let Some(mapped) = realtime_action(facts) {
        return (ToolSurface::Realtime, mapped);
    }
    if let Some(mapped) = terminal_action(input.transport, facts, &input.provider.raw_args) {
        return (ToolSurface::Terminal, mapped);
    }
    if let Some(mapped) = file_action(&facts.haystack) {
        return (ToolSurface::Filesystem, mapped);
    }
    if let Some(mapped) = github_action(facts) {
        return (ToolSurface::Github, mapped);
    }
    if let Some(mapped) = git_action(facts) {
        return (ToolSurface::Git, mapped);
    }
    if facts.haystack.contains("web search") || facts.haystack.contains("websearch") {
        return (ToolSurface::WebSearch, ToolActionKind::WebSearch);
    }
    if facts.haystack.contains("image generation")
        || facts.haystack.contains("imagegeneration")
        || facts.haystack.contains("generate image")
    {
        return (ToolSurface::Image, ToolActionKind::ImageGenerate);
    }
    if facts.haystack.contains("image view")
        || facts.haystack.contains("imageview")
        || facts.haystack.contains("view image")
    {
        return (ToolSurface::Image, ToolActionKind::ImageView);
    }
    if facts.haystack.contains("plan implementation")
        || facts.haystack.contains("ace plan")
        || facts.haystack.contains("plan continue")
        || facts.haystack.contains("plan fork")
        || facts.haystack.contains("side implementation")
    {
        let action = if facts.haystack.contains("side implementation") {
            ToolActionKind::PlanSideImplementation
        } else if facts.haystack.contains("fork") {
            ToolActionKind::PlanFork
        } else {
            ToolActionKind::PlanContinue
        };
        return (ToolSurface::Plan, action);
    }
    if facts.haystack.contains("handoff") {
        let action = if facts.haystack.contains("agent") {
            ToolActionKind::HandoffAgent
        } else {
            ToolActionKind::HandoffLocation
        };
        return (ToolSurface::Handoff, action);
    }
    if facts.op.eq_ignore_ascii_case("review_start") || facts.haystack.contains("review start") {
        return (ToolSurface::Review, ToolActionKind::ReviewStart);
    }
    if facts.haystack.contains("subagent")
        || facts.haystack.contains("collab agent")
        || facts.haystack.contains("agent spawn")
    {
        let action = if facts.haystack.contains("steer") || facts.haystack.contains("message") {
            ToolActionKind::SubagentSteer
        } else if facts.haystack.contains("close") {
            ToolActionKind::SubagentClose
        } else if facts.haystack.contains("stop") || facts.haystack.contains("terminate") {
            ToolActionKind::SubagentStop
        } else {
            ToolActionKind::SubagentSpawn
        };
        return (ToolSurface::Subagent, action);
    }
    if input.transport == ToolTransport::Mcp {
        return (ToolSurface::GenericMcp, ToolActionKind::ToolRun);
    }
    (ToolSurface::Unknown, ToolActionKind::ToolRun)
}

fn browser_action(transport: ToolTransport, facts: &ToolFacts) -> Option<ToolActionKind> {
    let raw_op = first_string([Some(facts.op.as_str()), Some(facts.tool.as_str())])
        .unwrap_or_default()
        .to_lowercase();
    let op = canonical_operation_name(&raw_op, &["mcp__browser__", "browser_", "browser."]);
    if transport != ToolTransport::BrowserBridge
        && !facts.haystack.contains("browser")
        && !facts.haystack.contains("playwright")
        && !facts.haystack.contains("dom cua")
        && !facts.haystack.contains("ace browser")
    {
        return None;
    }

    let action = match op.as_str() {
        "click"
        | "locator_click"
        | "cua_click"
        | "dom_cua_click"
        | "playwright_locator_click"
        | "playwright_locator_dblclick"
        | "dblclick"
        | "double_click"
        | "cua_double_click"
        | "dom_cua_double_click" => ToolActionKind::BrowserClick,
        "fill"
        | "type"
        | "press"
        | "locator_fill"
        | "locator_type"
        | "locator_press"
        | "locator_select_option"
        | "cua_type"
        | "dom_cua_type"
        | "dom_cua_fill"
        | "playwright_locator_fill"
        | "playwright_locator_type"
        | "playwright_locator_press"
        | "playwright_locator_check"
        | "playwright_locator_uncheck"
        | "select_option" => ToolActionKind::BrowserType,
        "keypress" | "key_press" | "cua_keypress" | "dom_cua_keypress" | "press_key"
        | "keyboard_press" => ToolActionKind::BrowserKey,
        "scroll" | "cua_scroll" | "dom_cua_scroll" | "mouse_wheel" | "wheel" => {
            ToolActionKind::BrowserScroll
        }
        "open"
        | "open_url"
        | "browser_navigate"
        | "goto"
        | "navigate"
        | "navigate_tab_url"
        | "navigate_url"
        | "back"
        | "forward"
        | "reload"
        | "navigate_tab_back"
        | "navigate_tab_forward"
        | "navigate_tab_reload" => ToolActionKind::BrowserNavigate,
        "screenshot"
        | "take_screenshot"
        | "browser_screenshot"
        | "playwright_screenshot"
        | "cua_get_visible_screenshot" => ToolActionKind::BrowserScreenshot,
        "snapshot"
        | "browser_snapshot"
        | "dom_snapshot"
        | "playwright_dom_snapshot"
        | "dom_cua_get_visible_dom"
        | "inspect"
        | "evaluate"
        | "playwright_evaluate"
        | "playwright_locator_inner_text"
        | "playwright_locator_text_content"
        | "playwright_locator_get_attribute"
        | "playwright_locator_is_visible"
        | "playwright_locator_is_enabled"
        | "playwright_locator_count" => ToolActionKind::BrowserInspect,
        "tab_dev_logs" | "console_logs" | "get_console_logs" | "browser_console" | "dev_logs"
        | "read_console_logs" => ToolActionKind::BrowserLogs,
        "list_tabs" | "selected_tab" | "get_tab" | "select_tab" | "switch_tab" | "activate_tab"
        | "next_tab" | "previous_tab" | "create_tab" | "new_tab" | "close_tab" => {
            ToolActionKind::BrowserTab
        }
        "tab_clipboard_read"
        | "tab_clipboard_write"
        | "tab_clipboard_copy"
        | "tab_clipboard_paste"
        | "read_clipboard"
        | "write_clipboard"
        | "copy"
        | "paste" => ToolActionKind::BrowserClipboard,
        "wait"
        | "wait_for"
        | "wait_for_selector"
        | "wait_for_timeout"
        | "wait_for_load_state"
        | "playwright_wait_for_selector"
        | "playwright_wait_for_timeout"
        | "playwright_wait_for_load_state" => ToolActionKind::BrowserWait,
        "set_viewport_size" | "resize_browser" | "get_viewport_size" => {
            ToolActionKind::BrowserViewport
        }
        "get_browser_zoom" | "set_browser_zoom" | "reset_browser_zoom" | "zoom_browser" => {
            ToolActionKind::BrowserZoom
        }
        _ if facts.haystack.contains("click") => ToolActionKind::BrowserClick,
        _ if facts.haystack.contains("type") || facts.haystack.contains("fill") => {
            ToolActionKind::BrowserType
        }
        _ if facts.haystack.contains("keypress") || facts.haystack.contains("press key") => {
            ToolActionKind::BrowserKey
        }
        _ if facts.haystack.contains("scroll") => ToolActionKind::BrowserScroll,
        _ if facts.haystack.contains("screenshot") => ToolActionKind::BrowserScreenshot,
        _ if facts.haystack.contains("dev logs")
            || facts.haystack.contains("console")
            || facts.haystack.contains("log") =>
        {
            ToolActionKind::BrowserLogs
        }
        _ if facts.haystack.contains("clipboard") => ToolActionKind::BrowserClipboard,
        _ if facts.haystack.contains("wait") => ToolActionKind::BrowserWait,
        _ if facts.haystack.contains("zoom") => ToolActionKind::BrowserZoom,
        _ if facts.haystack.contains("viewport") || facts.haystack.contains("resize") => {
            ToolActionKind::BrowserViewport
        }
        _ if facts.haystack.contains("navigate") || facts.haystack.contains("url") => {
            ToolActionKind::BrowserNavigate
        }
        _ => ToolActionKind::BrowserInspect,
    };
    Some(action)
}

fn computer_action(
    transport: ToolTransport,
    facts: &ToolFacts,
    args: &Value,
) -> Option<ToolActionKind> {
    let has_computer_identity = transport == ToolTransport::ComputerBridge
        || facts.haystack.contains("computer")
        || facts.haystack.contains("desktop")
        || facts.haystack.contains("accessibility");
    let has_bridge_operation =
        is_computer_bridge_op(facts.op.as_str()) || is_computer_bridge_op(facts.tool.as_str());
    if transport != ToolTransport::ComputerBridge
        && !has_computer_identity
        && !(has_bridge_operation && has_computer_bridge_args(args))
    {
        return None;
    }
    let raw_op = first_string([Some(facts.op.as_str()), Some(facts.tool.as_str())])
        .unwrap_or_default()
        .to_lowercase();
    let op = canonical_operation_name(
        &raw_op,
        &[
            "mcp__computer_use__",
            "mcp__computer-use__",
            "computer_use_",
            "computer-use_",
            "computer.",
            "computer_",
        ],
    );
    let action = match op.as_str() {
        "click" | "double_click" | "drag" | "cua_click" | "cua_double_click" => {
            ToolActionKind::ComputerClick
        }
        "type" | "type_text" | "set_value" | "select_text" | "cua_type" | "fill" => {
            ToolActionKind::ComputerType
        }
        "scroll" | "cua_scroll" => ToolActionKind::ComputerScroll,
        "key" | "keypress" | "key_press" | "cua_keypress" | "press_key" => {
            ToolActionKind::ComputerKey
        }
        "screenshot" | "get_screenshot" | "cua_get_visible_screenshot" => {
            ToolActionKind::ComputerScreenshot
        }
        "activate_app"
        | "open_app"
        | "select_window"
        | "get_app_state"
        | "list_apps"
        | "perform_secondary_action" => ToolActionKind::ComputerApp,
        _ if facts.haystack.contains("click") => ToolActionKind::ComputerClick,
        _ if facts.haystack.contains("type") => ToolActionKind::ComputerType,
        _ if facts.haystack.contains("scroll") => ToolActionKind::ComputerScroll,
        _ if facts.haystack.contains("screenshot") => ToolActionKind::ComputerScreenshot,
        _ => ToolActionKind::ComputerApp,
    };
    Some(action)
}

fn is_computer_bridge_op(value: &str) -> bool {
    matches!(
        value,
        "click"
            | "double_click"
            | "cua_click"
            | "cua_double_click"
            | "drag"
            | "type"
            | "type_text"
            | "set_value"
            | "select_text"
            | "cua_type"
            | "scroll"
            | "cua_scroll"
            | "key"
            | "keypress"
            | "key_press"
            | "cua_keypress"
            | "press_key"
            | "screenshot"
            | "get_screenshot"
            | "cua_get_visible_screenshot"
            | "activate_app"
            | "open_app"
            | "select_window"
            | "get_app_state"
            | "list_apps"
            | "perform_secondary_action"
    )
}

fn has_computer_bridge_args(args: &Value) -> bool {
    first_string([
        string_at_deep(args, "app").as_deref(),
        string_at_deep(args, "appName").as_deref(),
        string_at_deep(args, "window").as_deref(),
        string_at_deep(args, "element").as_deref(),
        string_at_deep(args, "key").as_deref(),
    ])
    .is_some()
        || coordinate_target(args).is_some()
}

fn terminal_action(
    transport: ToolTransport,
    facts: &ToolFacts,
    args: &Value,
) -> Option<ToolActionKind> {
    if facts.haystack.contains("command execution")
        || facts.haystack.contains("command/exec")
        || facts.haystack.contains("terminal")
        || facts.haystack.contains("process output")
        || string_at_deep(args, "command").is_some()
        || string_at_deep(args, "cmd").is_some()
    {
        if facts.haystack.contains("resize") {
            Some(ToolActionKind::TerminalResize)
        } else if facts.haystack.contains("terminate") || facts.haystack.contains("stop") {
            Some(ToolActionKind::TerminalTerminate)
        } else if facts.haystack.contains("write")
            || facts.haystack.contains("stdin")
            || facts.haystack.contains("append")
        {
            Some(ToolActionKind::TerminalWrite)
        } else if facts.haystack.contains("output") {
            Some(ToolActionKind::TerminalOutput)
        } else {
            Some(ToolActionKind::TerminalRun)
        }
    } else if transport == ToolTransport::Shell || transport == ToolTransport::Process {
        if facts.haystack.contains("write")
            || facts.haystack.contains("stdin")
            || facts.haystack.contains("append")
        {
            Some(ToolActionKind::TerminalWrite)
        } else if facts.haystack.contains("resize") {
            Some(ToolActionKind::TerminalResize)
        } else if facts.haystack.contains("terminate")
            || facts.haystack.contains("kill")
            || facts.haystack.contains("stop")
        {
            Some(ToolActionKind::TerminalTerminate)
        } else {
            Some(ToolActionKind::TerminalRun)
        }
    } else {
        None
    }
}

fn realtime_action(facts: &ToolFacts) -> Option<ToolActionKind> {
    if !facts.haystack.contains("realtime") && !facts.haystack.contains("real time") {
        return None;
    }
    if facts.haystack.contains("list voices") || facts.haystack.contains("listvoices") {
        Some(ToolActionKind::RealtimeListVoices)
    } else if facts.haystack.contains("append audio") || facts.haystack.contains("appendaudio") {
        Some(ToolActionKind::RealtimeAppendAudio)
    } else if facts.haystack.contains("append speech") || facts.haystack.contains("appendspeech") {
        Some(ToolActionKind::RealtimeAppendSpeech)
    } else if facts.haystack.contains("append text") || facts.haystack.contains("appendtext") {
        Some(ToolActionKind::RealtimeAppendText)
    } else if facts.haystack.contains("start") {
        Some(ToolActionKind::RealtimeStart)
    } else if facts.haystack.contains("stop") {
        Some(ToolActionKind::RealtimeStop)
    } else {
        Some(ToolActionKind::RealtimeStart)
    }
}

fn file_action(haystack: &str) -> Option<ToolActionKind> {
    if haystack.contains("fuzzyfilesearch")
        || haystack.contains("file search")
        || haystack.contains("search files")
    {
        Some(ToolActionKind::FileSearch)
    } else if haystack.contains("file change") || haystack.contains("apply patch") {
        Some(ToolActionKind::FilePatch)
    } else if haystack.contains("file read") || haystack.contains("read file") {
        Some(ToolActionKind::FileRead)
    } else if haystack.contains("write file")
        || haystack.contains("edit file")
        || haystack.contains("filesystem")
    {
        Some(ToolActionKind::FileEdit)
    } else {
        None
    }
}

fn github_action(facts: &ToolFacts) -> Option<ToolActionKind> {
    if !facts.haystack.contains("github")
        && facts.server != "github"
        && facts.tool != "gh"
        && !facts.tool.starts_with("gh_")
    {
        return None;
    }
    if facts.haystack.contains("search")
        || facts.haystack.contains("find")
        || facts.haystack.contains("query")
    {
        Some(ToolActionKind::GithubSearch)
    } else if facts.haystack.contains("check")
        || facts.haystack.contains("workflow")
        || facts.haystack.contains("action")
        || facts.haystack.contains("status")
    {
        Some(ToolActionKind::GithubCheck)
    } else if facts.haystack.contains("commit") {
        Some(ToolActionKind::GithubCommit)
    } else if facts.haystack.contains("issue") || facts.haystack.contains("issues") {
        Some(ToolActionKind::GithubIssue)
    } else if facts.haystack.contains("pull request")
        || facts.haystack.contains(" pr ")
        || facts.haystack.contains("pr list")
        || facts.haystack.contains("prs")
        || facts.haystack.contains("pulls")
    {
        Some(ToolActionKind::GithubPullRequest)
    } else {
        Some(ToolActionKind::GithubSearch)
    }
}

fn git_action(facts: &ToolFacts) -> Option<ToolActionKind> {
    if facts.haystack.contains("git commit") || facts.haystack.contains("commit") {
        Some(ToolActionKind::GitCommit)
    } else if facts.haystack.contains("git push") || facts.haystack.contains("push") {
        Some(ToolActionKind::GitPush)
    } else {
        None
    }
}

fn skill_action(facts: &ToolFacts) -> Option<ToolActionKind> {
    if !facts.haystack.contains("skill") && !facts.haystack.contains("skills") {
        return None;
    }
    if facts.haystack.contains("install") {
        Some(ToolActionKind::SkillInstall)
    } else if facts.haystack.contains("config") || facts.haystack.contains("extra roots") {
        Some(ToolActionKind::SkillConfigure)
    } else if facts.haystack.contains("read") {
        Some(ToolActionKind::SkillRead)
    } else {
        Some(ToolActionKind::SkillList)
    }
}

fn plugin_action(facts: &ToolFacts) -> Option<ToolActionKind> {
    if !facts.haystack.contains("plugin") && !facts.haystack.contains("marketplace") {
        return None;
    }
    if facts.haystack.contains("marketplace add") {
        Some(ToolActionKind::PluginMarketplaceAdd)
    } else if facts.haystack.contains("marketplace remove") {
        Some(ToolActionKind::PluginMarketplaceRemove)
    } else if facts.haystack.contains("marketplace upgrade") {
        Some(ToolActionKind::PluginMarketplaceUpgrade)
    } else if facts.haystack.contains("share") {
        Some(ToolActionKind::PluginShare)
    } else if facts.haystack.contains("uninstall") {
        Some(ToolActionKind::PluginUninstall)
    } else if facts.haystack.contains("installed") {
        Some(ToolActionKind::PluginList)
    } else if facts.haystack.contains("install") {
        Some(ToolActionKind::PluginInstall)
    } else if facts.haystack.contains("read") {
        Some(ToolActionKind::PluginRead)
    } else {
        Some(ToolActionKind::PluginList)
    }
}

fn app_action(facts: &ToolFacts) -> Option<ToolActionKind> {
    if !facts.haystack.contains("app/list")
        && !facts.haystack.contains("app list")
        && !facts.haystack.contains("apps")
        && !facts.haystack.contains("app connector")
        && !facts.haystack.contains("remotecontrol")
        && !facts.haystack.contains("collaborationmode")
        && !facts.haystack.contains("collaboration mode")
        && !facts.haystack.contains("collaborationmode.list")
        && !facts.haystack.contains("collaborationmode list")
        && !facts.haystack.contains("environment/add")
        && !facts.haystack.contains("environment_add")
        && !facts.haystack.contains("environment.add")
        && !facts.haystack.contains("environment add")
        && !facts.haystack.contains("memory/reset")
        && !facts.haystack.contains("memory_reset")
        && !facts.haystack.contains("memory.reset")
        && !facts.haystack.contains("memory reset")
    {
        return None;
    }
    if facts.haystack.contains("config")
        || facts.haystack.contains("write")
        || facts.haystack.contains("pairing")
        || facts.haystack.contains("enable")
        || facts.haystack.contains("disable")
        || facts.haystack.contains("revoke")
        || facts.haystack.contains("environment/add")
        || facts.haystack.contains("environment_add")
        || facts.haystack.contains("environment.add")
        || facts.haystack.contains("environment add")
        || facts.haystack.contains("memory/reset")
        || facts.haystack.contains("memory_reset")
        || facts.haystack.contains("memory.reset")
        || facts.haystack.contains("memory reset")
    {
        Some(ToolActionKind::AppConfigure)
    } else {
        Some(ToolActionKind::AppList)
    }
}

fn infer_target(
    surface: ToolSurface,
    action: ToolActionKind,
    input: &ToolNormalizationInput,
    facts: &ToolFacts,
) -> Option<ToolTarget> {
    let args = &input.provider.raw_args;
    match surface {
        ToolSurface::Browser => browser_target(action, args),
        ToolSurface::Computer => computer_target(args),
        ToolSurface::Terminal => first_string([
            string_at_deep(args, "command").as_deref(),
            string_at_deep(args, "cmd").as_deref(),
            string_at_deep(args, "processId").as_deref(),
            string_at_deep(args, "process_id").as_deref(),
            string_at_deep(args, "terminalId").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: match action {
                ToolActionKind::TerminalWrite
                | ToolActionKind::TerminalResize
                | ToolActionKind::TerminalTerminate
                | ToolActionKind::TerminalOutput => ToolTargetKind::Terminal,
                _ => ToolTargetKind::Command,
            },
            label,
        }),
        ToolSurface::Filesystem => file_target(args),
        ToolSurface::Github => github_target(action, args),
        ToolSurface::WebSearch => first_string([
            string_at_deep(args, "query").as_deref(),
            string_at_deep(args, "searchQuery").as_deref(),
            string_at_deep(args, "search_query").as_deref(),
            string_at_deep(args, "text").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Text,
            label,
        }),
        ToolSurface::Image => first_string([
            string_at_deep(args, "prompt").as_deref(),
            string_at_deep(args, "description").as_deref(),
            string_at_deep(args, "url").as_deref(),
            string_at_deep(args, "path").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: if label.starts_with("http://") || label.starts_with("https://") {
                ToolTargetKind::Url
            } else if label.contains('/') || label.contains('\\') {
                ToolTargetKind::File
            } else {
                ToolTargetKind::Text
            },
            label,
        }),
        ToolSurface::Subagent => first_string([
            string_at_deep(args, "agentName").as_deref(),
            string_at_deep(args, "agent_name").as_deref(),
            string_at_deep(args, "name").as_deref(),
            string_at_deep(args, "agentRole").as_deref(),
            string_at_deep(args, "subagentThreadId").as_deref(),
            string_at_deep(args, "subagent_thread_id").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Agent,
            label,
        }),
        ToolSurface::Plan => first_string([
            string_at_deep(args, "targetThreadId").as_deref(),
            string_at_deep(args, "target_thread_id").as_deref(),
            string_at_deep(args, "threadId").as_deref(),
            string_at_deep(args, "thread_id").as_deref(),
            string_at_deep(args, "prompt").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Text,
            label,
        }),
        ToolSurface::Realtime => first_string([
            string_at_deep(args, "voice").as_deref(),
            string_at_deep(args, "voiceId").as_deref(),
            string_at_deep(args, "voice_id").as_deref(),
            string_at_deep(args, "threadId").as_deref(),
            string_at_deep(args, "thread_id").as_deref(),
            string_at_deep(args, "text").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Text,
            label,
        }),
        ToolSurface::Handoff => first_string([
            string_at_deep(args, "targetLocation").as_deref(),
            string_at_deep(args, "target_location").as_deref(),
            string_at_deep(args, "remoteHost").as_deref(),
            string_at_deep(args, "remote_host").as_deref(),
            string_at_deep(args, "branch").as_deref(),
            string_at_deep(args, "targetThreadId").as_deref(),
            string_at_deep(args, "target_thread_id").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Unknown,
            label,
        }),
        ToolSurface::Review => first_string([
            string_at_deep(args, "threadId").as_deref(),
            string_at_deep(args, "thread_id").as_deref(),
            string_at_deep(args, "targetThreadId").as_deref(),
            string_at_deep(args, "target_thread_id").as_deref(),
            string_at_deep(args, "prompt").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Text,
            label,
        }),
        ToolSurface::Skill => first_string([
            string_at_deep(args, "skill").as_deref(),
            string_at_deep(args, "name").as_deref(),
            string_at_deep(args, "query").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Unknown,
            label,
        }),
        ToolSurface::Plugin => first_string([
            string_at_deep(args, "plugin").as_deref(),
            string_at_deep(args, "shareId").as_deref(),
            string_at_deep(args, "share_id").as_deref(),
            string_at_deep(args, "query").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Unknown,
            label,
        }),
        ToolSurface::App => first_string([
            string_at_deep(args, "app").as_deref(),
            string_at_deep(args, "name").as_deref(),
            string_at_deep(args, "query").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Application,
            label,
        }),
        ToolSurface::GenericMcp => Some(ToolTarget {
            kind: ToolTargetKind::Unknown,
            label: if facts.server.is_empty() {
                facts.tool.clone()
            } else if facts.tool.is_empty() {
                facts.server.clone()
            } else {
                format!("{}.{}", facts.server, facts.tool)
            },
        })
        .filter(|target| !target.label.is_empty()),
        _ => None,
    }
}

fn browser_target(action: ToolActionKind, args: &Value) -> Option<ToolTarget> {
    if action == ToolActionKind::BrowserNavigate {
        return first_string([
            string_at_deep(args, "url").as_deref(),
            string_at_deep(args, "href").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Url,
            label,
        });
    }
    if action == ToolActionKind::BrowserViewport {
        let width = number_at_deep(args, "width");
        let height = number_at_deep(args, "height");
        if let (Some(width), Some(height)) = (width, height) {
            return Some(ToolTarget {
                kind: ToolTargetKind::Window,
                label: format!("{width}x{height}"),
            });
        }
    }
    if action == ToolActionKind::BrowserZoom {
        return first_string([
            string_at_deep(args, "zoom").as_deref(),
            string_at_deep(args, "level").as_deref(),
            string_at_deep(args, "scale").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Window,
            label,
        });
    }
    if action == ToolActionKind::BrowserScroll {
        return scroll_target(args).or_else(|| {
            first_string([
                string_at_deep(args, "selector").as_deref(),
                string_at_deep(args, "locator").as_deref(),
                string_at_deep(args, "element").as_deref(),
            ])
            .map(|label| ToolTarget {
                kind: ToolTargetKind::Element,
                label,
            })
        });
    }
    if action == ToolActionKind::BrowserKey {
        return first_string([
            string_at_deep(args, "key").as_deref(),
            string_at_deep(args, "keys").as_deref(),
            string_at_deep(args, "text").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Text,
            label,
        });
    }
    if action == ToolActionKind::BrowserClipboard {
        return first_string([
            string_at_deep(args, "text").as_deref(),
            string_at_deep(args, "value").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Text,
            label,
        })
        .or_else(|| {
            Some(ToolTarget {
                kind: ToolTargetKind::Unknown,
                label: "clipboard".to_string(),
            })
        });
    }
    if action == ToolActionKind::BrowserWait {
        return first_string([
            string_at_deep(args, "selector").as_deref(),
            string_at_deep(args, "locator").as_deref(),
            string_at_deep(args, "url").as_deref(),
            string_at_deep(args, "text").as_deref(),
            string_at_deep(args, "state").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Unknown,
            label,
        });
    }
    first_string([
        string_at_deep(args, "label").as_deref(),
        string_at_deep(args, "ariaLabel").as_deref(),
        string_at_deep(args, "aria_label").as_deref(),
        string_at_deep(args, "placeholder").as_deref(),
        string_at_deep(args, "text").as_deref(),
        string_at_deep(args, "selector").as_deref(),
        string_at_deep(args, "locator").as_deref(),
        string_at_deep(args, "element").as_deref(),
        string_at_deep(args, "node_id").as_deref(),
        string_at_deep(args, "element_index").as_deref(),
    ])
    .map(|label| ToolTarget {
        kind: if label.starts_with('#') || label.starts_with('.') || label.contains('[') {
            ToolTargetKind::Selector
        } else {
            ToolTargetKind::Element
        },
        label,
    })
    .or_else(|| coordinate_target(args))
}

fn computer_target(args: &Value) -> Option<ToolTarget> {
    first_string([
        string_at_deep(args, "app").as_deref(),
        string_at_deep(args, "appName").as_deref(),
        string_at_deep(args, "window").as_deref(),
        string_at_deep(args, "element").as_deref(),
        string_at_deep(args, "element_index").as_deref(),
        string_at_deep(args, "label").as_deref(),
    ])
    .map(|label| ToolTarget {
        kind: ToolTargetKind::Application,
        label,
    })
    .or_else(|| coordinate_target(args))
}

fn file_target(args: &Value) -> Option<ToolTarget> {
    first_string([
        string_at_deep(args, "path").as_deref(),
        string_at_deep(args, "file").as_deref(),
        string_at_deep(args, "filePath").as_deref(),
        string_at_deep(args, "relativePath").as_deref(),
        string_at_deep(args, "query").as_deref(),
        string_at_deep(args, "searchQuery").as_deref(),
        string_at_deep(args, "sessionId").as_deref(),
        string_at_deep(args, "session_id").as_deref(),
    ])
    .map(|label| ToolTarget {
        kind: if args.get("query").is_some()
            || args.get("searchQuery").is_some()
            || args.get("sessionId").is_some()
            || args.get("session_id").is_some()
        {
            ToolTargetKind::Text
        } else {
            ToolTargetKind::File
        },
        label,
    })
}

fn github_target(action: ToolActionKind, args: &Value) -> Option<ToolTarget> {
    let number = first_string([
        string_at_deep(args, "number").as_deref(),
        string_at_deep(args, "issue").as_deref(),
        string_at_deep(args, "pr").as_deref(),
        string_at_deep(args, "pullRequest").as_deref(),
        string_at_deep(args, "pull_request").as_deref(),
    ]);
    number
        .map(|label| ToolTarget {
            kind: match action {
                ToolActionKind::GithubPullRequest => ToolTargetKind::PullRequest,
                ToolActionKind::GithubIssue => ToolTargetKind::Issue,
                _ => ToolTargetKind::Repository,
            },
            label,
        })
        .or_else(|| {
            first_string([
                string_at_deep(args, "repo").as_deref(),
                string_at_deep(args, "repository").as_deref(),
            ])
            .map(|label| ToolTarget {
                kind: ToolTargetKind::Repository,
                label,
            })
        })
}

fn coordinate_target(args: &Value) -> Option<ToolTarget> {
    let x = number_at_deep(args, "x")?;
    let y = number_at_deep(args, "y")?;
    Some(ToolTarget {
        kind: ToolTargetKind::Coordinates,
        label: format!("{x},{y}"),
    })
}

fn scroll_target(args: &Value) -> Option<ToolTarget> {
    let x = number_at_deep(args, "scrollX")
        .or_else(|| number_at_deep(args, "deltaX"))
        .or_else(|| number_at_deep(args, "x"));
    let y = number_at_deep(args, "scrollY")
        .or_else(|| number_at_deep(args, "deltaY"))
        .or_else(|| number_at_deep(args, "y"));
    match (x, y) {
        (Some(x), Some(y)) => Some(ToolTarget {
            kind: ToolTargetKind::Coordinates,
            label: format!("{x},{y}"),
        }),
        (None, Some(y)) => Some(ToolTarget {
            kind: ToolTargetKind::Coordinates,
            label: format!("0,{y}"),
        }),
        (Some(x), None) => Some(ToolTarget {
            kind: ToolTargetKind::Coordinates,
            label: format!("{x},0"),
        }),
        (None, None) => None,
    }
}

fn display_for(
    status: ToolRunStatus,
    surface: ToolSurface,
    action: ToolActionKind,
    target: Option<ToolTarget>,
    input: &ToolNormalizationInput,
    facts: &ToolFacts,
) -> ToolDisplay {
    let verb = verb_for(status, action);
    let noun = noun_for(action);
    let target_text = target.as_ref().map(|target| target.label.as_str());
    let title = match (surface, target_text) {
        (ToolSurface::Browser, Some("clipboard")) if action == ToolActionKind::BrowserClipboard => {
            format!("{verb} Browser clipboard")
        }
        (ToolSurface::Browser, None) if action == ToolActionKind::BrowserClipboard => {
            format!("{verb} Browser clipboard")
        }
        (ToolSurface::Browser, Some(target)) => format!("{verb} {target} in Browser"),
        (ToolSurface::Browser, None) => format!("{verb} Browser {noun}"),
        (ToolSurface::Computer, Some(target)) => format!("{verb} {target} on Computer"),
        (ToolSurface::Computer, None) => format!("{verb} Computer {noun}"),
        (ToolSurface::Terminal, Some(target)) => match action {
            ToolActionKind::TerminalRun => format!("{verb} `{}`", truncate(target, 96)),
            ToolActionKind::TerminalOutput => {
                format!("{verb} terminal output from {}", truncate(target, 96))
            }
            ToolActionKind::TerminalWrite
            | ToolActionKind::TerminalResize
            | ToolActionKind::TerminalTerminate => {
                format!("{verb} terminal {}", truncate(target, 96))
            }
            _ => format!("{verb} terminal {}", truncate(target, 96)),
        },
        (ToolSurface::Terminal, None) => match action {
            ToolActionKind::TerminalOutput => format!("{verb} terminal output"),
            ToolActionKind::TerminalWrite => format!("{verb} terminal stdin"),
            ToolActionKind::TerminalResize => format!("{verb} terminal"),
            ToolActionKind::TerminalTerminate => format!("{verb} terminal"),
            _ => format!("{verb} terminal command"),
        },
        (ToolSurface::Filesystem, Some(target)) => format!("{verb} {target}"),
        (ToolSurface::Filesystem, None) => format!("{verb} file"),
        (ToolSurface::Github, Some(target)) => format!("{verb} GitHub {noun} {target}"),
        (ToolSurface::Github, None) => format!("{verb} GitHub {noun}"),
        (ToolSurface::Subagent, Some(target)) => format!("{verb} subagent {target}"),
        (ToolSurface::Subagent, None) => format!("{verb} subagent"),
        (ToolSurface::Plan, Some(target)) => match action {
            ToolActionKind::PlanContinue => format!("{verb} plan in {target}"),
            ToolActionKind::PlanFork => format!("{verb} plan into {target}"),
            ToolActionKind::PlanSideImplementation => {
                format!("{verb} side implementation {target}")
            }
            _ => format!("{verb} plan {target}"),
        },
        (ToolSurface::Plan, None) => match action {
            ToolActionKind::PlanSideImplementation => format!("{verb} side implementation"),
            _ => format!("{verb} plan"),
        },
        (ToolSurface::Realtime, Some(target)) => format!("{verb} {noun} {target}"),
        (ToolSurface::Realtime, None) => format!("{verb} {noun}"),
        (ToolSurface::Handoff, Some(target)) => format!("{verb} to {target}"),
        (ToolSurface::Handoff, None) => format!("{verb} handoff"),
        (ToolSurface::Review, Some(target)) => format!("{verb} review for {target}"),
        (ToolSurface::Review, None) => format!("{verb} review"),
        (ToolSurface::WebSearch, Some(target)) => format!("{verb} web for {target}"),
        (ToolSurface::WebSearch, None) => format!("{verb} web search"),
        (ToolSurface::Image, Some(target)) => format!("{verb} image {target}"),
        (ToolSurface::Image, None) => format!("{verb} image"),
        (ToolSurface::Skill, Some(target)) => format!("{verb} skill {target}"),
        (ToolSurface::Skill, None) => format!("{verb} skills"),
        (ToolSurface::Plugin, Some(target)) => format!("{verb} plugin {target}"),
        (ToolSurface::Plugin, None) => format!("{verb} plugins"),
        (ToolSurface::App, Some(target)) => format!("{verb} app {target}"),
        (ToolSurface::App, None) => format!("{verb} apps"),
        (ToolSurface::GenericMcp, Some(target)) => format!("{verb} {target} tool"),
        (ToolSurface::GenericMcp, None) => format!("{verb} external tool"),
        _ => format!(
            "{verb} {}",
            if facts.tool.is_empty() {
                "tool"
            } else {
                facts.tool.as_str()
            }
        ),
    };
    let technical_metadata = technical_metadata(input, facts, surface, action, target.as_ref());

    ToolDisplay {
        title,
        summary: summary_for(input, facts),
        target,
        status,
        icon_key: icon_for(surface, action).to_string(),
        technical_metadata,
    }
}

fn verb_for(status: ToolRunStatus, action: ToolActionKind) -> &'static str {
    match status {
        ToolRunStatus::Started | ToolRunStatus::Updated | ToolRunStatus::ApprovalRequested => {
            match action {
                ToolActionKind::BrowserClick | ToolActionKind::ComputerClick => "Clicking",
                ToolActionKind::BrowserType | ToolActionKind::ComputerType => "Typing into",
                ToolActionKind::BrowserKey => "Pressing key",
                ToolActionKind::ComputerKey => "Pressing key in",
                ToolActionKind::BrowserNavigate => "Opening",
                ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot => {
                    "Capturing"
                }
                ToolActionKind::BrowserInspect => "Inspecting",
                ToolActionKind::BrowserTab => "Switching",
                ToolActionKind::BrowserScroll => "Scrolling",
                ToolActionKind::BrowserClipboard => "Using",
                ToolActionKind::BrowserWait => "Waiting for",
                ToolActionKind::BrowserViewport => "Resizing",
                ToolActionKind::BrowserZoom => "Changing zoom for",
                ToolActionKind::BrowserConsole | ToolActionKind::BrowserLogs => "Reading",
                ToolActionKind::TerminalRun => "Running",
                ToolActionKind::TerminalWrite => "Writing to",
                ToolActionKind::TerminalResize => "Resizing",
                ToolActionKind::TerminalTerminate => "Stopping",
                ToolActionKind::TerminalOutput => "Reading",
                ToolActionKind::FilePatch | ToolActionKind::FileEdit => "Editing",
                ToolActionKind::FileSearch => "Searching",
                ToolActionKind::FileRead => "Reading",
                ToolActionKind::GithubIssue
                | ToolActionKind::GithubPullRequest
                | ToolActionKind::GithubCheck
                | ToolActionKind::GithubCommit => "Reading",
                ToolActionKind::GithubSearch | ToolActionKind::WebSearch => "Searching",
                ToolActionKind::ImageView => "Viewing",
                ToolActionKind::ImageGenerate => "Generating",
                ToolActionKind::SubagentSpawn => "Starting",
                ToolActionKind::SubagentSteer => "Steering",
                ToolActionKind::SubagentStop => "Stopping",
                ToolActionKind::SubagentClose => "Closing",
                ToolActionKind::PlanContinue => "Continuing",
                ToolActionKind::PlanFork => "Forking",
                ToolActionKind::PlanSideImplementation => "Starting",
                ToolActionKind::RealtimeStart => "Starting",
                ToolActionKind::RealtimeStop => "Stopping",
                ToolActionKind::RealtimeAppendText
                | ToolActionKind::RealtimeAppendSpeech
                | ToolActionKind::RealtimeAppendAudio => "Appending",
                ToolActionKind::RealtimeListVoices => "Listing",
                ToolActionKind::HandoffAgent | ToolActionKind::HandoffLocation => "Handing off",
                ToolActionKind::ReviewStart => "Starting",
                ToolActionKind::SkillList
                | ToolActionKind::PluginList
                | ToolActionKind::AppList => "Listing",
                ToolActionKind::SkillRead | ToolActionKind::PluginRead => "Reading",
                ToolActionKind::SkillInstall | ToolActionKind::PluginInstall => "Installing",
                ToolActionKind::SkillConfigure | ToolActionKind::AppConfigure => "Configuring",
                ToolActionKind::PluginUninstall => "Uninstalling",
                ToolActionKind::PluginShare => "Sharing",
                ToolActionKind::PluginMarketplaceAdd => "Adding",
                ToolActionKind::PluginMarketplaceRemove => "Removing",
                ToolActionKind::PluginMarketplaceUpgrade => "Upgrading",
                _ => "Running",
            }
        }
        ToolRunStatus::Completed => match action {
            ToolActionKind::BrowserClick | ToolActionKind::ComputerClick => "Clicked",
            ToolActionKind::BrowserType | ToolActionKind::ComputerType => "Typed into",
            ToolActionKind::BrowserKey => "Pressed key",
            ToolActionKind::ComputerKey => "Pressed key in",
            ToolActionKind::BrowserNavigate => "Opened",
            ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot => "Captured",
            ToolActionKind::BrowserInspect => "Inspected",
            ToolActionKind::BrowserTab => "Switched",
            ToolActionKind::BrowserScroll => "Scrolled",
            ToolActionKind::BrowserClipboard => "Used",
            ToolActionKind::BrowserWait => "Waited for",
            ToolActionKind::BrowserViewport => "Resized",
            ToolActionKind::BrowserZoom => "Changed zoom for",
            ToolActionKind::BrowserConsole | ToolActionKind::BrowserLogs => "Read",
            ToolActionKind::TerminalRun => "Ran",
            ToolActionKind::TerminalWrite => "Wrote to",
            ToolActionKind::TerminalResize => "Resized",
            ToolActionKind::TerminalTerminate => "Stopped",
            ToolActionKind::TerminalOutput => "Read",
            ToolActionKind::FilePatch | ToolActionKind::FileEdit => "Edited",
            ToolActionKind::FileSearch => "Searched",
            ToolActionKind::FileRead => "Read",
            ToolActionKind::GithubIssue
            | ToolActionKind::GithubPullRequest
            | ToolActionKind::GithubCheck
            | ToolActionKind::GithubCommit => "Read",
            ToolActionKind::GithubSearch | ToolActionKind::WebSearch => "Searched",
            ToolActionKind::ImageView => "Viewed",
            ToolActionKind::ImageGenerate => "Generated",
            ToolActionKind::SubagentSpawn => "Started",
            ToolActionKind::SubagentSteer => "Steered",
            ToolActionKind::SubagentStop => "Stopped",
            ToolActionKind::SubagentClose => "Closed",
            ToolActionKind::PlanContinue => "Continued",
            ToolActionKind::PlanFork => "Forked",
            ToolActionKind::PlanSideImplementation => "Started",
            ToolActionKind::RealtimeStart => "Started",
            ToolActionKind::RealtimeStop => "Stopped",
            ToolActionKind::RealtimeAppendText
            | ToolActionKind::RealtimeAppendSpeech
            | ToolActionKind::RealtimeAppendAudio => "Appended",
            ToolActionKind::RealtimeListVoices => "Listed",
            ToolActionKind::HandoffAgent | ToolActionKind::HandoffLocation => "Handed off",
            ToolActionKind::ReviewStart => "Started",
            ToolActionKind::SkillList | ToolActionKind::PluginList | ToolActionKind::AppList => {
                "Listed"
            }
            ToolActionKind::SkillRead | ToolActionKind::PluginRead => "Read",
            ToolActionKind::SkillInstall | ToolActionKind::PluginInstall => "Installed",
            ToolActionKind::SkillConfigure | ToolActionKind::AppConfigure => "Configured",
            ToolActionKind::PluginUninstall => "Uninstalled",
            ToolActionKind::PluginShare => "Shared",
            ToolActionKind::PluginMarketplaceAdd => "Added",
            ToolActionKind::PluginMarketplaceRemove => "Removed",
            ToolActionKind::PluginMarketplaceUpgrade => "Upgraded",
            _ => "Ran",
        },
        ToolRunStatus::Failed => "Failed",
    }
}

fn noun_for(action: ToolActionKind) -> &'static str {
    match action {
        ToolActionKind::BrowserClick | ToolActionKind::ComputerClick => "button",
        ToolActionKind::BrowserType | ToolActionKind::ComputerType => "field",
        ToolActionKind::BrowserNavigate => "page",
        ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot => "screenshot",
        ToolActionKind::BrowserInspect => "page",
        ToolActionKind::BrowserLogs => "console logs",
        ToolActionKind::BrowserConsole => "console logs",
        ToolActionKind::BrowserTab => "tab",
        ToolActionKind::BrowserScroll => "page",
        ToolActionKind::BrowserKey => "key",
        ToolActionKind::BrowserClipboard => "clipboard",
        ToolActionKind::BrowserWait => "page",
        ToolActionKind::BrowserViewport => "viewport",
        ToolActionKind::BrowserZoom => "zoom",
        ToolActionKind::TerminalRun => "command",
        ToolActionKind::TerminalWrite
        | ToolActionKind::TerminalResize
        | ToolActionKind::TerminalTerminate
        | ToolActionKind::TerminalOutput => "terminal",
        ToolActionKind::GithubIssue => "issue",
        ToolActionKind::GithubPullRequest => "pull request",
        ToolActionKind::GithubCheck => "checks",
        ToolActionKind::GithubCommit => "commit",
        ToolActionKind::GithubSearch => "search",
        ToolActionKind::FileSearch => "files",
        ToolActionKind::SkillList => "skills",
        ToolActionKind::SkillRead
        | ToolActionKind::SkillInstall
        | ToolActionKind::SkillConfigure => "skill",
        ToolActionKind::PluginList => "plugins",
        ToolActionKind::PluginRead
        | ToolActionKind::PluginInstall
        | ToolActionKind::PluginUninstall
        | ToolActionKind::PluginShare
        | ToolActionKind::PluginMarketplaceAdd
        | ToolActionKind::PluginMarketplaceRemove
        | ToolActionKind::PluginMarketplaceUpgrade => "plugin",
        ToolActionKind::AppList => "apps",
        ToolActionKind::AppConfigure => "app",
        ToolActionKind::PlanContinue
        | ToolActionKind::PlanFork
        | ToolActionKind::PlanSideImplementation => "plan",
        ToolActionKind::RealtimeStart | ToolActionKind::RealtimeStop => "realtime session",
        ToolActionKind::RealtimeAppendText | ToolActionKind::RealtimeAppendSpeech => {
            "realtime input"
        }
        ToolActionKind::RealtimeAppendAudio => "realtime audio",
        ToolActionKind::RealtimeListVoices => "realtime voices",
        ToolActionKind::HandoffAgent | ToolActionKind::HandoffLocation => "handoff",
        ToolActionKind::ReviewStart => "review",
        _ => "tool",
    }
}

fn technical_metadata(
    input: &ToolNormalizationInput,
    facts: &ToolFacts,
    surface: ToolSurface,
    action: ToolActionKind,
    target: Option<&ToolTarget>,
) -> Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert(
        "transport".to_string(),
        serde_json::to_value(input.transport).unwrap_or(Value::Null),
    );
    if let Some(item_type) = input.item_type.as_deref().filter(|value| !value.is_empty()) {
        metadata.insert(
            "item_type".to_string(),
            Value::String(item_type.to_string()),
        );
    }
    if let Some(method) = input
        .provider
        .method
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        metadata.insert("method".to_string(), Value::String(method.to_string()));
    }
    if !facts.server.is_empty() {
        metadata.insert(
            "server_name".to_string(),
            Value::String(facts.server.clone()),
        );
    }
    if !facts.tool.is_empty() {
        metadata.insert("tool_name".to_string(), Value::String(facts.tool.clone()));
    }
    if !facts.op.is_empty() {
        metadata.insert("operation".to_string(), Value::String(facts.op.clone()));
    }
    if let Some(asset) = renderable_asset_metadata(input, surface, action, target) {
        metadata.insert("renderable_asset".to_string(), asset);
    }
    Value::Object(metadata)
}

fn renderable_asset_metadata(
    input: &ToolNormalizationInput,
    surface: ToolSurface,
    action: ToolActionKind,
    target: Option<&ToolTarget>,
) -> Option<Value> {
    let is_image_action = surface == ToolSurface::Image
        || matches!(
            action,
            ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot
        );
    if !is_image_action {
        return None;
    }

    let source = image_source(input).or_else(|| {
        target.and_then(|target| match target.kind {
            ToolTargetKind::Url | ToolTargetKind::File => Some(target.label.clone()),
            _ => None,
        })
    })?;
    let source_kind = renderable_source_kind(&source);
    let github_proxy = is_github_proxyable_image_source(&source);
    Some(serde_json::json!({
        "kind": "image",
        "source": source,
        "source_kind": source_kind,
        "proxy_required": github_proxy,
        "proxy_method": if github_proxy { Some("github.image.proxy") } else { None::<&str> },
    }))
}

fn image_source(input: &ToolNormalizationInput) -> Option<String> {
    first_string([
        string_at_deep(&input.provider.raw_result, "url").as_deref(),
        string_at_deep(&input.provider.raw_result, "imageUrl").as_deref(),
        string_at_deep(&input.provider.raw_result, "image_url").as_deref(),
        string_at_deep(&input.provider.raw_result, "src").as_deref(),
        string_at_deep(&input.provider.raw_result, "path").as_deref(),
        string_at_deep(&input.provider.raw_result, "dataUrl").as_deref(),
        string_at_deep(&input.provider.raw_result, "data_url").as_deref(),
        nested_string_at(
            &input.provider.raw_result,
            "/image",
            &["url", "src", "path"],
        )
        .as_deref(),
        string_at_deep(&input.provider.raw_args, "url").as_deref(),
        string_at_deep(&input.provider.raw_args, "imageUrl").as_deref(),
        string_at_deep(&input.provider.raw_args, "image_url").as_deref(),
        string_at_deep(&input.provider.raw_args, "src").as_deref(),
        string_at_deep(&input.provider.raw_args, "path").as_deref(),
        string_at_deep(&input.provider.raw_args, "dataUrl").as_deref(),
        string_at_deep(&input.provider.raw_args, "data_url").as_deref(),
        nested_string_at(&input.provider.raw_args, "/image", &["url", "src", "path"]).as_deref(),
    ])
}

fn renderable_source_kind(source: &str) -> &'static str {
    let lower = source.to_ascii_lowercase();
    if lower.starts_with("data:image/") {
        "data_url"
    } else if lower.starts_with("http://") || lower.starts_with("https://") {
        "url"
    } else if lower.contains("://") {
        "uri"
    } else {
        "file"
    }
}

fn is_github_proxyable_image_source(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    let Some(path) = lower.split(['?', '#']).next() else {
        return false;
    };
    let github_host = path.contains("githubusercontent.com/")
        || path.contains("github.com/")
        || path.contains("githubassets.com/");
    let image_like = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]
        .iter()
        .any(|extension| path.ends_with(extension) || path.contains(&format!("{extension}/")));
    github_host && image_like
}

fn icon_for(surface: ToolSurface, action: ToolActionKind) -> &'static str {
    match surface {
        ToolSurface::Browser => "browser",
        ToolSurface::Computer => "monitor",
        ToolSurface::Terminal => "terminal",
        ToolSurface::Filesystem => "file",
        ToolSurface::Git => "git-branch",
        ToolSurface::Github => "github",
        ToolSurface::WebSearch => "search",
        ToolSurface::Image => "image",
        ToolSurface::Subagent => "bot",
        ToolSurface::Plan => "list-checks",
        ToolSurface::Realtime => "waveform",
        ToolSurface::Handoff => "send",
        ToolSurface::Review => "search-check",
        ToolSurface::Skill => "sparkles",
        ToolSurface::Plugin => "plug",
        ToolSurface::App => "app-window",
        ToolSurface::GenericMcp => "plug",
        _ => match action {
            ToolActionKind::ToolRun => "tool",
            _ => "activity",
        },
    }
}

fn summary_for(input: &ToolNormalizationInput, facts: &ToolFacts) -> Option<String> {
    let mut parts = Vec::new();
    if !facts.op.is_empty() {
        parts.push(format!("operation: {}", facts.op));
    }
    if let Some(server) = input
        .provider
        .server_name
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("server: {server}"));
    }
    if let Some(tool) = input
        .provider
        .tool_name
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        parts.push(format!("tool: {tool}"));
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

fn string_at(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => map.get(key).and_then(value_to_string),
        _ => None,
    }
}

fn string_at_deep(value: &Value, key: &str) -> Option<String> {
    string_at(value, key).or_else(|| {
        ["input", "arguments", "args", "parameters", "params"]
            .into_iter()
            .filter_map(|nested| value.get(nested))
            .find_map(|nested| string_at_deep(nested, key))
    })
}

fn value_to_string(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn number_at(value: &Value, key: &str) -> Option<i64> {
    match value {
        Value::Object(map) => map.get(key).and_then(|value| match value {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.parse().ok(),
            _ => None,
        }),
        _ => None,
    }
}

fn number_at_deep(value: &Value, key: &str) -> Option<i64> {
    number_at(value, key).or_else(|| {
        ["input", "arguments", "args", "parameters", "params"]
            .into_iter()
            .filter_map(|nested| value.get(nested))
            .find_map(|nested| number_at_deep(nested, key))
    })
}

fn spaced_words(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 8);
    let mut previous_lower_or_digit = false;
    for character in value.chars() {
        if character.is_ascii_uppercase() && previous_lower_or_digit {
            output.push(' ');
        }
        output.push(character);
        previous_lower_or_digit = character.is_ascii_lowercase() || character.is_ascii_digit();
    }
    output
}

fn first_string<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn nested_string_at(value: &Value, pointer: &str, keys: &[&str]) -> Option<String> {
    value
        .pointer(pointer)
        .and_then(|nested| keys.iter().find_map(|key| string_at(nested, key)))
}

fn tool_item_type_for_server_request(kind: ServerRequestKind) -> Option<&'static str> {
    match kind {
        ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
            Some("commandExecution")
        }
        ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
            Some("fileChange")
        }
        ServerRequestKind::McpElicitation | ServerRequestKind::ToolUserInput => Some("mcpToolCall"),
        ServerRequestKind::DynamicToolCall => Some("dynamicToolCall"),
        ServerRequestKind::Unknown
        | ServerRequestKind::PermissionApproval
        | ServerRequestKind::AccountTokenRefresh
        | ServerRequestKind::Attestation => None,
    }
}

fn tool_name_for_server_request(kind: ServerRequestKind, params: &Value) -> Option<String> {
    string_at_deep(params, "toolName")
        .or_else(|| string_at_deep(params, "tool_name"))
        .or_else(|| string_at_deep(params, "tool"))
        .or_else(|| string_at_deep(params, "function"))
        .or_else(|| string_at_deep(params, "name"))
        .or_else(|| match kind {
            ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
                Some("shell".to_string())
            }
            ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                Some("apply_patch".to_string())
            }
            ServerRequestKind::McpElicitation | ServerRequestKind::ToolUserInput => {
                Some("mcp".to_string())
            }
            _ => None,
        })
}

fn operation_for_server_request(kind: ServerRequestKind, params: &Value) -> Option<String> {
    string_at_deep(params, "operation")
        .or_else(|| string_at_deep(params, "action"))
        .or_else(|| string_at_deep(params, "action_type"))
        .or_else(|| match kind {
            ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
                Some("run".to_string())
            }
            ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                Some("apply_patch".to_string())
            }
            ServerRequestKind::McpElicitation => Some("elicitation".to_string()),
            ServerRequestKind::ToolUserInput => Some("user_input".to_string()),
            _ => None,
        })
}

fn args_for_server_request(params: &Value) -> Value {
    params
        .get("input")
        .or_else(|| params.get("arguments"))
        .or_else(|| params.get("args"))
        .cloned()
        .unwrap_or_else(|| params.clone())
}

fn transport_for_server_request(
    kind: ServerRequestKind,
    provider: &ProviderToolMetadata,
) -> ToolTransport {
    let label = [
        provider.tool_name.as_deref().unwrap_or_default(),
        provider.server_name.as_deref().unwrap_or_default(),
        provider.operation.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .to_lowercase();
    if label.contains("ace_browser") || label.contains("browser") || label.contains("playwright") {
        ToolTransport::BrowserBridge
    } else if label.contains("computer") || label.contains("desktop") {
        ToolTransport::ComputerBridge
    } else {
        match kind {
            ServerRequestKind::CommandApproval | ServerRequestKind::ExecApproval => {
                ToolTransport::Shell
            }
            ServerRequestKind::FileChangeApproval | ServerRequestKind::ApplyPatchApproval => {
                ToolTransport::Filesystem
            }
            ServerRequestKind::McpElicitation | ServerRequestKind::ToolUserInput => {
                ToolTransport::Mcp
            }
            ServerRequestKind::DynamicToolCall => ToolTransport::DynamicTool,
            _ => ToolTransport::CodexBuiltin,
        }
    }
}

fn is_tool_item_type(item_type: &str) -> bool {
    matches!(
        item_type,
        "commandExecution"
            | "fileChange"
            | "mcpToolCall"
            | "dynamicToolCall"
            | "collabAgentToolCall"
            | "subAgentActivity"
            | "webSearch"
            | "imageView"
            | "imageGeneration"
    )
}

fn transport_for_item(item_type: &str, provider: &ProviderToolMetadata) -> ToolTransport {
    let label = [
        item_type,
        provider.tool_name.as_deref().unwrap_or_default(),
        provider.server_name.as_deref().unwrap_or_default(),
        provider.operation.as_deref().unwrap_or_default(),
    ]
    .join(" ")
    .to_lowercase();
    if label.contains("ace_browser") || label.contains("browser") {
        ToolTransport::BrowserBridge
    } else if label.contains("computer") {
        ToolTransport::ComputerBridge
    } else {
        match item_type {
            "commandExecution" => ToolTransport::Shell,
            "fileChange" => ToolTransport::Filesystem,
            "mcpToolCall" => ToolTransport::Mcp,
            "dynamicToolCall" => ToolTransport::DynamicTool,
            _ => ToolTransport::CodexBuiltin,
        }
    }
}

fn tool_name_for_item(item_type: &str, item: &Value) -> Option<String> {
    string_at_deep(item, "toolName")
        .or_else(|| string_at_deep(item, "tool_name"))
        .or_else(|| string_at_deep(item, "tool"))
        .or_else(|| string_at_deep(item, "function"))
        .or_else(|| string_at_deep(item, "name"))
        .or_else(|| {
            if item_type == "commandExecution" {
                Some("shell".to_string())
            } else if item_type == "fileChange" {
                Some("apply_patch".to_string())
            } else if item_type == "webSearch" {
                Some("web_search".to_string())
            } else if item_type == "imageView" {
                Some("image_view".to_string())
            } else if item_type == "imageGeneration" {
                Some("image_generation".to_string())
            } else {
                None
            }
        })
}

fn operation_for_item(item_type: &str, item: &Value) -> Option<String> {
    string_at_deep(item, "operation")
        .or_else(|| string_at_deep(item, "action"))
        .or_else(|| string_at_deep(item, "action_type"))
        .or_else(|| {
            if item_type == "commandExecution" {
                Some("run".to_string())
            } else if item_type == "webSearch" {
                Some("search".to_string())
            } else if item_type == "imageView" {
                Some("view".to_string())
            } else if item_type == "imageGeneration" {
                Some("generate".to_string())
            } else {
                None
            }
        })
}

fn args_for_item(item: &Value) -> Value {
    item.get("input")
        .or_else(|| item.get("arguments"))
        .or_else(|| item.get("args"))
        .cloned()
        .unwrap_or_else(|| item.clone())
}

fn item_type_from_method(method: &str) -> Option<String> {
    if method.contains("commandExecution") || method.starts_with("command/exec") {
        Some("commandExecution".to_string())
    } else if method.contains("agentMessage") {
        Some("agentMessage".to_string())
    } else if method.contains("userMessage") {
        Some("userMessage".to_string())
    } else if method.contains("hookPrompt") {
        Some("hookPrompt".to_string())
    } else if method.contains("plan") {
        Some("plan".to_string())
    } else if method.contains("reasoning") {
        Some("reasoning".to_string())
    } else if method.contains("fileChange") {
        Some("fileChange".to_string())
    } else if method.contains("mcpToolCall") {
        Some("mcpToolCall".to_string())
    } else if method.contains("dynamicToolCall") {
        Some("dynamicToolCall".to_string())
    } else if method.contains("collabAgentToolCall") {
        Some("collabAgentToolCall".to_string())
    } else if method.contains("subAgentActivity") {
        Some("subAgentActivity".to_string())
    } else if method.contains("webSearch") {
        Some("webSearch".to_string())
    } else if method.contains("imageView") {
        Some("imageView".to_string())
    } else if method.contains("imageGeneration") {
        Some("imageGeneration".to_string())
    } else {
        None
    }
}

fn canonical_operation_name(value: &str, prefixes: &[&str]) -> String {
    let mut normalized = value.trim().to_lowercase();
    for separator in ["::", "__", "/", "."] {
        if let Some((_, tail)) = normalized.rsplit_once(separator) {
            normalized = tail.to_string();
            break;
        }
    }
    for prefix in prefixes {
        if let Some(stripped) = normalized.strip_prefix(prefix) {
            return stripped.to_string();
        }
    }
    normalized
}

fn truncate(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut truncated = value
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    truncated.push_str("...");
    truncated
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(
        transport: ToolTransport,
        item_type: &str,
        tool: &str,
        op: &str,
        args: Value,
    ) -> ToolNormalizationInput {
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.tool_name = Some(tool.to_string());
        provider.operation = Some(op.to_string());
        provider.raw_args = args.clone();
        provider.raw_payload = json!({ "args": args });
        ToolNormalizationInput {
            transport,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some(item_type.to_string()),
        }
    }

    #[test]
    fn browser_click_is_not_generic_mcp() {
        let call = normalize_tool_call(input(
            ToolTransport::Mcp,
            "mcpToolCall",
            "ace_browser",
            "cua_click",
            json!({ "operation": "cua_click", "label": "Submit" }),
        ));

        assert_eq!(call.surface, ToolSurface::Browser);
        assert_eq!(call.action, ToolActionKind::BrowserClick);
        assert_eq!(call.display.title, "Clicked Submit in Browser");
        assert_ne!(call.display.title, "MCP tool");
        assert_eq!(call.provider.raw_args["label"], "Submit");
    }

    #[test]
    fn browser_type_and_navigation_have_distinct_labels() {
        let typed = normalize_tool_call(input(
            ToolTransport::BrowserBridge,
            "dynamicToolCall",
            "ace_browser",
            "playwright_locator_fill",
            json!({ "operation": "playwright_locator_fill", "selector": "#email" }),
        ));
        assert_eq!(typed.action, ToolActionKind::BrowserType);
        assert_eq!(typed.display.title, "Typed into #email in Browser");

        let opened = normalize_tool_call(input(
            ToolTransport::BrowserBridge,
            "dynamicToolCall",
            "ace_browser",
            "navigate_tab_url",
            json!({ "operation": "navigate_tab_url", "url": "http://localhost:3000" }),
        ));
        assert_eq!(opened.action, ToolActionKind::BrowserNavigate);
        assert_eq!(
            opened.display.title,
            "Opened http://localhost:3000 in Browser"
        );
    }

    #[test]
    fn nested_browser_bridge_arguments_keep_semantic_display() {
        let clicked = normalize_tool_call(input(
            ToolTransport::Mcp,
            "mcpToolCall",
            "playwright_locator_click",
            "",
            json!({
                "arguments": {
                    "selector": "button[data-testid=save]",
                    "operation": "playwright_locator_click"
                }
            }),
        ));
        assert_eq!(clicked.surface, ToolSurface::Browser);
        assert_eq!(clicked.action, ToolActionKind::BrowserClick);
        assert_eq!(
            clicked.display.title,
            "Clicked button[data-testid=save] in Browser"
        );

        let typed = normalize_tool_call(input(
            ToolTransport::Mcp,
            "mcpToolCall",
            "dom_cua_type",
            "",
            json!({
                "parameters": {
                    "text": "hello@example.com"
                }
            }),
        ));
        assert_eq!(typed.surface, ToolSurface::Browser);
        assert_eq!(typed.action, ToolActionKind::BrowserType);
        assert_eq!(
            typed.display.title,
            "Typed into hello@example.com in Browser"
        );
    }

    #[test]
    fn browser_bridge_tool_name_variants_do_not_render_as_generic_mcp() {
        let cases = [
            (
                "mcp__browser__click",
                json!({ "selector": "button.save" }),
                ToolActionKind::BrowserClick,
                "Clicked button.save in Browser",
            ),
            (
                "browser_navigate",
                json!({ "url": "https://example.com/docs" }),
                ToolActionKind::BrowserNavigate,
                "Opened https://example.com/docs in Browser",
            ),
            (
                "browser.snapshot",
                json!({}),
                ToolActionKind::BrowserInspect,
                "Inspected Browser page",
            ),
            (
                "browser_take_screenshot",
                json!({}),
                ToolActionKind::BrowserScreenshot,
                "Captured Browser screenshot",
            ),
            (
                "mcp__browser__get_console_logs",
                json!({}),
                ToolActionKind::BrowserLogs,
                "Read Browser console logs",
            ),
        ];

        for (tool, args, action, title) in cases {
            let call =
                normalize_tool_call(input(ToolTransport::Mcp, "mcpToolCall", tool, "", args));
            assert_eq!(call.surface, ToolSurface::Browser);
            assert_eq!(call.action, action);
            assert_eq!(call.display.title, title);
            assert!(!call.display.title.contains("MCP"));
        }
    }

    #[test]
    fn browser_inspection_screenshot_console_viewport_and_zoom_are_distinct() {
        let cases = [
            (
                "playwright_screenshot",
                ToolActionKind::BrowserScreenshot,
                "Captured Browser screenshot",
            ),
            (
                "playwright_dom_snapshot",
                ToolActionKind::BrowserInspect,
                "Inspected Browser page",
            ),
            (
                "tab_dev_logs",
                ToolActionKind::BrowserLogs,
                "Read Browser console logs",
            ),
            (
                "resize_browser",
                ToolActionKind::BrowserViewport,
                "Resized Browser viewport",
            ),
            (
                "set_browser_zoom",
                ToolActionKind::BrowserZoom,
                "Changed zoom for Browser zoom",
            ),
        ];
        for (op, action, title) in cases {
            let call = normalize_tool_call(input(
                ToolTransport::BrowserBridge,
                "dynamicToolCall",
                "ace_browser",
                op,
                json!({ "operation": op }),
            ));
            assert_eq!(call.action, action);
            assert_eq!(call.display.title, title);
        }
    }

    #[test]
    fn browser_cua_scroll_key_clipboard_and_wait_are_distinct() {
        let cases = [
            (
                "dom_cua_scroll",
                json!({ "operation": "dom_cua_scroll", "scrollY": 600 }),
                ToolActionKind::BrowserScroll,
                "Scrolled 0,600 in Browser",
            ),
            (
                "dom_cua_keypress",
                json!({ "operation": "dom_cua_keypress", "key": "Escape" }),
                ToolActionKind::BrowserKey,
                "Pressed key Escape in Browser",
            ),
            (
                "tab_clipboard_read",
                json!({ "operation": "tab_clipboard_read" }),
                ToolActionKind::BrowserClipboard,
                "Used Browser clipboard",
            ),
            (
                "wait_for_selector",
                json!({ "operation": "wait_for_selector", "selector": "#ready" }),
                ToolActionKind::BrowserWait,
                "Waited for #ready in Browser",
            ),
        ];

        for (op, args, action, title) in cases {
            let call = normalize_tool_call(input(
                ToolTransport::BrowserBridge,
                "dynamicToolCall",
                "ace_browser",
                op,
                args,
            ));
            assert_eq!(call.surface, ToolSurface::Browser);
            assert_eq!(call.action, action);
            assert_eq!(call.display.title, title);
            assert!(!call.display.title.contains("MCP"));
        }
    }

    #[test]
    fn computer_actions_render_as_desktop_actions() {
        let clicked = normalize_tool_call(input(
            ToolTransport::ComputerBridge,
            "dynamicToolCall",
            "computer_use",
            "click",
            json!({ "operation": "click", "app": "Safari" }),
        ));
        assert_eq!(clicked.surface, ToolSurface::Computer);
        assert_eq!(clicked.action, ToolActionKind::ComputerClick);
        assert_eq!(clicked.display.title, "Clicked Safari on Computer");

        let typed = normalize_tool_call(input(
            ToolTransport::Mcp,
            "mcpToolCall",
            "computer_use",
            "type",
            json!({ "operation": "type", "appName": "TextEdit" }),
        ));
        assert_eq!(typed.surface, ToolSurface::Computer);
        assert_eq!(typed.action, ToolActionKind::ComputerType);
        assert_eq!(typed.display.title, "Typed into TextEdit on Computer");

        let keyed = normalize_tool_call(input(
            ToolTransport::Mcp,
            "mcpToolCall",
            "press_key",
            "",
            json!({ "arguments": { "app": "Terminal", "key": "Return" } }),
        ));
        assert_eq!(keyed.surface, ToolSurface::Computer);
        assert_eq!(keyed.action, ToolActionKind::ComputerKey);
        assert_eq!(keyed.display.title, "Pressed key in Terminal on Computer");
    }

    #[test]
    fn computer_use_bridge_tool_name_variants_render_as_desktop_actions() {
        let cases = [
            (
                "mcp__computer-use__click",
                json!({ "x": 10, "y": 20 }),
                ToolActionKind::ComputerClick,
                "Clicked 10,20 on Computer",
            ),
            (
                "set_value",
                json!({ "app": "Notes", "value": "Ship it" }),
                ToolActionKind::ComputerType,
                "Typed into Notes on Computer",
            ),
            (
                "select_text",
                json!({ "appName": "TextEdit", "text": "hello" }),
                ToolActionKind::ComputerType,
                "Typed into TextEdit on Computer",
            ),
            (
                "perform_secondary_action",
                json!({ "app": "Finder", "action": "Show menu" }),
                ToolActionKind::ComputerApp,
                "Ran Finder on Computer",
            ),
        ];

        for (tool, args, action, title) in cases {
            let call =
                normalize_tool_call(input(ToolTransport::Mcp, "mcpToolCall", tool, "", args));
            assert_eq!(call.surface, ToolSurface::Computer);
            assert_eq!(call.action, action);
            assert_eq!(call.display.title, title);
        }
    }

    #[test]
    fn terminal_file_subagent_and_github_are_semantic() {
        let command = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "commandExecution",
            "shell",
            "",
            json!({ "command": "cargo test --workspace" }),
        ));
        assert_eq!(command.surface, ToolSurface::Terminal);
        assert_eq!(command.action, ToolActionKind::TerminalRun);
        assert_eq!(command.display.title, "Ran `cargo test --workspace`");

        let file = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "fileChange",
            "apply_patch",
            "",
            json!({ "path": "src/lib.rs" }),
        ));
        assert_eq!(file.surface, ToolSurface::Filesystem);
        assert_eq!(file.action, ToolActionKind::FilePatch);
        assert_eq!(file.display.title, "Edited src/lib.rs");

        let github = normalize_tool_call(input(
            ToolTransport::Mcp,
            "mcpToolCall",
            "list_issues",
            "issues.list",
            json!({ "repo": "openai/codex" }),
        ));
        let mut provider = github.provider.clone();
        provider.server_name = Some("github".to_string());
        let github = normalize_tool_call(ToolNormalizationInput {
            provider,
            ..input(
                ToolTransport::Mcp,
                "mcpToolCall",
                "list_issues",
                "issues.list",
                json!({ "repo": "openai/codex" }),
            )
        });
        assert_eq!(github.surface, ToolSurface::Github);
        assert_eq!(github.action, ToolActionKind::GithubIssue);

        let subagent = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "subAgentActivity",
            "subagent",
            "",
            json!({ "agentName": "reviewer" }),
        ));
        assert_eq!(subagent.surface, ToolSurface::Subagent);
        assert_eq!(subagent.display.title, "Started subagent reviewer");

        let close_subagent = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "subagent",
            "subagent",
            "subagent_close",
            json!({ "subagentThreadId": "subagent-1" }),
        ));
        assert_eq!(close_subagent.surface, ToolSurface::Subagent);
        assert_eq!(close_subagent.action, ToolActionKind::SubagentClose);
        assert_eq!(close_subagent.display.title, "Closed subagent subagent-1");

        let plan = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "planImplementation",
            "plan",
            "fork_for_implementation",
            json!({ "targetThreadId": "fork-1" }),
        ));
        assert_eq!(plan.surface, ToolSurface::Plan);
        assert_eq!(plan.action, ToolActionKind::PlanFork);
        assert_eq!(plan.display.title, "Forked plan into fork-1");

        let handoff = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "handoff",
            "handoff",
            "handoff_to_location",
            json!({ "targetLocation": "worktree" }),
        ));
        assert_eq!(handoff.surface, ToolSurface::Handoff);
        assert_eq!(handoff.action, ToolActionKind::HandoffLocation);
        assert_eq!(handoff.display.title, "Handed off to worktree");

        let review = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "review",
            "review",
            "review_start",
            json!({ "threadId": "thread-1" }),
        ));
        assert_eq!(review.surface, ToolSurface::Review);
        assert_eq!(review.action, ToolActionKind::ReviewStart);
        assert_eq!(review.display.title, "Started review for thread-1");

        let image = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "imageGeneration",
            "image_generation",
            "generate",
            json!({ "prompt": "diagram" }),
        ));
        assert_eq!(image.surface, ToolSurface::Image);
        assert_eq!(image.action, ToolActionKind::ImageGenerate);
        assert_eq!(image.display.title, "Generated image diagram");

        let web_search = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "webSearch",
            "web_search",
            "search",
            json!({ "query": "rust gpui" }),
        ));
        assert_eq!(web_search.surface, ToolSurface::WebSearch);
        assert_eq!(web_search.action, ToolActionKind::WebSearch);
        assert_eq!(web_search.display.title, "Searched web for rust gpui");

        let viewed_image = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "imageView",
            "image_view",
            "view",
            json!({ "url": "https://example.com/image.png" }),
        ));
        assert_eq!(viewed_image.surface, ToolSurface::Image);
        assert_eq!(viewed_image.action, ToolActionKind::ImageView);
        assert_eq!(
            viewed_image.display.title,
            "Viewed image https://example.com/image.png"
        );
        assert_eq!(
            viewed_image.display.technical_metadata["renderable_asset"],
            json!({
                "kind": "image",
                "source": "https://example.com/image.png",
                "source_kind": "url",
                "proxy_required": false,
                "proxy_method": null
            })
        );

        let github_image = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "imageView",
            "image_view",
            "view",
            json!({ "url": "https://private-user-images.githubusercontent.com/123/example.png?jwt=redacted" }),
        ));
        assert_eq!(github_image.surface, ToolSurface::Image);
        assert_eq!(github_image.action, ToolActionKind::ImageView);
        assert_eq!(
            github_image.display.technical_metadata["renderable_asset"],
            json!({
                "kind": "image",
                "source": "https://private-user-images.githubusercontent.com/123/example.png?jwt=redacted",
                "source_kind": "url",
                "proxy_required": true,
                "proxy_method": "github.image.proxy"
            })
        );

        let screenshot = normalize_tool_call(input(
            ToolTransport::BrowserBridge,
            "dynamicToolCall",
            "ace_browser",
            "screenshot",
            json!({ "path": "/tmp/browser-shot.png" }),
        ));
        assert_eq!(screenshot.surface, ToolSurface::Browser);
        assert_eq!(screenshot.action, ToolActionKind::BrowserScreenshot);
        assert_eq!(
            screenshot.display.technical_metadata["renderable_asset"],
            json!({
                "kind": "image",
                "source": "/tmp/browser-shot.png",
                "source_kind": "file",
                "proxy_required": false,
                "proxy_method": null
            })
        );
    }

    #[test]
    fn skill_plugin_and_app_connector_actions_are_semantic() {
        let skill = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "skill",
            "rust",
            "skills/install",
            json!({ "skill": "rust" }),
        ));
        assert_eq!(skill.surface, ToolSurface::Skill);
        assert_eq!(skill.action, ToolActionKind::SkillInstall);
        assert_eq!(skill.display.title, "Installed skill rust");

        let plugin = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "plugin",
            "browser",
            "plugin/read",
            json!({ "plugin": "browser" }),
        ));
        assert_eq!(plugin.surface, ToolSurface::Plugin);
        assert_eq!(plugin.action, ToolActionKind::PluginRead);
        assert_eq!(plugin.display.title, "Read plugin browser");

        let installed_plugins = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "plugin",
            "",
            "plugin/installed",
            json!({}),
        ));
        assert_eq!(installed_plugins.surface, ToolSurface::Plugin);
        assert_eq!(installed_plugins.action, ToolActionKind::PluginList);
        assert_eq!(installed_plugins.display.title, "Listed plugins");

        let marketplace_upgrade = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "plugin",
            "browser",
            "marketplace/upgrade",
            json!({ "plugin": "browser" }),
        ));
        assert_eq!(marketplace_upgrade.surface, ToolSurface::Plugin);
        assert_eq!(
            marketplace_upgrade.action,
            ToolActionKind::PluginMarketplaceUpgrade
        );
        assert_eq!(marketplace_upgrade.display.title, "Upgraded plugin browser");

        let app = normalize_tool_call(input(
            ToolTransport::AppConnector,
            "appConnector",
            "browser",
            "apps/configWrite",
            json!({ "app": "browser" }),
        ));
        assert_eq!(app.surface, ToolSurface::App);
        assert_eq!(app.action, ToolActionKind::AppConfigure);
        assert_eq!(app.display.title, "Configured app browser");
    }

    #[test]
    fn terminal_output_write_resize_and_terminate_have_distinct_labels() {
        let output = normalize_tool_call(input(
            ToolTransport::Process,
            "commandExecution",
            "shell",
            "process/outputDelta",
            json!({ "processId": "proc-1", "delta": "building..." }),
        ));
        assert_eq!(output.surface, ToolSurface::Terminal);
        assert_eq!(output.action, ToolActionKind::TerminalOutput);
        assert_eq!(output.display.title, "Read terminal output from proc-1");

        let write = normalize_tool_call(input(
            ToolTransport::Process,
            "commandExecution",
            "shell",
            "command/exec/write",
            json!({ "terminalId": "term-1", "stdin": "q" }),
        ));
        assert_eq!(write.action, ToolActionKind::TerminalWrite);
        assert_eq!(write.display.title, "Wrote to terminal term-1");

        let resize = normalize_tool_call(input(
            ToolTransport::Process,
            "commandExecution",
            "shell",
            "command/exec/resize",
            json!({ "terminalId": "term-1", "cols": 120, "rows": 40 }),
        ));
        assert_eq!(resize.action, ToolActionKind::TerminalResize);
        assert_eq!(resize.display.title, "Resized terminal term-1");

        let terminate = normalize_tool_call(input(
            ToolTransport::Process,
            "commandExecution",
            "shell",
            "command/exec/terminate",
            json!({ "terminalId": "term-1" }),
        ));
        assert_eq!(terminate.action, ToolActionKind::TerminalTerminate);
        assert_eq!(terminate.display.title, "Stopped terminal term-1");
    }

    #[test]
    fn realtime_process_calls_do_not_render_as_terminal_tools() {
        let append_text = normalize_tool_call(input(
            ToolTransport::Process,
            "realtime",
            "thread.realtime.appendText",
            "realtime_append_text",
            json!({ "threadId": "thread-1", "text": "hello" }),
        ));
        assert_eq!(append_text.surface, ToolSurface::Realtime);
        assert_eq!(append_text.action, ToolActionKind::RealtimeAppendText);
        assert_eq!(
            append_text.display.title,
            "Appended realtime input thread-1"
        );
        assert_eq!(append_text.display.icon_key, "waveform");

        let list_voices = normalize_tool_call(input(
            ToolTransport::Process,
            "realtime",
            "thread.realtime.listVoices",
            "realtime_list_voices",
            json!({}),
        ));
        assert_eq!(list_voices.surface, ToolSurface::Realtime);
        assert_eq!(list_voices.action, ToolActionKind::RealtimeListVoices);
        assert_eq!(list_voices.display.title, "Listed realtime voices");
    }

    #[test]
    fn unknown_mcp_falls_back_to_named_external_tool() {
        let mut provider = ProviderToolMetadata::new();
        provider.server_name = Some("linear".to_string());
        provider.tool_name = Some("create_comment".to_string());
        provider.raw_args = json!({ "body": "Looks good" });
        let call = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::Mcp,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("mcpToolCall".to_string()),
        });

        assert_eq!(call.surface, ToolSurface::GenericMcp);
        assert_eq!(call.display.title, "Ran linear.create_comment tool");
        assert_eq!(
            call.display.summary.as_deref(),
            Some("server: linear, tool: create_comment")
        );
    }

    #[test]
    fn preserves_raw_payload_and_exposes_inspector_metadata() {
        let raw = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "item": {
                "id": "item-1",
                "type": "dynamicToolCall",
                "toolName": "ace_browser",
                "input": {
                    "operation": "navigate_tab_url",
                    "url": "https://example.com"
                }
            }
        });
        let mut provider = ProviderToolMetadata::new();
        provider.provider = Some("codex".to_string());
        provider.method = Some("item/completed".to_string());
        provider.tool_name = Some("ace_browser".to_string());
        provider.operation = Some("navigate_tab_url".to_string());
        provider.raw_args = raw["item"]["input"].clone();
        provider.raw_payload = raw.clone();

        let call = normalize_tool_call(ToolNormalizationInput {
            transport: ToolTransport::DynamicTool,
            status: ToolRunStatus::Completed,
            provider,
            item_type: Some("dynamicToolCall".to_string()),
        });

        assert_eq!(call.transport, ToolTransport::DynamicTool);
        assert_eq!(call.provider.raw_payload, raw);
        assert_eq!(call.display.technical_metadata["transport"], "dynamic_tool");
        assert_eq!(call.display.technical_metadata["method"], "item/completed");
        assert_eq!(
            call.display.technical_metadata["item_type"],
            "dynamicToolCall"
        );
        assert_eq!(
            call.display.technical_metadata["operation"],
            "navigate_tab_url"
        );
    }

    #[test]
    fn normalizes_provider_tool_events_from_item_payloads() {
        let raw = json!({
            "threadId": "thread-1",
            "turnId": "turn-1",
            "itemId": "tool-1",
            "item": {
                "id": "tool-1",
                "type": "dynamicToolCall",
                "toolName": "ace_browser",
                "input": {
                    "operation": "navigate_tab_url",
                    "url": "https://example.com"
                },
                "result": { "ok": true }
            }
        });
        let tool = normalize_provider_tool_event(ProviderToolEventNormalizationInput {
            provider: "future-provider".to_string(),
            method: "item/completed".to_string(),
            params: raw.clone(),
        })
        .expect("semantic tool");

        assert_eq!(tool.transport, ToolTransport::BrowserBridge);
        assert_eq!(tool.surface, ToolSurface::Browser);
        assert_eq!(tool.action, ToolActionKind::BrowserNavigate);
        assert_eq!(tool.display.title, "Opened https://example.com in Browser");
        assert_eq!(tool.provider.provider.as_deref(), Some("future-provider"));
        assert_eq!(tool.provider.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(tool.provider.item_id.as_deref(), Some("tool-1"));
        assert_eq!(tool.provider.raw_args["url"], "https://example.com");
        assert_eq!(tool.provider.raw_payload, raw);
    }

    #[test]
    fn normalizes_provider_server_request_tools_from_approval_payloads() {
        let tool =
            normalize_provider_server_request_tool(ProviderServerRequestToolNormalizationInput {
                provider: "future-provider".to_string(),
                request_id: "42".to_string(),
                method: "command/approvalRequest".to_string(),
                params: json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "command": "cargo test --workspace",
                    "cwd": "/repo",
                    "prompt": "Run tests?"
                }),
            })
            .expect("approval tool");

        assert_eq!(tool.transport, ToolTransport::Shell);
        assert_eq!(tool.surface, ToolSurface::Terminal);
        assert_eq!(tool.action, ToolActionKind::TerminalRun);
        assert_eq!(tool.display.status, ToolRunStatus::ApprovalRequested);
        assert_eq!(tool.display.title, "Running `cargo test --workspace`");
        assert_eq!(tool.provider.provider.as_deref(), Some("future-provider"));
        assert_eq!(tool.provider.item_id.as_deref(), Some("42"));
        assert_eq!(tool.provider.raw_payload["prompt"], "Run tests?");
    }

    #[test]
    fn github_pr_check_commit_and_search_actions_are_distinct() {
        let cases = [
            (
                "pr list",
                json!({ "repo": "openai/codex", "pr": 12 }),
                ToolActionKind::GithubPullRequest,
                "Read GitHub pull request 12",
            ),
            (
                "checks status",
                json!({ "repo": "openai/codex" }),
                ToolActionKind::GithubCheck,
                "Read GitHub checks openai/codex",
            ),
            (
                "commit details",
                json!({ "repo": "openai/codex" }),
                ToolActionKind::GithubCommit,
                "Read GitHub commit openai/codex",
            ),
            (
                "search repositories",
                json!({ "repo": "openai/codex" }),
                ToolActionKind::GithubSearch,
                "Searched GitHub search openai/codex",
            ),
        ];

        for (operation, args, action, title) in cases {
            let mut provider = ProviderToolMetadata::new();
            provider.server_name = Some("github".to_string());
            provider.tool_name = Some("gh".to_string());
            provider.operation = Some(operation.to_string());
            provider.raw_args = args;
            let call = normalize_tool_call(ToolNormalizationInput {
                transport: ToolTransport::Mcp,
                status: ToolRunStatus::Completed,
                provider,
                item_type: Some("mcpToolCall".to_string()),
            });

            assert_eq!(call.surface, ToolSurface::Github);
            assert_eq!(call.action, action);
            assert_eq!(call.display.title, title);
        }
    }
}
