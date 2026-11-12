//! The tools Spade offers a model. Core tools are always sent in full; deferred tools are found
//! with `tool_search` and called through `call_tool`, so the tool list sent to the model never
//! changes within a conversation and its cached prefix stays valid (docs/design.md, Caching).

use std::collections::BTreeMap;

use serde_json::{Value, json};
use spade_models::ToolSpec;

/// How much a tool call can change in the world, which decides whether the gate asks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    /// Only reads.
    Read,
    /// Changes something the person may want to check first.
    Write,
    /// Changes only the bot's own notes (ADR 0128): runs, except in a turn that read untrusted
    /// content, since a note outlives the turn.
    Memory,
    /// Deletes, sends money or cannot be undone.
    Destructive,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolDef {
    pub spec: ToolSpec,
    pub risk: Risk,
    /// Its output can carry instructions from strangers (web pages, email). After such a result,
    /// every write in the turn asks.
    pub untrusted_output: bool,
    /// Listed by name only; found with `tool_search` and called through `call_tool`.
    pub deferred: bool,
    /// Runs as a background job: the call answers at once and the result arrives later as a
    /// `<job_result>`, so long work (an ace agent, a big download) never holds up the turn.
    pub background: bool,
}

pub const TOOL_SEARCH: &str = "tool_search";
pub const CALL_TOOL: &str = "call_tool";

/// Every tool Spade can run, by name.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Registry {
    tools: BTreeMap<String, ToolDef>,
    /// Offer `tool_search` and `call_tool` even with no deferred tool yet, because some will
    /// arrive later (ace's tools); the offered list must not change when they do.
    always_search: bool,
}

impl Registry {
    pub fn new(tools: impl IntoIterator<Item = ToolDef>) -> Self {
        Self {
            tools: tools
                .into_iter()
                .map(|tool| (tool.spec.name.clone(), tool))
                .collect(),
            always_search: false,
        }
    }

    /// A registry that always offers `tool_search` and `call_tool`, for when deferred tools come
    /// and go while Spade runs.
    pub fn with_search(tools: impl IntoIterator<Item = ToolDef>) -> Self {
        Self {
            always_search: true,
            ..Self::new(tools)
        }
    }

    pub fn get(&self, name: &str) -> Option<&ToolDef> {
        self.tools.get(name)
    }

    /// What the model is sent: core tools sorted by name, then `tool_search` and `call_tool` when
    /// any tool is deferred. Same input, same bytes.
    pub fn offered(&self) -> Vec<ToolSpec> {
        let mut specs: Vec<ToolSpec> = self
            .tools
            .values()
            .filter(|tool| !tool.deferred)
            .map(|tool| tool.spec.clone())
            .collect();
        if self.always_search || self.tools.values().any(|tool| tool.deferred) {
            specs.push(tool_search_spec());
            specs.push(call_tool_spec());
        }
        specs
    }

    /// Deferred tools matching `query`, best first, at most `limit`. Every word of three letters or
    /// more is looked for in the name and description; the name counts double.
    pub fn search(&self, query: &str, limit: usize) -> Vec<&ToolDef> {
        let words: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() >= 3)
            .map(str::to_lowercase)
            .collect();
        let mut scored: Vec<(usize, &ToolDef)> = self
            .tools
            .values()
            .filter(|tool| tool.deferred)
            .filter_map(|tool| {
                let name = tool.spec.name.to_lowercase();
                let about = tool.spec.description.to_lowercase();
                let score: usize = words
                    .iter()
                    .map(|w| {
                        2 * usize::from(name.contains(w.as_str()))
                            + usize::from(about.contains(w.as_str()))
                    })
                    .sum();
                (score > 0).then_some((score, tool))
            })
            .collect();
        scored.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then_with(|| a.1.spec.name.cmp(&b.1.spec.name))
        });
        scored
            .into_iter()
            .take(limit)
            .map(|(_, tool)| tool)
            .collect()
    }
}

