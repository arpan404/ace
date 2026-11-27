// SPDX-License-Identifier: Apache-2.0
//! `ace help` pages, from the static command table (ADR 0178 §5). Pure: table in, text out.

use cli_out::{ErrorCode, Failure};
use cli_table::{CommandSpec, Group, NounSpec};

use crate::pages::{
    columns, command_page, exit_codes_page, global_flags_page, topics_page, usage_line,
};

/// The one-line shortcuts at the top of `ace help` (kept with the page code, as in TypeScript).
const SHORTCUTS: &[(&str, &str)] = &[
    ("ace", "The interactive home, on a terminal"),
    ("ace run PROMPT", "Start an agent in this folder"),
    ("ace status", "What runs and what needs you"),
    ("ace open [PATH]", "Open a project in the app"),
    ("ace login", "Sign this machine in to ace"),
];

/// What `ace help WORDS…` answers: a page of text, and the command it is about, if any.
pub struct Answer {
    pub text: String,
    pub command: Option<&'static CommandSpec>,
}

/// Pure. Unknown words are a usage error with the nearest command or topic.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn help_for(words: &[&str]) -> Result<Answer, Failure<'static>> {
    if words.is_empty() {
        return Ok(Answer {
            text: overview(),
            command: None,
        });
    }
    let key = words.join(" ");
    if key == "topics" {
        return Ok(Answer {
            text: topics_page(),
            command: None,
        });
    }
    if key == "flags" {
        return Ok(Answer {
            text: global_flags_page(),
            command: None,
        });
    }
    let topic_name = if key == "market-maintainer" {
        "store-maintainer"
    } else {
        &key
    };
    if let Some(topic) = cli_table::topics()
        .iter()
        .find(|item| item.name == topic_name)
    {
        return Ok(Answer {
            text: if topic.name == "exit-codes" {
                exit_codes_page()
            } else {
                topic.text.to_owned()
            },
            command: None,
        });
    }
    let route = cli_table::route(&key);
    // A noun, or a prefix like `store maintainer`, lists what's under it.
    if cli_table::has_next(&key) {
        let canonical: Vec<&str> = if words[0] == "market" {
            std::iter::once("store")
                .chain(words[1..].iter().copied())
                .collect()
        } else {
            words.to_vec()
        };
        return Ok(Answer {
            text: noun_page(&canonical),
            command: None,
        });
    }
    if let Some(route) = route {
        return Ok(Answer {
            text: command_page(route.command),
            command: Some(route.command),
        });
    }
    let candidates = cli_table::route_keys()
        .chain(cli_table::topics().iter().map(|topic| topic.name))
        .filter(|candidate| candidate.split(' ').count() == words.len());
    let suggestion = cli_parse::nearest(&key, candidates);
    let hint = suggestion.map_or_else(
        || "See every command with ace help.".to_owned(),
        |suggestion| format!("Did you mean ace help {suggestion}?"),
    );
    Err(Failure::usage(format!("There's no help for {key}."))
        .with_code(ErrorCode::UnknownCommand)
        .with_hint(hint)
        .with_command("help"))
}

/// `ace help`: every noun and top-level command, on one screen.
#[must_use]
pub fn overview() -> String {
    let mut lines = vec![
        "ace runs your coding agents on this machine.".to_owned(),
        String::new(),
    ];
    let shortcuts: Vec<(String, String)> = SHORTCUTS
        .iter()
        .map(|(command, summary)| ((*command).to_owned(), (*summary).to_owned()))
        .collect();
    lines.extend(columns(&shortcuts, 2));
    lines.push(String::new());
    let groups = [
        Group::Work,
        Group::Machine,
        Group::Providers,
        Group::SpadeMarket,
        Group::AgentTools,
    ];
    let rows: Vec<(String, String)> = groups
        .iter()
        .map(|group| {
            let mut words: Vec<&str> = Vec::new();
            for noun in cli_table::nouns() {
                if noun.group == *group && !noun.hidden && !words.contains(&noun.name) {
                    words.push(noun.name);
                }
            }
            for command in cli_table::commands() {
                if command.group == *group
                    && !command.hidden
                    && command.words.len() == 1
                    && !words.contains(&command.words[0])
                {
                    words.push(command.words[0]);
                }
            }
            (group_title(*group).to_owned(), words.join(" · "))
        })
        .collect();
    lines.extend(columns(&rows, 0));
    lines.push(String::new());
    lines.push("ace help COMMAND for more. ace help topics for guides.".to_owned());
    lines.join("\n")
}

/// Every command under a noun (`ace help thread`), each with its one line.
#[must_use]
pub fn noun_page(words: &[&str]) -> String {
    let prefix = words.join(" ");
    let noun = cli_table::nouns().iter().find(|item| item.name == prefix);
    let list: Vec<&'static CommandSpec> = cli_table::commands()
        .iter()
        .filter(|command| {
            !command.hidden
                && command.words.len() > words.len()
                && command.words[..words.len()].join(" ") == prefix
        })
        .collect();
    let mut lines = vec![
        format!(
            "ace {prefix}{}",
            noun.map_or_else(String::new, |noun: &NounSpec| format!(": {}", noun.summary))
        ),
        String::new(),
    ];
    let rows: Vec<(String, String)> = list
        .iter()
        .map(|command| (usage_line(command), command.summary.to_owned()))
        .collect();
    lines.extend(columns(&rows, 2));
    if let Some(own) = cli_table::commands()
        .iter()
        .find(|command| command.words.join(" ") == prefix)
        && !own.hidden
    {
        let page = command_page(own);
        let mut first: Vec<String> = page.split('\n').map(str::to_owned).collect();
        first.push(String::new());
        first.extend(lines);
        lines = first;
    }
    let mut shortcuts: Vec<String> = Vec::new();
    for command in &list {
        for alias in command.aliases {
            if alias.deprecated_since.is_none() && !alias.quiet {
                shortcuts.push(format!(
                    "ace {} is ace {}",
                    alias.words.join(" "),
                    command.words.join(" ")
                ));
            }
        }
    }
    if !shortcuts.is_empty() {
        lines.push(String::new());
        lines.push(format!("Shortcuts: {}.", shortcuts.join("; ")));
    }
    if let Some(description) = noun.and_then(|noun| noun.description) {
        lines.push(String::new());
        lines.push(description.to_owned());
    }
    if prefix == "store" {
        lines.push(String::new());
        lines.push("Maintainer tools: ace help store-maintainer".to_owned());
    }
    lines.push(String::new());
    lines.push(format!("ace help {prefix} COMMAND for one command."));
    lines.join("\n")
}

fn group_title(group: Group) -> &'static str {
    match group {
        Group::Basics => "Start",
        Group::Work => "Work",
        Group::Machine => "This machine",
        Group::Providers => "Providers and access",
        Group::SpadeMarket => "Spade and the Store",
        Group::AgentTools => "Agent tools",
    }
}
