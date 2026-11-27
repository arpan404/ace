// SPDX-License-Identifier: Apache-2.0
//! Session guidance, provider developer instructions, Codex compact tool naming, status groups,
//! and M3 per-caller availability caching.
//!
//! Ported from `packages/mcp-server/src/{status,codex-guidance,session-guidance}.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use indexmap::{IndexMap, IndexSet};

use crate::brief::AccessMode;
use crate::credentials::CAPABILITIES;
use crate::tool_names::bare_tool_name;
use crate::toolsets::ToolListing;

/// The guides the always-on guidance points to; each is a shipped skill and a `guide` topic.
pub const GUIDE_TOPICS: [&str; 5] = [
    "ace-agents",
    "ace-browser",
    "visualize",
    "ace-threads",
    "ace-computer-use",
];

/// Every family a tool can belong to, including guides left out of the always-on text.
pub const TOOL_FAMILIES: [&str; 6] = [
    "ace-agents",
    "ace-browser",
    "visualize",
    "ace-threads",
    "ace-computer-use",
    "make-a-suit",
];

/// About 300 tokens: Codex's tool name list never outgrows the rest of the prefix.
pub const MAX_TOOL_NAME_CHARS: usize = 1_200;

/// Supported provider kinds (`ProviderKind` in `@ace/protocol`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderKind {
    Claude,
    Codex,
    Cursor,
    Opencode,
    Pi,
    Antigravity,
    Acp,
}

impl ProviderKind {
    pub const ALL: [Self; 7] = [
        Self::Claude,
        Self::Codex,
        Self::Cursor,
        Self::Opencode,
        Self::Pi,
        Self::Antigravity,
        Self::Acp,
    ];
}

/// Why a group is off when nothing explicitly disabled it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GroupOffReasons {
    pub unregistered: Option<String>,
    pub withheld: Option<String>,
}

/// One group's availability entry in `McpStatus["groups"]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpStatusGroup {
    pub name: String,
    pub enabled: bool,
    pub reason: Option<String>,
}

/// MCP server instructions: the always-on part of ace's guidance (`status.ts:44`).
pub fn ace_guidance(groups: Option<&[&str]>, tools: Option<&[&str]>) -> String {
    let has = |names: &[&str]| match groups {
        None => true,
        Some(list) => names.iter().any(|name| list.contains(name)),
    };
    let has_tool = |name: &str| match tools {
        None => true,
        Some(list) => list.contains(&name),
    };
    let native_apps = if has_tool("screen_state") {
        "screen_state"
    } else if has_tool("screen_open_app") {
        "screen_open_app"
    } else {
        "guide ace-computer-use"
    };
    let whole_screen = if has(&["screen"]) && has_tool("screen_display") {
        " displays: screen_display;"
    } else {
        ""
    };

    let mut lines = vec![
        "ace runs this session. Your shell, file and web tools work as usual; use ace's for what only ace can:"
            .to_owned(),
        "- you start in an existing project: context first;".to_owned(),
    ];
    if has(&["agents"]) {
        lines.push(
            "- independent or parallel parts: delegate (not your own subagent tool), then wait;"
                .to_owned(),
        );
    }
    if has(&["browser"]) {
        lines.push(
            "- you changed a UI or localhost page: browser_open, then browser_snapshot; the person watches;"
                .to_owned(),
        );
    }
    lines.push("- visuals or images: guide visualize first;".to_owned());
    lines.push("- after gh pr create or finding the PR: thread_link_pr;".to_owned());
    if has(&["thread_control"]) {
        lines.push(
            "- the person wants a separate thread in any project: thread_start; settle only when they explicitly ask: thread_control settle;"
                .to_owned(),
        );
    }
    if has(&["screen", "devices"]) {
        lines.push(format!(
            "- the person names a native app or simulator: {native_apps};{whole_screen}"
        ));
    }
    lines.push("Not sure which ace tool fits? tools_find with what you want to do.".to_owned());
    lines.push(format!(
        "How-tos and more tools: guide with topic {}.",
        GUIDE_TOPICS.join(", ")
    ));
    lines.push(
        "If an ace tool says its group is off, tell the person. Agents never answer approvals."
            .to_owned(),
    );
    lines.join("\n")
}

