//! What of an accepted plugin a bot can use (ADR 0151, point 10), and what it can't with why.
//! Pure: from the daemon's `plugins.spade` answer alone.

use std::collections::BTreeMap;

use serde::Serialize;
use spade_ace::plugins::{Execution, KnownExecution, SpadePlugin};
use spade_core::hooks;

/// A rule joined to the standing instructions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub plugin: String,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hook {
    pub plugin: String,
    pub event: String,
    pub command: String,
    pub matcher: Option<String>,
}

/// A local MCP server, as accepted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalServer {
    pub plugin: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// A remote MCP server: offered like a connector the person adds by URL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RemoteServer {
    pub name: String,
    pub url: String,
}

/// Something of a plugin Spade does not use, with why, for the bot's settings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NotUsed {
    pub what: String,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Usable {
    pub rules: Vec<Rule>,
    /// Skills (a bot loads them) and commands (manual skills only the person starts), for the
    /// skill store.
    pub skills: Vec<crate::skill_store::PluginSkill>,
    /// Agents, as helper profiles (ADR 0152).
    pub profiles: Vec<spade_core::helper::Profile>,
    pub hooks: Vec<Hook>,
    pub local: Vec<LocalServer>,
    pub remote: Vec<RemoteServer>,
    pub not_used: Vec<NotUsed>,
}

/// What a bot can use of `plugin`. `cli` is a bot on a CLI brain (ADR 0133): its CLI runs its
/// own MCP servers and hooks, so it gets only rules.
pub fn usable(plugin: &SpadePlugin, cli: bool) -> Usable {
    let name = &plugin.install.name;
    let mut out = Usable::default();
    for component in &plugin.components {
        let what = format!("{} {}", component.kind, component.name);
        match component.kind.as_str() {
            "rule" => match (&component.text, selectors(component.text.as_deref())) {
                (None, _) => out.not_used.push(NotUsed {
                    what,
                    reason: component
                        .omitted
                        .clone()
                        .unwrap_or_else(|| "Its text did not arrive.".to_owned()),
                }),
                (Some(_), true) => out.not_used.push(NotUsed {
                    what,
                    reason: "It applies only to some files, and Spade has no files to match it \
to."
                    .to_owned(),
                }),
                (Some(text), false) => out.rules.push(Rule {
                    plugin: name.clone(),
                    name: component.name.clone(),
                    text: body(text).trim().to_owned(),
                }),
            },
            "skill" | "command" => match &component.text {
                Some(text) => out.skills.push(crate::skill_store::PluginSkill {
                    plugin: name.clone(),
                    name: component.name.clone(),
                    description: component.description.clone(),
                    text: text.clone(),
                    manual: component.kind == "command",
                    folder: skill_folder(&component.path),
                    files: if component.kind == "skill" {
                        component.files.clone()
                    } else {
                        Vec::new()
                    },
                }),
                None => out.not_used.push(NotUsed {
                    what,
                    reason: component
                        .omitted
                        .clone()
                        .unwrap_or_else(|| "Its text did not arrive.".to_owned()),
                }),
            },
            "agent" => match &component.text {
                Some(text) => out.profiles.push(profile(component, text)),
                None => out.not_used.push(NotUsed {
                    what,
                    reason: component
                        .omitted
                        .clone()
                        .unwrap_or_else(|| "Its text did not arrive.".to_owned()),
                }),
            },
            other => out.not_used.push(NotUsed {
                what,
                reason: format!("Spade has nothing to use a {other} for."),
            }),
        }
    }
    for execution in &plugin.executions {
        let Execution::Known(execution) = execution else {
            out.not_used.push(NotUsed {
                what: "something to run".to_owned(),
                reason: "This Spade doesn't know what it is.".to_owned(),
            });
            continue;
        };
        match execution {
            KnownExecution::Hook { event, .. } | KnownExecution::Stdio { name: event, .. }
                if cli =>
            {
                out.not_used.push(NotUsed {
                    what: match execution {
                        KnownExecution::Hook { .. } => format!("hook at {event}"),
                        _ => format!("server {event}"),
                    },
                    reason: "This bot runs on a subscription; its CLI runs the plugin's servers \
and hooks itself."
                        .to_owned(),
                });
            }
            KnownExecution::Hook {
                event,
                command,
                matcher,
            } => {
                if hooks::EVENTS.contains(&event.as_str()) {
                    out.hooks.push(Hook {
                        plugin: name.clone(),
                        event: event.clone(),
                        command: command.clone(),
                        matcher: matcher.clone(),
                    });
                } else {
                    out.not_used.push(NotUsed {
                        what: format!("hook at {event}"),
                        reason: format!("Spade has no {event} event."),
                    });
                }
            }
            KnownExecution::Stdio {
                name: server,
                command,
                args,
                env,
                ..
            } => out.local.push(LocalServer {
                plugin: name.clone(),
                name: server.clone(),
                command: command.clone(),
                args: args.clone(),
                env: env.clone(),
            }),
            KnownExecution::Remote {
                name: server,
                url,
                headers,
                ..
            } => {
                if cli {
                    out.not_used.push(NotUsed {
                        what: format!("server {server}"),
                        reason: "This bot runs on a subscription; its CLI connects to the \
plugin's servers itself."
                            .to_owned(),
                    });
                } else {
                    if !headers.is_empty() {
                        out.not_used.push(NotUsed {
                            what: format!("headers of server {server}"),
                            reason: "A server added as a connector signs in on its own; the \
plugin's headers are not sent."
                                .to_owned(),
                        });
                    }
                    out.remote.push(RemoteServer {
                        name: server.clone(),
                        url: url.clone(),
                    });
                }
            }
        }
    }
    for line in &plugin.unsupported {
        out.not_used.push(NotUsed {
            what: line.clone(),
            reason: "ace could not use it either.".to_owned(),
        });
    }
    out
}

