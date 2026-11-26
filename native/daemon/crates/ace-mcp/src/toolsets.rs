// SPDX-License-Identifier: Apache-2.0
//! How a client lists and reaches ace's tools, ported from
//! `packages/mcp-server/src/toolsets.ts`: the listing modes, the core list, the on-demand
//! simulator family, opened toolsets, call budgets and Codex's destructive-tool naming.

use std::collections::HashMap;

use ace_json::Value;

use crate::credentials::LeaseId;
use crate::limits::{MAX_CALL_BUDGET_SECONDS, MIN_CALL_BUDGET_SECONDS};
use crate::tool_names::{ACE_TOOL_DISPATCH, ACE_TOOL_SEARCH, bare_tool_name};

/// `ToolListing`: every tool, the core entry points, or a fixed list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ToolListing {
    #[default]
    All,
    Core,
    Static,
}

/// The header that asks for a listing; listing every tool needs none.
pub const CORE_TOOLS_HEADER: (&str, &str) = ("X-Ace-Tools", "core");
pub const STATIC_TOOLS_HEADER: (&str, &str) = ("X-Ace-Tools", "static");
pub const CODEX_CLIENT_HEADER: (&str, &str) = ("X-Ace-Client", "codex");
pub const CURSOR_CLIENT_HEADER: (&str, &str) = ("X-Ace-Client", "cursor");
/// How long the client lets a call run (`X-Ace-Call-Budget`, whole seconds).
pub const CALL_BUDGET_HEADER: &str = "X-Ace-Call-Budget";
/// `_meta` key a client names whom one call is for.
pub const ACTING_FOR_META_KEY: &str = "ace/acting-for";

/// A client whose reading of tools differs from its listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AceClient {
    Codex,
    Cursor,
}

/// `toolListing`: the `X-Ace-Tools` header's mode.
pub fn tool_listing(header: Option<&str>) -> ToolListing {
    match header {
        Some(value) if value == CORE_TOOLS_HEADER.1 => ToolListing::Core,
        Some(value) if value == STATIC_TOOLS_HEADER.1 => ToolListing::Static,
        _ => ToolListing::All,
    }
}

/// `toolListingHeader`: the header a listing asks for.
pub fn tool_listing_header(listing: ToolListing) -> Option<(&'static str, &'static str)> {
    match listing {
        ToolListing::Core => Some(CORE_TOOLS_HEADER),
        ToolListing::Static => Some(STATIC_TOOLS_HEADER),
        ToolListing::All => None,
    }
}

/// `aceClient`: who the client says it is.
pub fn ace_client(header: Option<&str>) -> Option<AceClient> {
    match header {
        Some(value) if value == CODEX_CLIENT_HEADER.1 => Some(AceClient::Codex),
        Some(value) if value == CURSOR_CLIENT_HEADER.1 => Some(AceClient::Cursor),
        _ => None,
    }
}

/// `callBudgetSeconds`: the client's own call limit, when it names a usable one.
pub fn call_budget_seconds(header: Option<&str>) -> Option<u64> {
    let header = header?.trim();
    if header.is_empty() || header.len() > 4 || !header.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let seconds = header.parse::<u64>().ok()?;
    (MIN_CALL_BUDGET_SECONDS..=MAX_CALL_BUDGET_SECONDS)
        .contains(&seconds)
        .then_some(seconds)
}

/// `withinCallBudget`: a requested wait, cut to the client's budget when it has one.
pub fn within_call_budget(seconds: f64, budget: Option<u64>) -> f64 {
    match budget {
        // `Math.min(seconds, budget)` in whole seconds: the client cancels at the boundary.
        Some(budget) => seconds.min(budget as f64),
        None => seconds,
    }
}

/// The family whose simulator tools a session lists only once devices are first used.
pub const ON_DEMAND_TOOLSET: &str = "ace-computer-use";

/// `listedOnDemand`: a simulator tool.
pub fn listed_on_demand(tool: &str) -> bool {
    bare_tool_name(tool).starts_with("sim_")
}

/// `holdsOnDemandTools`: a session listing every tool holds them back only where its client
/// reloads on `tools/list_changed`.
pub fn holds_on_demand_tools(listing: ToolListing, client: Option<AceClient>) -> bool {
    listing == ToolListing::All && client.is_none()
}

/// `coreTools`: what a core-mode session lists before it opens a family, by bare name.
pub const CORE_TOOLS: [&str; 11] = [
    "context",
    "guide",
    "delegate",
    "wait",
    "ask",
    "note_add",
    "thread_link_pr",
    "browser_open",
    "html_render",
    "screen_state",
    "screen_open_app",
];

