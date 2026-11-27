// SPDX-License-Identifier: Apache-2.0
//! Whether Claude Code defers ace's tools behind its own tool search, and the listing that
//! follows, ported from `claude-tool-search.ts`.
//!
//! With tool search on, every tool is listed and deferred. Otherwise each listed tool costs its
//! full definition on every request, so the session gets the core listing and opens families on
//! use (a `tools/list_changed` reload). The facts are the CLI's own environment, the model and
//! whether its permission rules deny `ToolSearch`.

use crate::toolsets::ToolListing;

/// What ace can see about a Claude Code session before it launches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ClaudeToolSearchFacts {
    /// The session's environment: settings `env` applied over the launch environment.
    pub env: Vec<(String, String)>,
    /// The model its requests use; absent: `ANTHROPIC_MODEL`, else the CLI's default.
    pub model: Option<String>,
    /// Permission rules deny `ToolSearch`, so MCP tools load upfront.
    pub tool_search_denied: bool,
}

impl ClaudeToolSearchFacts {
    pub fn new(env: Vec<(String, String)>, model: Option<String>) -> Self {
        Self {
            env,
            model,
            tool_search_denied: false,
        }
    }

    fn get(&self, key: &str) -> Option<&str> {
        self.env
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

/// Why tool search is off or may be off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeToolSearchReason {
    ExperimentalBetasDisabled,
    DisabledByEnv,
    ToolSearchDenied,
    ModelUnsupported,
    VertexModelUnsupported,
    AutoThreshold,
    FoundryDeployment,
    Gateway,
}

/// `on`: every tool not marked always-load is deferred. `off`: every tool loads upfront.
/// `uncertain`: the CLI decides at run time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeToolSearch {
    On,
    Off(ClaudeToolSearchReason),
    Uncertain(ClaudeToolSearchReason),
}

/// Models whose name contains one of these never get tool search (the CLI's default list).
const UNSUPPORTED_MODELS: [&str; 6] = [
    "claude-3-opus",
    "claude-3-sonnet",
    "claude-3-haiku",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
    "claude-3-7-sonnet",
];

/// `claudeToolSearch`: the CLI's decision, from the facts ace can see.
pub fn claude_tool_search(facts: &ClaudeToolSearchFacts) -> ClaudeToolSearch {
    // Strips the tool-search beta; only managed settings can force it back on.
    if truthy(facts.get("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS")) {
        return ClaudeToolSearch::Off(ClaudeToolSearchReason::ExperimentalBetasDisabled);
    }
    let mode = search_mode(facts.get("ENABLE_TOOL_SEARCH"));
    if mode == SearchMode::Off {
        return ClaudeToolSearch::Off(ClaudeToolSearchReason::DisabledByEnv);
    }
    if facts.tool_search_denied {
        return ClaudeToolSearch::Off(ClaudeToolSearchReason::ToolSearchDenied);
    }
    let model = facts
        .model
        .as_deref()
        .or_else(|| facts.get("ANTHROPIC_MODEL"))
        .map(str::to_lowercase);
    if let Some(model) = &model
        && UNSUPPORTED_MODELS.iter().any(|name| model.contains(name))
    {
        return ClaudeToolSearch::Off(ClaudeToolSearchReason::ModelUnsupported);
    }
    let provider = api_provider(facts);
    if provider == ApiProvider::Vertex
        && let Some(model) = &model
        && vertex_rejects(model)
    {
        return ClaudeToolSearch::Off(ClaudeToolSearchReason::VertexModelUnsupported);
    }
    if mode == SearchMode::Auto {
        return ClaudeToolSearch::Uncertain(ClaudeToolSearchReason::AutoThreshold);
    }
    // Foundry deployments hosted on Azure reject tool search; the CLI learns it from a 400.
    if provider == ApiProvider::Foundry {
        return ClaudeToolSearch::Uncertain(ClaudeToolSearchReason::FoundryDeployment);
    }
    // A gateway may refuse `defer_loading`; the CLI then loads every tool upfront.
    if provider == ApiProvider::Gateway
        || (provider == ApiProvider::FirstParty && custom_base_url(facts))
    {
        return ClaudeToolSearch::Uncertain(ClaudeToolSearchReason::Gateway);
    }
    ClaudeToolSearch::On
}