/// Shared discovery policy for MCP clients and the person's Sources list (`status.ts:88`).
pub fn mcp_status_groups(
    registered: &HashSet<&str>,
    capabilities: &[&str],
    disabled: &HashMap<&str, &str>,
    reasons: &GroupOffReasons,
) -> Vec<McpStatusGroup> {
    let mut out = Vec::with_capacity(CAPABILITIES.len() + 1);
    out.push(McpStatusGroup {
        name: "thread".to_owned(),
        enabled: true,
        reason: None,
    });
    for name in CAPABILITIES {
        let reason = disabled
            .get(name)
            .map(|value| (*value).to_owned())
            .or_else(|| {
                if !registered.contains(name) {
                    Some(reasons.unregistered.clone().unwrap_or_else(|| {
                        "This ace daemon is not running this tool group.".to_owned()
                    }))
                } else {
                    None
                }
            })
            .or_else(|| {
                if !capabilities.contains(&name) {
                    Some(reasons.withheld.clone().unwrap_or_else(|| {
                        "ace does not offer this tool group to this provider session.".to_owned()
                    }))
                } else {
                    None
                }
            });
        out.push(McpStatusGroup {
            name: name.to_owned(),
            enabled: reason.is_none(),
            reason,
        });
    }
    out
}

/// Cursor's listing mode: `All` while its MCP meta tool is on, else `Static`.
pub const fn cursor_tool_listing(meta_tool: bool) -> ToolListing {
    if meta_tool {
        ToolListing::All
    } else {
        ToolListing::Static
    }
}

/// The listing a provider's sessions use unless the daemon knows better (an ACP agent's CLI).
pub const fn usual_tool_listing(provider: ProviderKind) -> ToolListing {
    match provider {
        ProviderKind::Codex | ProviderKind::Claude => ToolListing::All,
        ProviderKind::Opencode | ProviderKind::Pi | ProviderKind::Antigravity => ToolListing::Core,
        ProviderKind::Cursor => cursor_tool_listing(true),
        ProviderKind::Acp => ToolListing::Static,
    }
}

const fn reads_server_instructions(provider: ProviderKind) -> bool {
    matches!(
        provider,
        ProviderKind::Claude | ProviderKind::Opencode | ProviderKind::Acp
    )
}

const SKILLS_LINE: &str = "ace's guides are also installed as skills.";
const CLAUDE_SKILLS_LINE: &str =
    "ace's guides are installed as skills; use them for guide <topic>.";
const READ_ONLY_LINE: &str = "This session is read-only: ace's read tools (context, guide, tools_find, thread_read, threads_find, agents_status, wait) still work; your provider decides on any that change things.";

/// Bare names, those sharing a family prefix (at least 3 members) folded into one brace group
/// (`browser_{open,snapshot,act}`), in catalogue order and cut at a whole entry past `max_chars`.
pub fn compact_tool_names(names: &[&str], max_chars: usize) -> String {
    let mut bare: IndexSet<String> = IndexSet::new();
    for name in names {
        bare.insert(bare_tool_name(name));
    }

    let mut families: IndexMap<&str, Vec<&str>> = IndexMap::new();
    for name in &bare {
        if let Some((family, _)) = name.split_once('_')
            && !family.is_empty()
        {
            families.entry(family).or_default().push(name.as_str());
        }
    }

    let mut entries = Vec::new();
    let mut folded: HashSet<&str> = HashSet::new();
    for name in &bare {
        let family = name.split_once('_').map(|(f, _)| f).unwrap_or("");
        let members = families.get(family);
        if members.is_none_or(|list| list.len() < 3) {
            entries.push(name.clone());
        } else if folded.insert(family)
            && let Some(list) = members
        {
            let rest: Vec<&str> = list.iter().map(|m| &m[family.len() + 1..]).collect();
            entries.push(format!("{family}_{{{}}}", rest.join(",")));
        }
    }

    let mut text = String::new();
    for entry in entries {
        let next = if text.is_empty() {
            entry
        } else {
            format!("{text}, {entry}")
        };
        if crate::brief::utf16_len(&next) > max_chars {
            return format!("{text}, …");
        }
        text = next;
    }
    text
}