/// The family a call opens: a guide's topic, or an entry point's family.
pub fn opened_toolset(tool: &str, args: &Value) -> Option<String> {
    let bare = bare_tool_name(tool);
    if bare == "guide" {
        return args.get("topic").and_then(Value::as_str).map(str::to_owned);
    }
    match bare.as_str() {
        "delegate" => Some("ace-agents".to_owned()),
        "browser_open" => Some("ace-browser".to_owned()),
        "screen_state" | "screen_open_app" => Some("ace-computer-use".to_owned()),
        _ => None,
    }
}

/// The toolsets a lease has opened, keyed by the lease: they last as long as the credential,
/// and two leases sharing a session id never share them (`toolsets.ts:181`).
#[derive(Default)]
pub struct OpenToolsets {
    open: HashMap<LeaseId, Vec<String>>,
}

impl OpenToolsets {
    pub fn new() -> Self {
        Self::default()
    }

    /// `opened`: true when this call opened a toolset the session did not have.
    pub fn opened(&mut self, lease: LeaseId, tool: &str, args: &Value) -> bool {
        match opened_toolset(tool, args) {
            Some(topic) => self.add(lease, &[topic]),
            None => false,
        }
    }

    pub fn is_open(&self, lease: LeaseId, toolset: &str) -> bool {
        self.open
            .get(&lease)
            .is_some_and(|topics| topics.iter().any(|topic| topic == toolset))
    }

    /// Opens these families; true when any of them was new.
    pub fn add(&mut self, lease: LeaseId, topics: &[String]) -> bool {
        let open = self.open.entry(lease).or_default();
        let before = open.len();
        for topic in topics {
            if !open.iter().any(|open| open == topic) {
                open.push(topic.clone());
            }
        }
        open.len() > before
    }

    /// `lists`: whether this session lists a tool now. `tools_call` is listed wherever the list is
    /// not complete; in core mode a tool without a family is always listed.
    pub fn lists(
        &self,
        lease: LeaseId,
        listing: ToolListing,
        tool: &str,
        toolset: Option<&str>,
    ) -> bool {
        let bare = bare_tool_name(tool);
        if bare == ACE_TOOL_DISPATCH {
            return dispatches(listing);
        }
        if listing == ToolListing::All
            || bare == ACE_TOOL_SEARCH
            || CORE_TOOLS.contains(&bare.as_str())
        {
            return true;
        }
        if listing == ToolListing::Static {
            return false;
        }
        match toolset {
            Some(toolset) => self.is_open(lease, toolset),
            None => true,
        }
    }

    /// Forgets a lease's opened toolsets when it ends.
    pub fn forget(&mut self, lease: LeaseId) {
        self.open.remove(&lease);
    }
}

/// `namesDestructiveTools`: Codex on the fixed list, where it approves `tools_call`.
pub fn names_destructive_tools(listing: ToolListing, client: Option<AceClient>) -> bool {
    client == Some(AceClient::Codex) && listing == ToolListing::Static
}

/// `dispatches`: whether a session is offered `tools_call`.
pub fn dispatches(listing: ToolListing) -> bool {
    listing != ToolListing::All
}

/// `actingForOf`: the client's `ace/acting-for` when it is a short id.
pub fn acting_for_of(meta: Option<&Value>) -> Option<String> {
    let value = meta?.get(ACTING_FOR_META_KEY)?.as_str()?;
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "_.:-".contains(character));
    valid.then(|| value.to_owned())
}

#[cfg(test)]
mod tests {
    // Ported from `toolsets.ts`'s contract, the cases `list-changed.process` and the listing
    // budgets rely on.
    use super::*;
    use ace_json::parse;

    #[test]
    fn a_listing_is_read_from_its_header_and_a_listing_header_writes_it_back() {
        assert_eq!(tool_listing(Some("core")), ToolListing::Core);
        assert_eq!(tool_listing(Some("static")), ToolListing::Static);
        assert_eq!(tool_listing(Some("all")), ToolListing::All);
        assert_eq!(tool_listing(None), ToolListing::All);
        assert_eq!(
            tool_listing_header(ToolListing::Core),
            Some(CORE_TOOLS_HEADER)
        );
        assert_eq!(
            tool_listing_header(ToolListing::Static),
            Some(STATIC_TOOLS_HEADER)
        );
        assert_eq!(tool_listing_header(ToolListing::All), None);
    }