/// The listing ace gives a Claude Code session: every tool when tool search defers them, else
/// the core entry points.
pub fn claude_tool_listing(facts: &ClaudeToolSearchFacts) -> ToolListing {
    match claude_tool_search(facts) {
        ClaudeToolSearch::On => ToolListing::All,
        ClaudeToolSearch::Off(_) | ClaudeToolSearch::Uncertain(_) => ToolListing::Core,
    }
}

/// The listing after the session's facts change (a model switch): it only ever narrows.
pub fn claude_tool_listing_after(
    current: ToolListing,
    facts: &ClaudeToolSearchFacts,
) -> ToolListing {
    if current == ToolListing::All {
        claude_tool_listing(facts)
    } else {
        current
    }
}

/// The listing for Claude Code run by claude-agent-acp: with no model at launch, core.
pub fn acp_claude_tool_listing(facts: &ClaudeToolSearchFacts) -> ToolListing {
    if facts.model.is_some() {
        claude_tool_listing(facts)
    } else {
        ToolListing::Core
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SearchMode {
    On,
    Off,
    Auto,
}

/// `ENABLE_TOOL_SEARCH`, read as the CLI reads it: unset or unrecognised means on.
fn search_mode(value: Option<&str>) -> SearchMode {
    let Some(value) = value else {
        return SearchMode::On;
    };
    if let Some(rest) = value.strip_prefix("auto:") {
        // `Number("…")`: an empty threshold is 0 (`Number("")`), anything unreadable is NaN.
        let trimmed = rest.trim();
        let percent = if trimmed.is_empty() {
            0.0
        } else {
            trimmed.parse::<f64>().unwrap_or(f64::NAN)
        };
        if percent.is_nan() {
            return SearchMode::Auto;
        }
        let clamped = percent.clamp(0.0, 100.0);
        if clamped == 0.0 {
            return SearchMode::On;
        }
        return if clamped == 100.0 {
            SearchMode::Off
        } else {
            SearchMode::Auto
        };
    }
    if value == "auto" {
        return SearchMode::Auto;
    }
    if truthy(Some(value)) {
        SearchMode::On
    } else if falsy(value) {
        SearchMode::Off
    } else {
        SearchMode::On
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApiProvider {
    FirstParty,
    Gateway,
    Vertex,
    Foundry,
    Other,
}

/// The API the CLI sends requests to, in the order it checks its switches.
fn api_provider(facts: &ClaudeToolSearchFacts) -> ApiProvider {
    if truthy(facts.get("CLAUDE_CODE_USE_GATEWAY")) {
        return ApiProvider::Gateway;
    }
    if truthy(facts.get("CLAUDE_CODE_USE_BEDROCK")) {
        return ApiProvider::Other;
    }
    if truthy(facts.get("CLAUDE_CODE_USE_FOUNDRY")) {
        return ApiProvider::Foundry;
    }
    for name in [
        "CLAUDE_CODE_USE_ANTHROPIC_AWS",
        "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
        "CLAUDE_CODE_USE_MANTLE",
    ] {
        if truthy(facts.get(name)) {
            return ApiProvider::Other;
        }
    }
    if truthy(facts.get("CLAUDE_CODE_USE_VERTEX")) {
        ApiProvider::Vertex
    } else {
        ApiProvider::FirstParty
    }
}

/// Vertex serving stacks before the 4.5 generation reject the tool-search beta.
fn vertex_rejects(model: &str) -> bool {
    let id = strip_date(strip_brackets(model));
    if id.starts_with("claude-3-") || id == "claude-3" {
        return true;
    }
    let Some(rest) = id
        .strip_prefix("claude-opus-")
        .or_else(|| id.strip_prefix("claude-sonnet-"))
        .or_else(|| id.strip_prefix("claude-haiku-"))
    else {
        return false;
    };
    if !rest.starts_with(|character: char| character.is_ascii_digit()) {
        return false;
    }
    // Anything after the version the CLI cannot read counts as too old.
    let version_text = rest
        .split(|character: char| !(character.is_ascii_digit() || character == '-'))
        .next()
        .unwrap_or_default();
    let mut parts = version_text.split('-');
    let major: u32 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    let minor: u32 = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    major < 4 || (major == 4 && minor < 5)
}

/// `replace(/\[[^\]]*\]$/, "")`: a Vertex model may end in a bracketed qualifier.
fn strip_brackets(model: &str) -> &str {
    if let Some(start) = model.rfind('[')
        && model.ends_with(']')
        && !model[start + 1..model.len() - 1].contains(']')
    {
        return &model[..start];
    }
    model
}

/// `replace(/[@-]\d{8}$/, "")`: a Vertex model ends in an eight-digit date.
fn strip_date(model: &str) -> &str {
    let bytes = model.as_bytes();
    if bytes.len() >= 9
        && (bytes[bytes.len() - 9] == b'@' || bytes[bytes.len() - 9] == b'-')
        && bytes[bytes.len() - 8..].iter().all(u8::is_ascii_digit)
    {
        return &model[..model.len() - 9];
    }
    model
}

fn custom_base_url(facts: &ClaudeToolSearchFacts) -> bool {
    let Some(url) = facts.get("ANTHROPIC_BASE_URL") else {
        return false;
    };
    if url.is_empty() {
        return false;
    }
    match url_host(url) {
        Some(host) => host != "api.anthropic.com",
        None => true,
    }
}

/// The host of an `http(s)://host[:port]/…` URL.
fn url_host(url: &str) -> Option<&str> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        let (address, _) = rest.split_once(']')?;
        address
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    (!host.is_empty()).then_some(host)
}

fn truthy(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        !value.is_empty() && matches!(value.to_lowercase().trim(), "1" | "true" | "yes" | "on")
    })
}

fn falsy(value: &str) -> bool {
    matches!(value.to_lowercase().trim(), "0" | "false" | "no" | "off")
}

#[cfg(test)]
mod tests {
    // Ported from `claude-tool-search.test.ts`, case for case: "a Claude session lists every ace
    // tool while tool search defers them", "a Claude session gets the core listing when tool
    // search is off or may be", and "a session's listing narrows when a model switch turns tool
    // search off, and never widens".
    use super::*;

    fn session(env: &[(&str, &str)], model: Option<&str>) -> ClaudeToolSearchFacts {
        ClaudeToolSearchFacts {
            env: env
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            model: model.map(str::to_owned),
            tool_search_denied: false,
        }
    }

    fn listing_all(session: ClaudeToolSearchFacts, label: &str) {
        assert_eq!(claude_tool_listing(&session), ToolListing::All, "{label}");
    }

    fn listing_core(session: ClaudeToolSearchFacts, label: &str) {
        assert_eq!(claude_tool_listing(&session), ToolListing::Core, "{label}");
    }

    #[test]
    fn a_claude_session_lists_every_ace_tool_while_tool_search_defers_them() {
        listing_all(session(&[], None), "nothing configured");
        listing_all(session(&[("ENABLE_TOOL_SEARCH", "true")], None), "true");
        listing_all(session(&[("ENABLE_TOOL_SEARCH", "auto:0")], None), "auto:0");
        listing_all(
            session(&[("ENABLE_TOOL_SEARCH", "maybe")], None),
            "an unrecognised ENABLE_TOOL_SEARCH",
        );
        listing_all(
            session(&[("ANTHROPIC_BASE_URL", "https://api.anthropic.com")], None),
            "the Anthropic API named as the base URL",
        );
        listing_all(
            session(&[], Some("claude-opus-4-5-20251101")),
            "a current model",
        );
        listing_all(session(&[], Some("haiku")), "a model alias");
        listing_all(
            session(
                &[("CLAUDE_CODE_USE_BEDROCK", "1")],
                Some("us.anthropic.claude-sonnet-4-5-v1:0"),
            ),
            "Bedrock with a current model",
        );
        listing_all(
            session(
                &[("CLAUDE_CODE_USE_VERTEX", "1")],
                Some("claude-sonnet-4-5@20250929"),
            ),
            "Vertex with a 4.5 model",
        );
    }

    #[test]
    fn a_claude_session_gets_the_core_listing_when_tool_search_is_off_or_may_be() {
        listing_core(session(&[("ENABLE_TOOL_SEARCH", "false")], None), "false");
        listing_core(session(&[("ENABLE_TOOL_SEARCH", "0")], None), "0");
        listing_core(
            session(&[("ENABLE_TOOL_SEARCH", "auto:100")], None),
            "auto:100",
        );
        listing_core(
            session(&[("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "1")], None),
            "experimental betas disabled",
        );
        listing_core(
            session(
                &[
                    ("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "true"),
                    ("ENABLE_TOOL_SEARCH", "true"),
                ],
                None,
            ),
            "betas disabled even with ENABLE_TOOL_SEARCH=true",
        );
        listing_core(
            ClaudeToolSearchFacts {
                tool_search_denied: true,
                ..session(&[], None)
            },
            "ToolSearch denied",
        );
        listing_core(
            session(
                &[("ENABLE_TOOL_SEARCH", "true")],
                Some("claude-3-5-haiku-20241022"),
            ),
            "a Claude 3 model",
        );
        listing_core(
            session(&[("ANTHROPIC_MODEL", "claude-3-7-sonnet-latest")], None),
            "a Claude 3 model from ANTHROPIC_MODEL",
        );
        listing_core(
            session(
                &[("CLAUDE_CODE_USE_BEDROCK", "1")],
                Some("us.anthropic.claude-3-7-sonnet-20250219-v1:0"),
            ),
            "a Claude 3 model on Bedrock",
        );
        listing_core(
            session(
                &[("CLAUDE_CODE_USE_VERTEX", "1")],
                Some("claude-opus-4-1@20250805"),
            ),
            "a pre-4.5 model on Vertex",
        );
        listing_core(
            session(&[("ENABLE_TOOL_SEARCH", "auto")], None),
            "auto threshold mode",
        );
        listing_core(
            session(&[("ENABLE_TOOL_SEARCH", "auto:5")], None),
            "a custom auto threshold",
        );
        listing_core(
            session(
                &[("ANTHROPIC_BASE_URL", "https://llm.example.com/anthropic")],
                None,
            ),
            "a gateway base URL",
        );
        listing_core(
            session(&[("CLAUDE_CODE_USE_GATEWAY", "1")], None),
            "the gateway switch",
        );
        listing_core(
            session(&[("CLAUDE_CODE_USE_FOUNDRY", "1")], None),
            "Foundry",
        );
    }

    #[test]
    fn a_sessions_listing_narrows_when_a_model_switch_turns_tool_search_off_and_never_widens() {
        let before = claude_tool_listing(&session(&[], Some("claude-opus-4-5")));
        let narrowed = claude_tool_listing_after(before, &session(&[], Some("claude-3-5-haiku")));
        assert_eq!(before, ToolListing::All);
        assert_eq!(narrowed, ToolListing::Core);
        assert_eq!(
            claude_tool_listing_after(narrowed, &session(&[], Some("claude-opus-4-5"))),
            ToolListing::Core
        );
    }

    #[test]
    fn an_acp_session_without_a_model_at_launch_starts_core() {
        assert_eq!(
            acp_claude_tool_listing(&session(&[("ENABLE_TOOL_SEARCH", "true")], None)),
            ToolListing::Core
        );
        assert_eq!(
            acp_claude_tool_listing(&session(&[], Some("claude-opus-4-5"))),
            ToolListing::All
        );
    }

    #[test]
    fn an_unknown_version_on_vertex_counts_as_too_old_and_a_3_floor_is_too_old() {
        assert!(vertex_rejects("claude-opus-4-1"));
        assert!(vertex_rejects("claude-opus-4"));
        assert!(!vertex_rejects("claude-opus-4-5"));
        assert!(!vertex_rejects("claude-sonnet-4-5@20250929"));
        assert!(vertex_rejects("claude-3-5-sonnet"));
        // `Number("")` is 0, so an empty threshold is on.
        assert_eq!(
            claude_tool_listing(&session(&[("ENABLE_TOOL_SEARCH", "auto:")], None)),
            ToolListing::All
        );
        assert!(!vertex_rejects("claude-fable-5"));
        assert!(!vertex_rejects("claude-opus-5"));
    }
}
