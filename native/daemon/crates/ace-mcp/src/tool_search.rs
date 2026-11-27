// SPDX-License-Identifier: Apache-2.0
//! Lexical ranking of ace tools against what an agent wants to do, ported from
//! `packages/mcp-server/src/tool-search.ts`.
//!
//! Pure and deterministic: the same catalogue and query always give the same order.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use ace_json::Value;
use indexmap::IndexSet;

use crate::tool_names::bare_tool_name;

/// One tool as the session could call it.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchableTool {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
    /// The guide topic of its family; absent for core tools without one.
    pub family: Option<String>,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchOptions<'a> {
    pub limit: usize,
    pub family: Option<&'a str>,
}

const WEIGHT_NAME: f64 = 4.0;
const WEIGHT_TITLE: f64 = 3.0;
const WEIGHT_FAMILY: f64 = 2.0;
const WEIGHT_DESCRIPTION: f64 = 1.5;
const WEIGHT_FIELD: f64 = 0.5;
const SYNONYM_SHARE: f64 = 0.6;
const RELEVANCE_FLOOR: f64 = 0.3;

const STOPWORDS_RAW: &str = "a an the in on at to of for with from into my your our this that these those and or is are be it its i me we you please how do does can could would should what which want need let lets just some any use using via tool tools ace next time now later other another";

const SYNONYM_GROUPS: [&str; 23] = [
    "click tap press push hit select choose",
    "type enter fill keyboard key paste text",
    "button element widget menu ui",
    "app application native macos mac desktop window safari finder xcode mail calendar music photo slack figma calculator textedit",
    "simulator emulator iphone ipad ios android phone mobile sim",
    "page website site web url localhost browser",
    "console log network request output",
    "screenshot image picture capture visual look",
    "run start launch spawn kick begin execute",
    "task job work subtask",
    "remote different elsewhere paired machine host laptop server",
    "agent subagent child worker helper parallel delegate",
    "wait until finish done block result",
    "thread conversation chat session history transcript",
    "note remember memory knowledge fact",
    "schedule cron recur automation daily weekly periodic timer every",
    "pr pull github",
    "chart diagram graph mockup visualize render html preview",
    "ask question human person user",
    "cancel stop kill abort halt",
    "find search locate query",
    "open navigate go visit load",
    "measure latency performance smooth jank fps frame lag hitch",
];

fn stopwords() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| STOPWORDS_RAW.split(' ').collect())
}

fn synonyms() -> &'static HashMap<String, Vec<String>> {
    static MAP: OnceLock<HashMap<String, Vec<String>>> = OnceLock::new();
    MAP.get_or_init(|| {
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        for group in SYNONYM_GROUPS {
            let members: Vec<String> = group.split(' ').map(stem).collect();
            for word in &members {
                let entry = map.entry(word.clone()).or_default();
                for other in &members {
                    if other != word {
                        entry.push(other.clone());
                    }
                }
            }
        }
        map
    })
}

fn family_words(family: &str) -> &'static str {
    match family {
        "ace-agents" => "agent delegate parallel subagent child",
        "ace-browser" => "browser web page website",
        "ace-computer-use" => "computer native app desktop window simulator",
        "ace-threads" => "thread conversation history",
        "visualize" => "visual chart diagram",
        "make-a-suit" => "suit theme look appearance colour color style restyle",
        "ace-market" => "market marketplace publish listing entry draft install",
        _ => "",
    }
}

fn is_doubled_consonant_not_lsz(word: &str) -> bool {
    let bytes = word.as_bytes();
    if bytes.len() < 2 {
        return false;
    }
    let a = bytes[bytes.len() - 2];
    let b = bytes[bytes.len() - 1];
    if a != b {
        return false;
    }
    matches!(
        a,
        b'b' | b'c'
            | b'd'
            | b'f'
            | b'g'
            | b'h'
            | b'j'
            | b'k'
            | b'm'
            | b'n'
            | b'p'
            | b'q'
            | b'r'
            | b't'
            | b'v'
            | b'w'
            | b'x'
            | b'y'
    )
}