/// A plugin agent as a helper profile: its text (without frontmatter) is the instructions, a
/// `tools` list in its frontmatter narrows the tools (never past what every helper is denied),
/// and a `model` is kept for the engine, which uses it only when the person has that model.
fn profile(component: &spade_ace::plugins::Component, text: &str) -> spade_core::helper::Profile {
    let front = frontmatter(text).unwrap_or("");
    let about = match component.description.trim() {
        "" => field(front, "description").unwrap_or_default(),
        description => description.to_owned(),
    };
    spade_core::helper::Profile {
        name: component.name.clone(),
        about: about
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(200)
            .collect(),
        instructions: body(text).trim().to_owned(),
        reads_only: false,
        tools: tool_list(front),
        model: field(front, "model").filter(|m| !m.is_empty() && m != "inherit"),
    }
}

/// A frontmatter field's value on its own line, unquoted.
fn field(front: &str, key: &str) -> Option<String> {
    front.lines().find_map(|line| {
        let value = line.strip_prefix(key)?.strip_prefix(':')?;
        Some(unquote(value.trim()).to_owned())
    })
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
        .unwrap_or(value)
}

/// The `tools` frontmatter field: `a, b`, `[a, b]` or one `- a` per line below it. `None` when
/// absent or empty, which narrows nothing.
fn tool_list(front: &str) -> Option<Vec<String>> {
    let mut lines = front.lines();
    lines.find(|line| line.starts_with("tools:"))?;
    let inline = field(front, "tools").unwrap_or_default();
    let inline = inline.trim_start_matches('[').trim_end_matches(']');
    let mut tools: Vec<String> = inline
        .split(',')
        .map(|t| unquote(t.trim()).to_owned())
        .filter(|t| !t.is_empty())
        .collect();
    if tools.is_empty() {
        tools = lines
            .map_while(|line| line.trim_start().strip_prefix("- "))
            .map(|t| unquote(t.trim()).to_owned())
            .filter(|t| !t.is_empty())
            .collect();
    }
    (!tools.is_empty()).then_some(tools)
}

/// A skill's folder in the plugin, from its SKILL.md's path.
fn skill_folder(path: &str) -> String {
    path.strip_suffix("/SKILL.md").unwrap_or("").to_owned()
}

/// Whether a rule's frontmatter limits it to some files: `globs`, or not `alwaysApply: true`
/// (the same test ace uses for every CLI but Cursor).
fn selectors(text: Option<&str>) -> bool {
    let Some(front) = text.and_then(frontmatter) else {
        return false;
    };
    front
        .lines()
        .any(|line| line.trim_start().starts_with("globs:"))
        || !front.lines().any(|line| line.trim() == "alwaysApply: true")
}

