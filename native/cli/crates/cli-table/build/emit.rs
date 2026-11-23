// SPDX-License-Identifier: Apache-2.0
//! Writing the table's Rust literals.

use crate::table_json::{AliasJson, ArgJson, CommandJson, FlagJson};

pub(crate) fn literal(value: &str) -> String {
    format!("{value:?}")
}

pub(crate) fn literals(values: &[String]) -> String {
    let items: Vec<String> = values.iter().map(|value| literal(value)).collect();
    format!("&[{}]", items.join(", "))
}

pub(crate) fn pairs(values: &[(String, String)]) -> String {
    let items: Vec<String> = values
        .iter()
        .map(|(key, value)| format!("({}, {})", literal(key), literal(value)))
        .collect();
    format!("&[{}]", items.join(", "))
}

pub(crate) fn option(value: Option<&String>) -> String {
    value.map_or_else(
        || "None".to_owned(),
        |text| format!("Some({})", literal(text)),
    )
}

pub(crate) fn flag(flag: &FlagJson) -> String {
    let reference = flag.reference.as_deref().map_or_else(
        || "None".to_owned(),
        |name| format!("Some(RefKind::{})", ref_kind(name)),
    );
    format!(
        "FlagSpec {{ name: {}, short: {}, value: {}, summary: {}, repeat: {}, choices: {}, \
         reference: {reference}, hidden: {} }}",
        literal(&flag.name),
        option(flag.short.as_ref()),
        option(flag.value.as_ref()),
        literal(&flag.summary),
        flag.repeat,
        literals(&flag.choices),
        flag.hidden,
    )
}

pub(crate) fn arg(arg: &ArgJson) -> String {
    let reference = arg.reference.as_deref().map_or_else(
        || "None".to_owned(),
        |name| format!("Some(RefKind::{})", ref_kind(name)),
    );
    format!(
        "ArgSpec {{ name: {}, summary: {}, required: {}, variadic: {}, stdin: {}, reference: \
         {reference} }}",
        literal(&arg.name),
        literal(&arg.summary),
        arg.required,
        arg.variadic,
        arg.stdin,
    )
}

pub(crate) fn alias(alias: &AliasJson) -> String {
    format!(
        "AliasSpec {{ words: {}, deprecated_since: {}, insert_words: {}, words_as: {}, \
         rename_flags: {}, set_flags: {}, by_flag: {}, quiet: {} }}",
        literals(&alias.words),
        option(alias.deprecated_since.as_ref()),
        literals(&alias.insert_words),
        literals(&alias.words_as),
        pairs(&alias.rename_flags),
        literals(&alias.set_flags),
        pairs(&alias.by_flag),
        alias.quiet,
    )
}

pub(crate) fn ref_kind(name: &str) -> &'static str {
    match name {
        "thread" => "Thread",
        "project" => "Project",
        "request" => "Request",
        "bot" => "Bot",
        other => {
            // Fail the build rather than write data the parser can't understand.
            eprintln!("cli-table: unknown ref kind {other:?}");
            std::process::exit(1);
        }
    }
}

pub(crate) fn group(name: &str) -> &'static str {
    match name {
        "basics" => "Group::Basics",
        "work" => "Group::Work",
        "machine" => "Group::Machine",
        "providers" => "Group::Providers",
        "spade-market" => "Group::SpadeMarket",
        "agent-tools" => "Group::AgentTools",
        other => {
            eprintln!("cli-table: unknown group {other:?}");
            std::process::exit(1);
        }
    }
}

pub(crate) fn person_only(name: Option<&String>) -> String {
    name.map_or_else(
        || "None".to_owned(),
        |name| match name.as_str() {
            "answer" => "Some(PersonOnly::Answer)".to_owned(),
            "setting" => "Some(PersonOnly::Setting)".to_owned(),
            "install" => "Some(PersonOnly::Install)".to_owned(),
            other => {
                eprintln!("cli-table: unknown personOnly {other:?}");
                std::process::exit(1);
            }
        },
    )
}

pub(crate) fn command(command: &CommandJson) -> String {
    let args: Vec<String> = command.args.iter().map(arg).collect();
    let flags: Vec<String> = command.flags.iter().map(flag).collect();
    let examples: Vec<String> = command
        .examples
        .iter()
        .map(|example| {
            format!(
                "Example {{ command: {}, summary: {} }}",
                literal(&example.command),
                literal(&example.summary)
            )
        })
        .collect();
    let aliases: Vec<String> = command.aliases.iter().map(alias).collect();
    let exits: Vec<String> = command
        .exits
        .iter()
        .map(|exit| {
            format!(
                "ExitSpec {{ code: {}, when: {} }}",
                exit.code,
                literal(&exit.when)
            )
        })
        .collect();
    format!(
        r"CommandSpec {{
    id: {},
    words: {},
    summary: {},
    description: {},
    group: {},
    args: &[{}],
    flags: &[{}],
    examples: &[{}],
    aliases: &[{}],
    exits: &[{}],
    see_also: {},
    output: {},
    mutates: {},
    offline: {},
    hidden: {},
    noun_default: {},
    person_only: {},
    passthrough: {},
}}",
        literal(&command.id),
        literals(&command.words),
        literal(&command.summary),
        option(command.description.as_ref()),
        group(&command.group),
        args.join(", "),
        flags.join(", "),
        examples.join(", "),
        aliases.join(", "),
        exits.join(", "),
        literals(&command.see_also),
        option(command.output.as_ref()),
        command.mutates,
        command.offline,
        command.hidden,
        command.noun_default,
        person_only(command.person_only.as_ref()),
        command.passthrough,
    )
}