    #[test]
    fn a_call_budget_is_whole_seconds_from_five_to_six_hundred() {
        assert_eq!(call_budget_seconds(Some("60")), Some(60));
        assert_eq!(call_budget_seconds(Some(" 60 ")), Some(60));
        assert_eq!(call_budget_seconds(Some("5")), Some(5));
        assert_eq!(call_budget_seconds(Some("600")), Some(600));
        for header in ["4", "601", "-60", "1.5", "sixty", "12345", ""] {
            assert_eq!(call_budget_seconds(Some(header)), None, "{header}");
        }
        assert_eq!(within_call_budget(240.0, Some(60)), 60.0);
        assert_eq!(within_call_budget(240.0, None), 240.0);
    }

    #[test]
    fn core_mode_lists_the_entry_points_and_opens_a_family_only_when_it_is_used() {
        let mut toolsets = OpenToolsets::new();
        assert!(toolsets.lists(LeaseId(1), ToolListing::Core, "context", None));
        assert!(toolsets.lists(LeaseId(1), ToolListing::Core, "ace_thread_link_pr", None));
        // A tool with a family is listed once a guide or an entry point opens it.
        assert!(!toolsets.lists(
            LeaseId(1),
            ToolListing::Core,
            "thread_start",
            Some("ace-threads")
        ));
        let args = parse("{\"topic\":\"ace-threads\"}").expect("json");
        assert!(toolsets.opened(LeaseId(1), "guide", &args));
        assert!(toolsets.lists(
            LeaseId(1),
            ToolListing::Core,
            "thread_start",
            Some("ace-threads")
        ));
        // Another lease has not opened it.
        assert!(!toolsets.lists(
            LeaseId(2),
            ToolListing::Core,
            "thread_start",
            Some("ace-threads")
        ));
        // A tool without a family is always listed in core mode.
        assert!(toolsets.lists(LeaseId(1), ToolListing::Core, "html_render", None));
        // tools_call is offered wherever the list is incomplete.
        assert!(toolsets.lists(LeaseId(1), ToolListing::Core, "tools_call", None));
        assert!(!toolsets.lists(LeaseId(1), ToolListing::All, "tools_call", None));
    }

    #[test]
    fn a_static_listing_lists_only_the_core_entry_points_and_nothing_opened() {
        let mut toolsets = OpenToolsets::new();
        let args = parse("{\"topic\":\"ace-agents\"}").expect("json");
        assert!(toolsets.opened(LeaseId(1), "delegate", &args));
        assert!(toolsets.lists(
            LeaseId(1),
            ToolListing::Static,
            "delegate",
            Some("ace-agents")
        ));
        assert!(!toolsets.lists(
            LeaseId(1),
            ToolListing::Static,
            "thread_start",
            Some("ace-threads")
        ));
        assert!(toolsets.lists(LeaseId(1), ToolListing::Static, "tools_call", None));
        assert!(names_destructive_tools(
            ToolListing::Static,
            Some(AceClient::Codex)
        ));
        assert!(!names_destructive_tools(
            ToolListing::All,
            Some(AceClient::Codex)
        ));
    }

    #[test]
    fn the_simulator_family_is_held_back_only_for_a_client_that_reloads() {
        assert!(holds_on_demand_tools(ToolListing::All, None));
        assert!(!holds_on_demand_tools(
            ToolListing::All,
            Some(AceClient::Codex)
        ));
        assert!(!holds_on_demand_tools(ToolListing::Core, None));
        assert!(listed_on_demand("sim_tap"));
        assert!(listed_on_demand("mcp__ace__sim_tap"));
        assert!(!listed_on_demand("screen_state"));
        assert_eq!(ON_DEMAND_TOOLSET, "ace-computer-use");
    }

    #[test]
    fn an_acting_for_id_is_short_alphanumeric_and_anything_else_is_ignored() {
        let meta = parse("{\"ace/acting-for\":\"thread-1:root\"}").expect("json");
        assert_eq!(acting_for_of(Some(&meta)).as_deref(), Some("thread-1:root"));
        for text in [
            "{\"ace/acting-for\":\"\"}",
            "{\"ace/acting-for\":7}",
            "{\"ace/acting-for\":\"has space\"}",
            "{}",
        ] {
            let meta = parse(text).expect("json");
            assert_eq!(acting_for_of(Some(&meta)), None, "{text}");
        }
    }
}