/// Codex's line in the developer prefix (`codex-guidance.ts:57`).
pub fn codex_prefix(tools: Option<&[&str]>, skills: &str, listing: ToolListing) -> String {
    let mut parts = vec![
        "Codex: ace tools are mcp__ace__<name>. With exec, call them inside it: await tools.mcp__ace__<name>(args)."
            .to_owned(),
        "ace's wait is tools.mcp__ace__wait, not your own wait.".to_owned(),
        "Find one with ALL_TOOLS.filter(t => t.name.startsWith(\"mcp__ace__\")), or get names and input schemas from tools.mcp__ace__tools_find({query}); guide({topic}) returns its family's schemas."
            .to_owned(),
        "Without exec, load one with your tool_search, then call mcp__ace__<name>.".to_owned(),
    ];
    if listing == ToolListing::Static {
        parts.push(
            "Your ace list is fixed: call any other ace tool with tools_call {name, arguments}."
                .to_owned(),
        );
    }
    if let Some(list) = tools
        && !list.is_empty()
    {
        parts.push(format!(
            "ace tools here: {}.",
            compact_tool_names(list, MAX_TOOL_NAME_CHARS)
        ));
    }
    if !skills.is_empty() {
        parts.push(skills.to_owned());
    }
    parts.join(" ")
}

/// What the daemon knows about this session when it injects developer guidance.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionGuidanceInput<'a> {
    pub brief: Option<&'a str>,
    pub groups: Option<&'a [&'a str]>,
    pub roles: Option<&'a str>,
    pub tools: Option<&'a [&'a str]>,
    pub access: Option<AccessMode>,
    pub listing: Option<ToolListing>,
    pub server_instructions: Option<bool>,
}

/// Guidance for the provider's own system/developer channel (`session-guidance.ts:106`).
pub fn developer_instructions(
    provider: ProviderKind,
    session: &SessionGuidanceInput<'_>,
) -> String {
    let listing = session
        .listing
        .unwrap_or_else(|| usual_tool_listing(provider));
    let served = session
        .server_instructions
        .unwrap_or_else(|| reads_server_instructions(provider));

    let mut lines = Vec::new();
    if !served {
        lines.push(ace_guidance(session.groups, session.tools));
    }

    if provider == ProviderKind::Codex {
        lines.push(codex_prefix(session.tools, SKILLS_LINE, listing));
    } else {
        let naming = match provider {
            ProviderKind::Codex | ProviderKind::Claude => "",
            ProviderKind::Opencode => {
                "OpenCode names ace tools ace_<tool> (ace_guide, ace_delegate). ace's guides are also installed as skills. Load them with your skill tool."
            }
            ProviderKind::Cursor => {
                "ace tools come from the ace MCP server. ace's guides are also installed as skills."
            }
            ProviderKind::Antigravity => {
                "Read a definition file if needed; call ace tools with call_mcp_tool (ServerName \"ace\", ToolName, Arguments)."
            }
            ProviderKind::Acp => "ace tools come from the ace MCP server.",
            ProviderKind::Pi => {
                "ace tools are your ace_<tool> extension tools: guide is ace_guide and delegate is ace_delegate. ace's guides are also installed as skills."
            }
        };
        if !naming.is_empty() {
            lines.push(naming.to_owned());
        }

        let reach_line = if provider == ProviderKind::Antigravity && listing == ToolListing::Core {
            "guide or tools_find grows your tool list; tools_call {name, arguments} reaches unlisted tools."
        } else {
            match listing {
                ToolListing::All => match provider {
                    ProviderKind::Cursor => {
                        "ace tools are listed by name only: GetMcpTools (server \"ace\", toolName) gives a schema and tools_find finds one by task; call it with CallMcpTool, e.g. thread_start or browser_open."
                    }
                    ProviderKind::Antigravity => {
                        "Most ace tools are deferred: read the tool's definition file, then call it with call_mcp_tool (ServerName \"ace\", ToolName, Arguments), e.g. ToolName thread_start or browser_open."
                    }
                    _ => {
                        "Most ace tools are deferred, wait, guide and tools_find too: load one with your tool search (select:mcp__ace__thread_start); with none, call it via tools_call {name, arguments}."
                    }
                },
                ToolListing::Core => {
                    "Your ace list starts small: guide or tools_find adds a family (thread_start and thread_control come with ace-threads); call one not listed yet with tools_call {name, arguments}."
                }
                ToolListing::Static => {
                    "Your ace list is fixed: call other ace tools, such as thread_start or thread_control, with tools_call {name, arguments}; tools_find or guide gives the schema."
                }
            }
        };
        lines.push(reach_line.to_owned());
    }

    if provider == ProviderKind::Claude {
        lines.push(CLAUDE_SKILLS_LINE.to_owned());
    }
    if session.access == Some(AccessMode::ReadOnly) {
        lines.push(READ_ONLY_LINE.to_owned());
    }
    if let Some(roles) = session.roles
        && !roles.is_empty()
    {
        lines.push(roles.to_owned());
    }
    if let Some(brief) = session.brief
        && !brief.is_empty()
    {
        lines.push(brief.to_owned());
    }
    lines.join("\n")
}