/// A light English stemmer: plurals and -ing/-ed, so "clicked", "clicks" and "click" meet.
pub fn stem(word: &str) -> String {
    let mut w = word.to_ascii_lowercase();
    if w.len() > 4 && w.ends_with("ies") {
        w.truncate(w.len() - 3);
        w.push('y');
        return w;
    }
    if w.ends_with("sses") {
        w.truncate(w.len() - 2);
        return w;
    }
    if w.len() > 3
        && (w.ends_with("shes") || w.ends_with("ches") || w.ends_with("xes") || w.ends_with("sses"))
    {
        w.truncate(w.len() - 2);
        return w;
    }
    if w.len() > 3 && w.ends_with('s') && !w.ends_with("ss") && !w.ends_with("us") {
        w.truncate(w.len() - 1);
    }
    for suffix in ["ing", "ed"] {
        if w.len() > suffix.len() + 2 && w.ends_with(suffix) {
            w.truncate(w.len() - suffix.len());
            if is_doubled_consonant_not_lsz(&w) {
                w.truncate(w.len() - 1);
            }
            break;
        }
    }
    w
}

/// The meaningful stems of a text, in order. Snake and camel case split into words.
pub fn words(text: &str) -> Vec<String> {
    let mut split_camel = String::with_capacity(text.len() + 8);
    let mut prev_lower = false;
    for ch in text.chars() {
        if prev_lower && ch.is_ascii_uppercase() {
            split_camel.push(' ');
        }
        split_camel.push(ch.to_ascii_lowercase());
        prev_lower = ch.is_ascii_lowercase();
    }

    let stops = stopwords();
    let mut out = Vec::new();
    for raw in split_camel.split(|ch: char| !ch.is_ascii_lowercase() && !ch.is_ascii_digit()) {
        if raw.len() <= 1 || stops.contains(raw) {
            continue;
        }
        let stemmed = stem(raw);
        if !stops.contains(stemmed.as_str()) {
            out.push(stemmed);
        }
    }
    out
}

/// Property names and descriptions anywhere in a JSON schema, a bounded walk (200 nodes).
fn schema_text(node: &Value, into: &mut Vec<String>, budget: &mut i32) {
    if !matches!(node, Value::Array(_) | Value::Object(_)) {
        return;
    }
    *budget -= 1;
    if *budget < 0 {
        return;
    }
    match node {
        Value::Array(items) => {
            for child in items.iter() {
                schema_text(child, into, budget);
            }
        }
        Value::Object(map) => {
            for (key, value) in map.iter() {
                let key_str = key.as_str();
                if key_str == "properties"
                    && let Value::Object(props) = value
                {
                    for (field, child) in props.iter() {
                        into.push(field.as_str().to_owned());
                        schema_text(child, into, budget);
                    }
                } else if key_str == "description"
                    && let Value::String(desc) = value
                {
                    into.push(desc.as_str().to_owned());
                } else if matches!(value, Value::Array(_) | Value::Object(_)) {
                    schema_text(value, into, budget);
                }
            }
        }
        _ => {}
    }
}

fn index_tool(tool: &SearchableTool) -> HashMap<String, f64> {
    let mut terms: HashMap<String, f64> = HashMap::new();
    let mut add = |text: &str, weight: f64| {
        for word in words(text) {
            let entry = terms.entry(word).or_insert(0.0);
            if weight > *entry {
                *entry = weight;
            }
        }
    };

    let mut schema_parts = Vec::new();
    let mut budget = 200;
    schema_text(&tool.input_schema, &mut schema_parts, &mut budget);
    add(&schema_parts.join(" "), WEIGHT_FIELD);
    if let Some(desc) = tool.description.as_deref() {
        add(desc, WEIGHT_DESCRIPTION);
    }
    if let Some(family) = tool.family.as_deref() {
        let extra = family_words(family);
        add(&format!("{family} {extra}"), WEIGHT_FAMILY);
    }
    if let Some(title) = tool.title.as_deref() {
        add(title, WEIGHT_TITLE);
    }
    add(&tool.name, WEIGHT_NAME);
    terms
}

