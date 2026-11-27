// SPDX-License-Identifier: Apache-2.0
//! `ace help --json`: every visible command, the global flags and the help topics, as the
//! `CliCommandTree` schema in `@ace/protocol/cli-output` describes them. Pure.

use cli_table::{CommandSpec, FlagSpec};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FlagJson<'a> {
    name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    short: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<&'a str>,
    summary: &'a str,
    repeat: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    choices: Option<&'a [&'a str]>,
}

#[derive(Serialize)]
struct ArgumentJson<'a> {
    name: &'a str,
    summary: &'a str,
    required: bool,
    variadic: bool,
    stdin: bool,
}

#[derive(Serialize)]
struct ExampleJson<'a> {
    command: &'a str,
    summary: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AliasJson<'a> {
    words: &'a [&'a str],
    #[serde(skip_serializing_if = "Option::is_none")]
    deprecated_since: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandJson<'a> {
    id: &'a str,
    words: &'a [&'a str],
    summary: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<&'a str>,
    group: &'a str,
    arguments: Vec<ArgumentJson<'a>>,
    flags: Vec<FlagJson<'a>>,
    examples: Vec<ExampleJson<'a>>,
    aliases: Vec<AliasJson<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<&'a str>,
    mutates: bool,
    offline: bool,
}

#[derive(Serialize)]
struct TopicJson<'a> {
    name: &'a str,
    summary: &'a str,
}

#[derive(Serialize)]
struct ExitCodeJson<'a> {
    code: u8,
    name: &'a str,
    means: &'a str,
}

/// `ace help --json`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tree<'a> {
    version: &'a str,
    global_flags: Vec<FlagJson<'a>>,
    commands: Vec<CommandJson<'a>>,
    topics: Vec<TopicJson<'a>>,
    exit_codes: Vec<ExitCodeJson<'a>>,
}

/// `{ "help": "…" }`, the answer for a topic or noun page asked as JSON.
#[derive(Serialize)]
pub struct TextValue<'a> {
    pub help: &'a str,
}

fn flag_json(flag: &'static FlagSpec) -> FlagJson<'static> {
    FlagJson {
        name: flag.name,
        short: flag.short,
        value: flag.value,
        summary: flag.summary,
        repeat: flag.repeat,
        choices: if flag.choices.is_empty() {
            None
        } else {
            Some(flag.choices)
        },
    }
}

/// One command as `help --json` describes it.
#[must_use]
pub fn command_json(command: &'static CommandSpec) -> CommandJson<'static> {
    CommandJson {
        id: command.id,
        words: command.words,
        summary: command.summary,
        description: command.description,
        group: command.group.name(),
        arguments: command
            .args
            .iter()
            .map(|arg| ArgumentJson {
                name: arg.name,
                summary: arg.summary,
                required: arg.required,
                variadic: arg.variadic,
                stdin: arg.stdin,
            })
            .collect(),
        flags: command
            .flags
            .iter()
            .filter(|flag| !flag.hidden)
            .map(|flag| flag_json(flag))
            .collect(),
        examples: command
            .examples
            .iter()
            .map(|example| ExampleJson {
                command: example.command,
                summary: example.summary,
            })
            .collect(),
        aliases: command
            .aliases
            .iter()
            .filter(|alias| !alias.quiet)
            .map(|alias| AliasJson {
                words: alias.words,
                deprecated_since: alias.deprecated_since,
            })
            .collect(),
        output: command.output,
        mutates: command.mutates,
        offline: command.offline,
    }
}

/// `ace help --json`: everything an agent needs to call ace without reading prose.
#[must_use]
pub fn tree(version: &str) -> Tree<'_> {
    Tree {
        version,
        global_flags: cli_table::global_flags()
            .iter()
            .filter(|flag| !flag.hidden)
            .map(|flag| flag_json(flag))
            .collect(),
        commands: cli_table::commands()
            .iter()
            .filter(|command| !command.hidden)
            .map(|command| command_json(command))
            .collect(),
        topics: cli_table::topics()
            .iter()
            .map(|topic| TopicJson {
                name: topic.name,
                summary: topic.summary,
            })
            .collect(),
        exit_codes: cli_table::exit_codes()
            .iter()
            .map(|exit| ExitCodeJson {
                code: exit.code,
                name: exit.name,
                means: exit.means,
            })
            .collect(),
    }
}