/// An actionable startup error when Gemini's native folder trust blocks the session.
pub fn gemini_untrusted_guidance(folder: &str, denied: bool) -> String {
    let fix = if denied {
        "Change the earlier Don't trust choice with /permissions in an interactive gemini session there."
    } else {
        "Run gemini in that folder once and choose \"Trust folder\"."
    };
    format!(
        "Gemini CLI does not trust {folder}, so ace cannot start a session with its tools there. {fix} Then retry this turn in ace."
    )
}

/// Per-caller availability cache (M3): holds computed status snapshots keyed by caller key and
/// drops them whenever group registration or settings change (`invalidate()`).
pub struct AvailabilityCache<K, V> {
    generation: AtomicU64,
    entries: Mutex<(u64, HashMap<K, V>)>,
}

impl<K, V> Default for AvailabilityCache<K, V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K, V> AvailabilityCache<K, V> {
    pub fn new() -> Self {
        Self {
            generation: AtomicU64::new(0),
            entries: Mutex::new((0, HashMap::new())),
        }
    }

    /// Invalidate every cached caller entry (call on group registration or settings changes).
    pub fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::Release);
    }

    /// Read a cached snapshot for `key` or compute and cache it using `compute`.
    pub fn get_or_compute(&self, key: K, compute: impl FnOnce() -> V) -> V
    where
        K: Eq + std::hash::Hash,
        V: Clone,
    {
        let gen_now = self.generation.load(Ordering::Acquire);
        {
            let mut guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if guard.0 != gen_now {
                guard.1.clear();
                guard.0 = gen_now;
            } else if let Some(hit) = guard.1.get(&key) {
                return hit.clone();
            }
        }
        let value = compute();
        let mut guard = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.generation.load(Ordering::Acquire) == gen_now {
            if guard.0 != gen_now {
                guard.1.clear();
                guard.0 = gen_now;
            }
            guard.1.insert(key, value.clone());
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_session_hears_how_to_reach_thread_start_for_its_listing() {
        let shared = ace_guidance(None, None);
        assert!(shared.contains("thread_start"));
        assert!(
            developer_instructions(ProviderKind::Claude, &SessionGuidanceInput::default())
                .contains("select:mcp__ace__thread_start")
        );
        assert!(
            developer_instructions(ProviderKind::Codex, &SessionGuidanceInput::default())
                .contains("tools.mcp__ace__<name>(args)")
        );
        for provider in [ProviderKind::Opencode, ProviderKind::Pi] {
            let text = developer_instructions(provider, &SessionGuidanceInput::default());
            assert!(text.contains("come with ace-threads"));
            assert!(text.contains("tools_call {name, arguments}"));
        }
        assert!(
            developer_instructions(ProviderKind::Acp, &SessionGuidanceInput::default())
                .contains("such as thread_start or thread_control, with tools_call")
        );
        let cursor = developer_instructions(ProviderKind::Cursor, &SessionGuidanceInput::default());
        assert!(cursor.contains("GetMcpTools (server \"ace\", toolName)"));
        assert!(cursor.contains("call it with CallMcpTool, e.g. thread_start"));
        assert!(!cursor.contains("tools_call"));
        assert!(!cursor.contains("select:mcp__ace__"));

        let antigravity =
            developer_instructions(ProviderKind::Antigravity, &SessionGuidanceInput::default());
        assert!(antigravity.contains("call_mcp_tool (ServerName \"ace\", ToolName, Arguments)"));
        assert!(antigravity.contains("tools_call {name, arguments}"));
        assert!(!antigravity.contains("select:mcp__ace__"));
    }

    #[test]
    fn a_read_only_session_hears_which_ace_tools_still_work_on_every_provider() {
        for provider in ProviderKind::ALL {
            let ro = developer_instructions(
                provider,
                &SessionGuidanceInput {
                    access: Some(AccessMode::ReadOnly),
                    ..SessionGuidanceInput::default()
                },
            );
            assert!(ro.contains("This session is read-only"));
            assert!(ro.contains("thread_read"));

            let full = developer_instructions(
                provider,
                &SessionGuidanceInput {
                    access: Some(AccessMode::FullAccess),
                    ..SessionGuidanceInput::default()
                },
            );
            assert!(!full.contains("read-only"));
        }
        assert!(!ace_guidance(None, None).contains("read-only"));
    }

    #[test]
    fn native_apps_and_displays_point_at_the_tools_the_session_can_call() {
        let mac = developer_instructions(
            ProviderKind::Pi,
            &SessionGuidanceInput {
                tools: Some(&[
                    "context",
                    "screen_apps",
                    "screen_state",
                    "screen_act",
                    "screen_display",
                ]),
                ..SessionGuidanceInput::default()
            },
        );
        assert!(mac.contains("native app or simulator: screen_state; displays: screen_display;"));

        let session = developer_instructions(
            ProviderKind::Pi,
            &SessionGuidanceInput {
                tools: Some(&["context", "screen_open_app", "screen_ui_tree"]),
                ..SessionGuidanceInput::default()
            },
        );
        assert!(session.contains("native app or simulator: screen_open_app;"));
        assert!(!session.contains("screen_state"));

        let devices_only = developer_instructions(
            ProviderKind::Pi,
            &SessionGuidanceInput {
                tools: Some(&["context", "sim_list", "sim_ui"]),
                ..SessionGuidanceInput::default()
            },
        );
        assert!(devices_only.contains("native app or simulator: guide ace-computer-use;"));
    }

    #[test]
    fn compact_tool_names_folds_families_of_three_or_more_and_respects_cap() {
        let compact = compact_tool_names(
            &[
                "mcp__ace__context",
                "ace_browser_open",
                "browser_snapshot",
                "browser_act",
                "screen_state",
                "screen_act",
            ],
            MAX_TOOL_NAME_CHARS,
        );
        assert_eq!(
            compact,
            "context, browser_{open,snapshot,act}, screen_state, screen_act"
        );

        let capped = compact_tool_names(
            &["context", "delegate", "browser_open", "browser_snapshot"],
            20,
        );
        assert_eq!(capped, "context, delegate, …");
    }

    #[test]
    fn mcp_status_groups_applies_disabled_unregistered_and_withheld_precedence() {
        let registered: HashSet<&str> = ["browser", "agents"].into_iter().collect();
        let disabled: HashMap<&str, &str> = [("browser", "Off in settings.")].into_iter().collect();
        let groups = mcp_status_groups(
            &registered,
            &["browser"],
            &disabled,
            &GroupOffReasons::default(),
        );
        assert_eq!(groups[0].name, "thread");
        assert!(groups[0].enabled);

        let browser = groups.iter().find(|g| g.name == "browser");
        assert_eq!(
            browser.and_then(|g| g.reason.as_deref()),
            Some("Off in settings.")
        );
        let agents = groups.iter().find(|g| g.name == "agents");
        assert_eq!(
            agents.and_then(|g| g.reason.as_deref()),
            Some("ace does not offer this tool group to this provider session.")
        );
        let notify = groups.iter().find(|g| g.name == "notify");
        assert_eq!(
            notify.and_then(|g| g.reason.as_deref()),
            Some("This ace daemon is not running this tool group.")
        );
    }

    #[test]
    fn availability_cache_serves_cached_value_until_invalidated() {
        let cache: AvailabilityCache<String, u32> = AvailabilityCache::new();
        let calls = AtomicU64::new(0);
        let first = cache.get_or_compute("caller-1".to_owned(), || {
            calls.fetch_add(1, Ordering::Relaxed);
            10
        });
        let second = cache.get_or_compute("caller-1".to_owned(), || {
            calls.fetch_add(1, Ordering::Relaxed);
            20
        });
        assert_eq!(first, 10);
        assert_eq!(second, 10);
        assert_eq!(calls.load(Ordering::Relaxed), 1);

        cache.invalidate();
        let third = cache.get_or_compute("caller-1".to_owned(), || {
            calls.fetch_add(1, Ordering::Relaxed);
            30
        });
        assert_eq!(third, 30);
        assert_eq!(calls.load(Ordering::Relaxed), 2);
    }
}