/// The tools that fit `query`, best first; empty when none share a meaningful word.
pub fn rank_tools<'a>(
    query: &str,
    tools: &'a [SearchableTool],
    options: &SearchOptions<'_>,
) -> Vec<&'a SearchableTool> {
    let candidates: Vec<&'a SearchableTool> = tools
        .iter()
        .filter(|tool| {
            options
                .family
                .is_none_or(|f| tool.family.as_deref() == Some(f))
        })
        .collect();
    let asked: IndexSet<String> = words(query).into_iter().collect();
    if asked.is_empty() || candidates.is_empty() || options.limit == 0 {
        return Vec::new();
    }

    let indexed: Vec<(&'a SearchableTool, HashMap<String, f64>)> = candidates
        .into_iter()
        .map(|tool| (tool, index_tool(tool)))
        .collect();

    let mut frequency: HashMap<&str, usize> = HashMap::new();
    for (_, terms) in &indexed {
        for (term, &weight) in terms {
            if weight >= WEIGHT_DESCRIPTION {
                *frequency.entry(term.as_str()).or_insert(0) += 1;
            }
        }
    }
    let total = indexed.len() as f64;
    let rarity = |term: &str| {
        let freq = frequency.get(term).copied().unwrap_or(0) as f64;
        (1.0 + total / (1.0 + freq)).ln()
    };

    let lowered_query = query.trim().to_ascii_lowercase();
    let exact = bare_tool_name(&lowered_query);
    let syn_map = synonyms();

    let mut scored: Vec<(&'a SearchableTool, f64)> = indexed
        .iter()
        .map(|(tool, terms)| {
            let mut score = 0.0;
            let mut matched = 0usize;
            for word in &asked {
                let direct = terms.get(word).copied().unwrap_or(0.0) * rarity(word);
                let mut related = 0.0_f64;
                if let Some(others) = syn_map.get(word) {
                    for other in others {
                        let candidate = terms.get(other).copied().unwrap_or(0.0)
                            * rarity(other)
                            * SYNONYM_SHARE;
                        if candidate > related {
                            related = candidate;
                        }
                    }
                }
                let best = direct.max(related);
                if best > 0.0 {
                    matched += 1;
                }
                score += best;
            }
            if exact == bare_tool_name(&tool.name) {
                score += 100.0;
            }
            let adjusted = score * (0.5 + (0.5 * matched as f64) / asked.len() as f64);
            (*tool, adjusted)
        })
        .collect();

    let top = scored
        .iter()
        .map(|(_, s)| *s)
        .fold(0.0_f64, |acc, s| acc.max(s));
    let floor = top * RELEVANCE_FLOOR;

    scored.retain(|(_, s)| *s > 0.0 && *s >= floor);
    scored.sort_by(|(ta, sa), (tb, sb)| sb.total_cmp(sa).then_with(|| ta.name.cmp(&tb.name)));
    scored
        .into_iter()
        .take(options.limit)
        .map(|(tool, _)| tool)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_json::Map;

    fn schema(fields: &[(&str, &str)]) -> Value {
        let mut props = Map::with_capacity(fields.len());
        for &(name, desc) in fields {
            let mut entry = Map::with_capacity(2);
            entry.insert("type", Value::from("string"));
            entry.insert("description", Value::from(desc));
            props.insert(name, Value::Object(entry));
        }
        let mut root = Map::with_capacity(2);
        root.insert("type", Value::from("object"));
        root.insert("properties", Value::Object(props));
        Value::Object(root)
    }

    fn catalogue() -> Vec<SearchableTool> {
        let machine = (
            "machine",
            "Another paired machine's browser (machines); omit for this machine.",
        );
        vec![
            SearchableTool {
                name: "screen_apps".to_owned(),
                title: Some("List Mac apps".to_owned()),
                family: Some("ace-computer-use".to_owned()),
                description: Some(
                    "List Mac apps: the running ones, plus installed ones matching query. Pass a name or bundle id to screen_state."
                        .to_owned(),
                ),
                input_schema: schema(&[(
                    "query",
                    "Part of a name or bundle id; also searches installed apps.",
                )]),
            },
            SearchableTool {
                name: "screen_state".to_owned(),
                title: Some("Look at a Mac app".to_owned()),
                family: Some("ace-computer-use".to_owned()),
                description: Some(
                    "Open a Mac app in the background, without taking the person's focus, and read its window as an outline: one numbered element per line. Ids stay the same between calls, so later looks return only what changed. Add screenshot:true when you need to see layout or images. Then act with screen_act. For websites use browser_open."
                        .to_owned(),
                ),
                input_schema: schema(&[
                    ("app", "App name or bundle id, e.g. \"Calculator\" or \"com.apple.TextEdit\"."),
                    ("screenshot", "Also return a picture of the window."),
                ]),
            },
            SearchableTool {
                name: "screen_act".to_owned(),
                title: Some("Act in a Mac app".to_owned()),
                family: Some("ace-computer-use".to_owned()),
                description: Some(
                    "Act in an app in the background, then get what changed. Batch steps that need no look in between. Click by element id; use x,y screenshot pixels only for things missing from the outline. Prefer set_value for fields and menu paths for commands."
                        .to_owned(),
                ),
                input_schema: schema(&[
                    ("app", "App name or bundle id, e.g. \"Calculator\" or \"com.apple.TextEdit\"."),
                    ("actions", "click, type, key, set_value, scroll, menu or activate steps."),
                ]),
            },
            SearchableTool {
                name: "browser_act".to_owned(),
                title: Some("Act on page element".to_owned()),
                family: Some("ace-browser".to_owned()),
                description: Some(
                    "Click, type, press a key, hover, select, check, uncheck, drag, focus, upload, scroll or answer a dialog, using refs from browser_snapshot or browser_find."
                        .to_owned(),
                ),
                input_schema: schema(&[("ref", "An element ref."), machine]),
            },
            SearchableTool {
                name: "browser_logs".to_owned(),
                title: Some("Read console and network".to_owned()),
                family: Some("ace-browser".to_owned()),
                description: Some(
                    "Read recent console messages and network requests, filtered by kind or level."
                        .to_owned(),
                ),
                input_schema: schema(&[
                    ("kind", "Only console messages or only network requests."),
                    machine,
                ]),
            },
            SearchableTool {
                name: "browser_open".to_owned(),
                title: Some("Open browser page".to_owned()),
                family: Some("ace-browser".to_owned()),
                description: Some(
                    "Open or join this thread's ace browser: a real Chromium page the person watches."
                        .to_owned(),
                ),
                input_schema: schema(&[("url", "http(s) URL to load."), machine]),
            },
            SearchableTool {
                name: "browser_tabs".to_owned(),
                title: Some("Browser tabs".to_owned()),
                family: Some("ace-browser".to_owned()),
                description: Some(
                    "List, open, select or close tabs in this thread's browser. list shows who opened and drives each tab and whether a person holds it; current marks yours. open gives you a new labelled tab that becomes your current tab."
                        .to_owned(),
                ),
                input_schema: schema(&[
                    ("action", "list, open, select or close."),
                    ("tabId", "select, close: a tabId from list."),
                    machine,
                ]),
            },
            SearchableTool {
                name: "browser_snapshot".to_owned(),
                title: Some("Read page structure".to_owned()),
                family: Some("ace-browser".to_owned()),
                description: Some(
                    "Read the page as compact indented text: one line per meaningful element."
                        .to_owned(),
                ),
                input_schema: schema(&[
                    (
                        "tabId",
                        "The tab to act in, from browser_tabs or browser_open. Omit for your current tab.",
                    ),
                    machine,
                ]),
            },
            SearchableTool {
                name: "delegate".to_owned(),
                title: Some("Delegate to child agents".to_owned()),
                family: Some("ace-agents".to_owned()),
                description: Some(
                    "Start child agents as their own threads, on any installed provider or a paired machine, for independent or parallel work."
                        .to_owned(),
                ),
                input_schema: schema(&[
                    ("task", "What the child should do."),
                    ("machine", "Run on this machine."),
                ]),
            },
            SearchableTool {
                name: "machines".to_owned(),
                title: Some("List paired machines".to_owned()),
                family: Some("ace-agents".to_owned()),
                description: Some(
                    "Other machines the person paired that let agents in: name, online or offline."
                        .to_owned(),
                ),
                input_schema: schema(&[]),
            },
            SearchableTool {
                name: "note_add".to_owned(),
                title: Some("Save a project note".to_owned()),
                family: Some("ace-threads".to_owned()),
                description: Some(
                    "Remember one short fact about this project for every future thread.".to_owned(),
                ),
                input_schema: schema(&[("text", "One fact.")]),
            },
            SearchableTool {
                name: "context".to_owned(),
                title: Some("Project context".to_owned()),
                family: None,
                description: Some(
                    "Recent threads, changes, PRs, notes and access for this project.".to_owned(),
                ),
                input_schema: schema(&[("topics", "Which parts to read.")]),
            },
        ]
    }

    fn names(
        query: &str,
        tools: &[SearchableTool],
        limit: usize,
        family: Option<&str>,
    ) -> Vec<String> {
        rank_tools(query, tools, &SearchOptions { limit, family })
            .into_iter()
            .map(|t| t.name.clone())
            .collect()
    }

    #[test]
    fn clicking_a_button_in_a_named_mac_app_finds_screen_act_first() {
        let cat = catalogue();
        for query in ["click button in safari", "click a button in Calculator"] {
            assert_eq!(
                names(query, &cat, 5, None).first().map(String::as_str),
                Some("screen_act"),
                "{query}"
            );
        }
    }

    #[test]
    fn opening_or_reading_a_mac_app_finds_screen_state_first() {
        let cat = catalogue();
        for query in [
            "open safari",
            "open Calculator",
            "read the Calculator window",
        ] {
            assert_eq!(
                names(query, &cat, 5, None).first().map(String::as_str),
                Some("screen_state"),
                "{query}"
            );
        }
    }

    #[test]
    fn running_a_task_on_another_machine_finds_delegate_and_machines() {
        let cat = catalogue();
        let mut top2: Vec<String> = names("run task on other machine", &cat, 5, None)
            .into_iter()
            .take(2)
            .collect();
        top2.sort();
        assert_eq!(top2, vec!["delegate", "machines"]);
    }

    #[test]
    fn checking_a_pages_console_finds_browser_logs_first() {
        let cat = catalogue();
        assert_eq!(
            names("check page console", &cat, 5, None)
                .first()
                .map(String::as_str),
            Some("browser_logs")
        );
    }

    #[test]
    fn tab_queries_find_browser_tabs_while_page_structure_finds_snapshot() {
        let cat = catalogue();
        for query in [
            "open a new tab",
            "switch to another tab",
            "close the tabs I opened",
        ] {
            assert_eq!(
                names(query, &cat, 5, None).first().map(String::as_str),
                Some("browser_tabs"),
                "{query}"
            );
        }
        assert_eq!(
            names("read the page structure", &cat, 5, None)
                .first()
                .map(String::as_str),
            Some("browser_snapshot")
        );
    }

    #[test]
    fn stemmed_forms_match_the_same_tool() {
        let cat = catalogue();
        for query in [
            "clicked in the app",
            "clicking in the app",
            "clicks in the app",
        ] {
            assert_eq!(
                names(query, &cat, 5, None).first().map(String::as_str),
                Some("screen_act"),
                "{query}"
            );
        }
    }

    #[test]
    fn family_filter_exact_names_stopwords_and_determinism() {
        let cat = catalogue();
        assert_eq!(
            names("click a button", &cat, 5, Some("ace-browser")),
            vec!["browser_act"]
        );
        assert_eq!(names("machines", &cat, 5, None)[0], "machines");
        assert_eq!(names("browser_open", &cat, 5, None), vec!["browser_open"]);
        for spelled in [
            "mcp__ace__browser_open",
            "ace_browser_open",
            " MCP__ACE__browser_open ",
        ] {
            assert_eq!(
                names(spelled, &cat, 5, None),
                vec!["browser_open"],
                "{spelled}"
            );
        }
        assert!(names("zzz qqq", &cat, 5, None).is_empty());
        assert!(names("the and of", &cat, 5, None).is_empty());

        let first = names("open the page", &cat, 2, None);
        assert!(first.len() <= 2);
        let mut reversed = cat.clone();
        reversed.reverse();
        assert_eq!(names("open the page", &reversed, 2, None), first);
    }
}
