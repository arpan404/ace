use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolTransport {
    CodexBuiltin,
    CodexDynamic,
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
    #[serde(rename = "browser.tab")]
    BrowserTab,
    #[serde(rename = "browser.console")]
    BrowserConsole,
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
    #[serde(rename = "git.commit")]
    GitCommit,
    #[serde(rename = "git.push")]
    GitPush,
    #[serde(rename = "github.issue")]
    GithubIssue,
    #[serde(rename = "github.pr")]
    GithubPullRequest,
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
        let server = input.provider.server_name.clone().unwrap_or_default();
        let haystack = [
            input.item_type.as_deref().unwrap_or_default(),
            input.provider.method.as_deref().unwrap_or_default(),
            &server,
            &tool,
            &op,
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
    if let Some(mapped) = browser_action(input.transport, facts) {
        return (ToolSurface::Browser, mapped);
    }
    if let Some(mapped) = computer_action(input.transport, facts, &input.provider.raw_args) {
        return (ToolSurface::Computer, mapped);
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
    if facts.haystack.contains("subagent")
        || facts.haystack.contains("collab agent")
        || facts.haystack.contains("agent spawn")
    {
        let action = if facts.haystack.contains("steer") || facts.haystack.contains("message") {
            ToolActionKind::SubagentSteer
        } else if facts.haystack.contains("stop")
            || facts.haystack.contains("close")
            || facts.haystack.contains("terminate")
        {
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
    if transport != ToolTransport::BrowserBridge
        && !facts.haystack.contains("browser")
        && !facts.haystack.contains("playwright")
        && !facts.haystack.contains("dom cua")
        && !facts.haystack.contains("ace browser")
    {
        return None;
    }

    let op = first_string([Some(facts.op.as_str()), Some(facts.tool.as_str())])
        .unwrap_or_default()
        .to_lowercase();
    let action = match op.as_str() {
        "click"
        | "cua_click"
        | "dom_cua_click"
        | "playwright_locator_click"
        | "playwright_locator_dblclick"
        | "cua_double_click"
        | "dom_cua_double_click" => ToolActionKind::BrowserClick,
        "fill"
        | "type"
        | "cua_type"
        | "dom_cua_type"
        | "dom_cua_fill"
        | "playwright_locator_fill"
        | "playwright_locator_type"
        | "playwright_locator_press"
        | "select_option" => ToolActionKind::BrowserType,
        "open_url"
        | "goto"
        | "navigate"
        | "navigate_tab_url"
        | "back"
        | "forward"
        | "reload"
        | "navigate_tab_back"
        | "navigate_tab_forward"
        | "navigate_tab_reload" => ToolActionKind::BrowserNavigate,
        "screenshot" | "playwright_screenshot" | "cua_get_visible_screenshot" => {
            ToolActionKind::BrowserScreenshot
        }
        "dom_snapshot"
        | "playwright_dom_snapshot"
        | "dom_cua_get_visible_dom"
        | "playwright_locator_inner_text"
        | "playwright_locator_text_content"
        | "playwright_locator_get_attribute"
        | "playwright_locator_is_visible"
        | "playwright_locator_is_enabled"
        | "playwright_locator_count" => ToolActionKind::BrowserInspect,
        "tab_dev_logs" | "console_logs" | "browser_console" => ToolActionKind::BrowserConsole,
        "list_tabs" | "selected_tab" | "get_tab" | "select_tab" | "switch_tab" | "activate_tab"
        | "next_tab" | "previous_tab" | "create_tab" | "new_tab" | "close_tab" => {
            ToolActionKind::BrowserTab
        }
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
        _ if facts.haystack.contains("screenshot") => ToolActionKind::BrowserScreenshot,
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
    let op = first_string([Some(facts.op.as_str()), Some(facts.tool.as_str())])
        .unwrap_or_default()
        .to_lowercase();
    let action = match op.as_str() {
        "click" | "double_click" | "cua_click" | "cua_double_click" => {
            ToolActionKind::ComputerClick
        }
        "type" | "type_text" | "cua_type" | "fill" => ToolActionKind::ComputerType,
        "scroll" | "cua_scroll" => ToolActionKind::ComputerScroll,
        "key" | "keypress" | "key_press" | "cua_keypress" | "press_key" => {
            ToolActionKind::ComputerKey
        }
        "screenshot" | "get_screenshot" | "cua_get_visible_screenshot" => {
            ToolActionKind::ComputerScreenshot
        }
        "activate_app" | "open_app" | "select_window" | "get_app_state" | "list_apps" => {
            ToolActionKind::ComputerApp
        }
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
            | "type"
            | "type_text"
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
        } else if facts.haystack.contains("write") || facts.haystack.contains("stdin") {
            Some(ToolActionKind::TerminalWrite)
        } else if facts.haystack.contains("output") {
            Some(ToolActionKind::TerminalOutput)
        } else {
            Some(ToolActionKind::TerminalRun)
        }
    } else if transport == ToolTransport::Shell || transport == ToolTransport::Process {
        Some(ToolActionKind::TerminalRun)
    } else {
        None
    }
}

fn file_action(haystack: &str) -> Option<ToolActionKind> {
    if haystack.contains("file change") || haystack.contains("apply patch") {
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
    if !facts.haystack.contains("github") && facts.server != "github" && facts.tool != "gh" {
        return None;
    }
    if facts.haystack.contains("issue") {
        Some(ToolActionKind::GithubIssue)
    } else if facts.haystack.contains("pull request")
        || facts.haystack.contains(" pr ")
        || facts.haystack.contains("pr list")
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
        ToolSurface::Subagent => first_string([
            string_at_deep(args, "agentName").as_deref(),
            string_at_deep(args, "agent_name").as_deref(),
            string_at_deep(args, "name").as_deref(),
            string_at_deep(args, "agentRole").as_deref(),
        ])
        .map(|label| ToolTarget {
            kind: ToolTargetKind::Agent,
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
    first_string([
        string_at_deep(args, "label").as_deref(),
        string_at_deep(args, "text").as_deref(),
        string_at_deep(args, "selector").as_deref(),
        string_at_deep(args, "locator").as_deref(),
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
    ])
    .map(|label| ToolTarget {
        kind: ToolTargetKind::File,
        label,
    })
}

fn github_target(action: ToolActionKind, args: &Value) -> Option<ToolTarget> {
    let number = first_string([
        string_at_deep(args, "number").as_deref(),
        string_at_deep(args, "issue").as_deref(),
        string_at_deep(args, "pr").as_deref(),
        string_at_deep(args, "pullRequest").as_deref(),
    ]);
    number
        .map(|label| ToolTarget {
            kind: if action == ToolActionKind::GithubPullRequest {
                ToolTargetKind::PullRequest
            } else {
                ToolTargetKind::Issue
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
        (ToolSurface::WebSearch, Some(target)) => format!("{verb} web search {target}"),
        (ToolSurface::WebSearch, None) => format!("{verb} web search"),
        (ToolSurface::Image, _) => format!("{verb} image"),
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

    ToolDisplay {
        title,
        summary: summary_for(input, facts),
        target,
        status,
        icon_key: icon_for(surface, action).to_string(),
    }
}

fn verb_for(status: ToolRunStatus, action: ToolActionKind) -> &'static str {
    match status {
        ToolRunStatus::Started | ToolRunStatus::Updated | ToolRunStatus::ApprovalRequested => {
            match action {
                ToolActionKind::BrowserClick | ToolActionKind::ComputerClick => "Clicking",
                ToolActionKind::BrowserType | ToolActionKind::ComputerType => "Typing into",
                ToolActionKind::ComputerKey => "Pressing key in",
                ToolActionKind::BrowserNavigate => "Opening",
                ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot => {
                    "Capturing"
                }
                ToolActionKind::BrowserInspect => "Inspecting",
                ToolActionKind::BrowserTab => "Switching",
                ToolActionKind::BrowserViewport => "Resizing",
                ToolActionKind::BrowserZoom => "Changing zoom for",
                ToolActionKind::BrowserConsole => "Reading",
                ToolActionKind::TerminalRun => "Running",
                ToolActionKind::TerminalWrite => "Writing to",
                ToolActionKind::TerminalResize => "Resizing",
                ToolActionKind::TerminalTerminate => "Stopping",
                ToolActionKind::TerminalOutput => "Reading",
                ToolActionKind::FilePatch | ToolActionKind::FileEdit => "Editing",
                ToolActionKind::FileRead => "Reading",
                ToolActionKind::GithubIssue | ToolActionKind::GithubPullRequest => "Reading",
                ToolActionKind::GithubSearch | ToolActionKind::WebSearch => "Searching",
                ToolActionKind::ImageView => "Viewing",
                ToolActionKind::ImageGenerate => "Generating",
                ToolActionKind::SubagentSpawn => "Starting",
                ToolActionKind::SubagentSteer => "Steering",
                ToolActionKind::SubagentStop => "Stopping",
                _ => "Running",
            }
        }
        ToolRunStatus::Completed => match action {
            ToolActionKind::BrowserClick | ToolActionKind::ComputerClick => "Clicked",
            ToolActionKind::BrowserType | ToolActionKind::ComputerType => "Typed into",
            ToolActionKind::ComputerKey => "Pressed key in",
            ToolActionKind::BrowserNavigate => "Opened",
            ToolActionKind::BrowserScreenshot | ToolActionKind::ComputerScreenshot => "Captured",
            ToolActionKind::BrowserInspect => "Inspected",
            ToolActionKind::BrowserTab => "Switched",
            ToolActionKind::BrowserViewport => "Resized",
            ToolActionKind::BrowserZoom => "Changed zoom for",
            ToolActionKind::BrowserConsole => "Read",
            ToolActionKind::TerminalRun => "Ran",
            ToolActionKind::TerminalWrite => "Wrote to",
            ToolActionKind::TerminalResize => "Resized",
            ToolActionKind::TerminalTerminate => "Stopped",
            ToolActionKind::TerminalOutput => "Read",
            ToolActionKind::FilePatch | ToolActionKind::FileEdit => "Edited",
            ToolActionKind::FileRead => "Read",
            ToolActionKind::GithubIssue | ToolActionKind::GithubPullRequest => "Read",
            ToolActionKind::GithubSearch | ToolActionKind::WebSearch => "Searched",
            ToolActionKind::ImageView => "Viewed",
            ToolActionKind::ImageGenerate => "Generated",
            ToolActionKind::SubagentSpawn => "Started",
            ToolActionKind::SubagentSteer => "Steered",
            ToolActionKind::SubagentStop => "Stopped",
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
        ToolActionKind::BrowserConsole => "console logs",
        ToolActionKind::BrowserTab => "tab",
        ToolActionKind::BrowserViewport => "viewport",
        ToolActionKind::BrowserZoom => "zoom",
        ToolActionKind::GithubIssue => "issue",
        ToolActionKind::GithubPullRequest => "pull request",
        ToolActionKind::GithubSearch => "search",
        _ => "tool",
    }
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
                ToolActionKind::BrowserConsole,
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

        let image = normalize_tool_call(input(
            ToolTransport::CodexBuiltin,
            "imageGeneration",
            "image_generation",
            "generate",
            json!({ "prompt": "diagram" }),
        ));
        assert_eq!(image.surface, ToolSurface::Image);
        assert_eq!(image.action, ToolActionKind::ImageGenerate);
        assert_eq!(image.display.title, "Generated image");
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
}