/// The text a `tool_search` result carries: each tool's name, description and input schema.
pub fn describe(found: &[&ToolDef]) -> String {
    if found.is_empty() {
        return "No tools matched. Try other words.".to_owned();
    }
    let mut out = String::from("Call these with call_tool, giving the name and the arguments.\n");
    for tool in found {
        out.push_str(&format!(
            "\n{}: {}\ninput schema: {}\n",
            tool.spec.name, tool.spec.description, tool.spec.schema
        ));
    }
    out
}

/// Reads a `call_tool` call's arguments: the tool to run and its own arguments.
pub fn unwrap_call_tool(arguments: &Value) -> Option<(String, Value)> {
    let name = arguments.get("name")?.as_str()?.to_owned();
    let inner = arguments
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    Some((name, inner))
}

fn tool_search_spec() -> ToolSpec {
    ToolSpec {
        name: TOOL_SEARCH.to_owned(),
        description: "Find more tools by describing what you need, such as \"calendar events\" or \
                      \"start a coding agent\". Returns each tool's name and input schema."
            .to_owned(),
        schema: json!({ "type": "object",
                        "properties": { "query": { "type": "string" } },
                        "required": ["query"] }),
    }
}

fn call_tool_spec() -> ToolSpec {
    ToolSpec {
        name: CALL_TOOL.to_owned(),
        description: "Run a tool found with tool_search.".to_owned(),
        schema: json!({ "type": "object",
                        "properties": { "name": { "type": "string" },
                                        "arguments": { "type": "object" } },
                        "required": ["name", "arguments"] }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, description: &str, deferred: bool) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: name.into(),
                description: description.into(),
                schema: json!({ "type": "object" }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred,
            background: false,
        }
    }

    fn registry() -> Registry {
        Registry::new([
            tool("web_search", "Search the web", false),
            tool("ask_user", "Ask the person a question", false),
            tool("calendar_events", "List calendar events", true),
            tool("thread_start", "Start a coding agent thread in ace", true),
        ])
    }

    #[test]
    fn the_model_is_offered_core_tools_in_name_order_plus_search_and_call() {
        let names: Vec<String> = registry().offered().into_iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            vec!["ask_user", "web_search", "tool_search", "call_tool"]
        );
    }

    #[test]
    fn the_offer_is_the_same_whatever_order_tools_were_added_in() {
        let a = registry().offered();
        let b = Registry::new([
            tool("thread_start", "Start a coding agent thread in ace", true),
            tool("calendar_events", "List calendar events", true),
            tool("ask_user", "Ask the person a question", false),
            tool("web_search", "Search the web", false),
        ])
        .offered();
        assert_eq!(a, b);
    }

    #[test]
    fn without_deferred_tools_there_is_no_search_or_call() {
        let names: Vec<String> = Registry::new([tool("web_search", "Search the web", false)])
            .offered()
            .into_iter()
            .map(|s| s.name)
            .collect();
        assert_eq!(names, vec!["web_search"]);
    }

    #[test]
    fn search_finds_deferred_tools_only_with_name_matches_first() {
        let registry = registry();
        let found: Vec<&str> = registry
            .search("start a coding agent", 5)
            .into_iter()
            .map(|t| t.spec.name.as_str())
            .collect();
        assert_eq!(found, vec!["thread_start"]);
        assert!(
            registry.search("web", 5).is_empty(),
            "core tools are not searched"
        );
        let calendar: Vec<&str> = registry
            .search("Calendar", 5)
            .into_iter()
            .map(|t| t.spec.name.as_str())
            .collect();
        assert_eq!(calendar, vec!["calendar_events"]);
    }

    #[test]
    fn a_call_tool_call_names_its_tool_and_arguments() {
        let unwrapped =
            unwrap_call_tool(&json!({ "name": "thread_start", "arguments": { "title": "x" } }));
        assert_eq!(
            unwrapped,
            Some(("thread_start".to_owned(), json!({ "title": "x" })))
        );
        assert_eq!(unwrap_call_tool(&json!({ "arguments": {} })), None);
    }
}