fn frontmatter(text: &str) -> Option<&str> {
    let rest = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// A rule's text without its frontmatter.
fn body(text: &str) -> &str {
    let Some(front) = frontmatter(text) else {
        return text;
    };
    let start = text.find(front).unwrap_or(0) + front.len();
    let rest = &text[start..];
    let rest = rest.strip_prefix("\n---").unwrap_or(rest);
    rest.strip_prefix("\r\n")
        .or_else(|| rest.strip_prefix('\n'))
        .unwrap_or(rest)
}

/// The rules of every plugin a bot has, as its standing instructions read them: under each
/// rule's name, in plugin and name order.
pub fn rules_text(rules: &[Rule]) -> String {
    let mut rules: Vec<&Rule> = rules.iter().collect();
    rules.sort_by(|a, b| (&a.plugin, &a.name).cmp(&(&b.plugin, &b.name)));
    if rules.is_empty() {
        return String::new();
    }
    let mut out = String::from("Rules from the person's plugins:");
    for rule in rules {
        out.push_str(&format!(
            "\n\n<rule plugin=\"{}\" name=\"{}\">\n{}\n</rule>",
            rule.plugin, rule.name, rule.text
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn plugin(components: serde_json::Value, executions: serde_json::Value) -> SpadePlugin {
        serde_json::from_value(json!({
            "install": {"name": "style", "version": "1", "commit": "c", "hash": "h", "acceptedAt": 1},
            "enabled": true, "root": "/r", "components": components, "executions": executions,
            "unsupported": ["style: lsp server"],
        }))
        .unwrap_or_else(|error| panic!("{error}"))
    }

    #[test]
    fn rules_without_selectors_join_in_plugin_and_name_order_and_others_say_why_not() {
        let style = plugin(
            json!([
                {"kind": "rule", "name": "tabs", "text": "---\nalwaysApply: true\n---\nUse tabs.\n"},
                {"kind": "rule", "name": "docs", "text": "Write docs."},
                {"kind": "rule", "name": "ts", "text": "---\nglobs: \"*.ts\"\n---\nStrict TS."},
                {"kind": "rule", "name": "huge", "omitted": "Too large to send with the plugin."},
            ]),
            json!([]),
        );
        let usable = usable(&style, false);
        let text = rules_text(&usable.rules);
        assert!(text.find("name=\"docs\"") < text.find("name=\"tabs\""));
        assert!(text.contains("Use tabs.") && !text.contains("alwaysApply"));
        assert!(!text.contains("Strict TS."));
        let reasons: Vec<&str> = usable.not_used.iter().map(|n| n.what.as_str()).collect();
        assert_eq!(reasons, ["rule ts", "rule huge", "style: lsp server"]);
    }

    #[test]
    fn an_agent_becomes_a_profile_whose_frontmatter_names_its_tools_and_model() {
        let style = plugin(
            json!([
                {"kind": "agent", "name": "reviewer", "path": "agents/reviewer.md",
                 "description": "Reviews diffs",
                 "text": "---\nname: reviewer\ntools: lookup, \"note\"\nmodel: fake/m\n---\nReview the diff.\n"},
                {"kind": "agent", "name": "listed", "path": "agents/listed.md", "description": "",
                 "text": "---\ndescription: Lists things\ntools:\n  - lookup\nmodel: inherit\n---\nList.\n"},
                {"kind": "agent", "name": "plain", "path": "agents/plain.md", "description": "d",
                 "text": "Just do it."},
            ]),
            json!([]),
        );
        let profiles = usable(&style, false).profiles;
        assert_eq!(profiles[0].instructions, "Review the diff.");
        assert_eq!(profiles[0].about, "Reviews diffs");
        assert_eq!(
            profiles[0].tools,
            Some(vec!["lookup".into(), "note".into()])
        );
        assert_eq!(profiles[0].model.as_deref(), Some("fake/m"));
        assert_eq!(profiles[1].tools, Some(vec!["lookup".into()]));
        assert_eq!(
            (profiles[1].about.as_str(), profiles[1].model.as_deref()),
            ("Lists things", None)
        );
        assert_eq!(
            (
                profiles[2].tools.as_ref(),
                profiles[2].instructions.as_str()
            ),
            (None, "Just do it.")
        );
    }

    #[test]
    fn hooks_at_events_spade_has_are_used_and_a_cli_bot_gets_only_rules() {
        let style = plugin(
            json!([{"kind": "rule", "name": "tabs", "text": "Use tabs."}]),
            json!([
                {"kind": "hook", "event": "PreToolUse", "command": "guard", "matcher": "shell"},
                {"kind": "hook", "event": "Notification", "command": "ping"},
                {"kind": "stdio", "name": "lint", "command": "node", "args": [], "env": {}},
                {"kind": "remote", "name": "docs", "type": "http", "url": "https://d.example/mcp", "headers": {}},
            ]),
        );
        let full = usable(&style, false);
        assert_eq!(full.hooks.len(), 1);
        assert_eq!(full.local.len(), 1);
        assert_eq!(full.remote[0].url, "https://d.example/mcp");
        assert!(
            full.not_used
                .iter()
                .any(|n| n.reason.contains("no Notification event"))
        );
        let cli = usable(&style, true);
        assert_eq!(cli.rules.len(), 1);
        assert!(cli.hooks.is_empty() && cli.local.is_empty() && cli.remote.is_empty());
    }
}
