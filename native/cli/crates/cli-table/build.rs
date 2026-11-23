// SPDX-License-Identifier: Apache-2.0
//! Turns `native/cli/table.json` into the Rust static table (ADR 0221 §3), so a run parses no
//! JSON and looks routes up by binary search.

// The build script mirrors the table's JSON shape (one field per fact) and writes it in one pass;
// splitting either would only hide what it does.
#![allow(
    clippy::struct_excessive_bools,
    clippy::too_many_lines,
    reason = "the table's own shape, written once at build time"
)]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{self, Write as _};
use std::fs;
use std::path::Path;

use serde::Deserialize;

fn main() {
    if let Err(error) = generate() {
        eprintln!("cli-table: {error}");
        std::process::exit(1);
    }
}

#[derive(Debug)]
enum BuildError {
    Io(std::io::Error),
    Json(serde_json::Error),
    Data(String),
}

impl fmt::Display for BuildError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "reading table.json: {error}"),
            Self::Json(error) => write!(formatter, "parsing table.json: {error}"),
            Self::Data(message) => formatter.write_str(message),
        }
    }
}

impl From<std::io::Error> for BuildError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for BuildError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    #[serde(default)]
    global_flags: Vec<FlagJson>,
    #[serde(default)]
    commands: Vec<CommandJson>,
    #[serde(default)]
    nouns: Vec<NounJson>,
    #[serde(default)]
    topics: Vec<TopicJson>,
    #[serde(default)]
    exit_codes: Vec<ExitCodeJson>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FlagJson {
    name: String,
    #[serde(default)]
    short: Option<String>,
    #[serde(default)]
    value: Option<String>,
    summary: String,
    #[serde(default)]
    repeat: bool,
    #[serde(default)]
    choices: Vec<String>,
    #[serde(default, rename = "ref")]
    reference: Option<String>,
    #[serde(default)]
    hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArgJson {
    name: String,
    summary: String,
    #[serde(default)]
    required: bool,
    #[serde(default)]
    variadic: bool,
    #[serde(default)]
    stdin: bool,
    #[serde(default, rename = "ref")]
    reference: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AliasJson {
    words: Vec<String>,
    #[serde(default)]
    deprecated_since: Option<String>,
    #[serde(default)]
    insert_words: Vec<String>,
    #[serde(default)]
    words_as: Vec<String>,
    #[serde(default)]
    rename_flags: Vec<(String, String)>,
    #[serde(default)]
    set_flags: Vec<String>,
    #[serde(default)]
    by_flag: Vec<(String, String)>,
    #[serde(default)]
    quiet: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExampleJson {
    command: String,
    summary: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitJson {
    code: u16,
    when: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandJson {
    id: String,
    words: Vec<String>,
    summary: String,
    #[serde(default)]
    description: Option<String>,
    group: String,
    #[serde(default)]
    args: Vec<ArgJson>,
    #[serde(default)]
    flags: Vec<FlagJson>,
    #[serde(default)]
    examples: Vec<ExampleJson>,
    #[serde(default)]
    aliases: Vec<AliasJson>,
    #[serde(default)]
    exits: Vec<ExitJson>,
    #[serde(default)]
    see_also: Vec<String>,
    #[serde(default)]
    output: Option<String>,
    #[serde(default)]
    mutates: bool,
    #[serde(default)]
    offline: bool,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    noun_default: bool,
    #[serde(default)]
    person_only: Option<String>,
    #[serde(default)]
    passthrough: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NounJson {
    name: String,
    summary: String,
    #[serde(default)]
    description: Option<String>,
    group: String,
    #[serde(default)]
    hidden: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TopicJson {
    name: String,
    summary: String,
    text: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExitCodeJson {
    code: u8,
    name: String,
    means: String,
}

fn literal(value: &str) -> String {
    format!("{value:?}")
}

fn literals(values: &[String]) -> String {
    let items: Vec<String> = values.iter().map(|value| literal(value)).collect();
    format!("&[{}]", items.join(", "))
}

fn pairs(values: &[(String, String)]) -> String {
    let items: Vec<String> = values
        .iter()
        .map(|(key, value)| format!("({}, {})", literal(key), literal(value)))
        .collect();
    format!("&[{}]", items.join(", "))
}

fn option(value: Option<&String>) -> String {
    value.map_or_else(
        || "None".to_owned(),
        |text| format!("Some({})", literal(text)),
    )
}

fn flag(flag: &FlagJson) -> String {
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

fn arg(arg: &ArgJson) -> String {
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

fn alias(alias: &AliasJson) -> String {
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

fn ref_kind(name: &str) -> &'static str {
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

fn group(name: &str) -> &'static str {
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

fn person_only(name: Option<&String>) -> String {
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

fn command(command: &CommandJson) -> String {
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

fn generate() -> Result<(), BuildError> {
    let table_path = Path::new("../../table.json");
    println!("cargo:rerun-if-changed=../../table.json");
    let text = fs::read_to_string(table_path)?;
    let table: Table = serde_json::from_str(&text)?;

    let mut out = String::with_capacity(256 * 1024);
    out.push_str("// @generated by cli-table/build.rs from native/cli/table.json. Do not edit.\n");

    let _ = writeln!(
        out,
        "/// One route: the space-joined words, the command they reach, and the alias if any.\n\
         pub struct RouteEntry {{\n    pub key: &'static str,\n    pub command: usize,\n    pub \
         alias: Option<usize>,\n}}\n\n\
         /// The words that may follow a space-joined prefix.\n\
         pub struct NextEntry {{\n    pub prefix: &'static str,\n    pub words: &'static [&'static \
         str],\n}}\n"
    );

    let _ = writeln!(
        out,
        "pub static GLOBAL_FLAGS: &[FlagSpec] = &[{}];\n",
        table
            .global_flags
            .iter()
            .map(flag)
            .collect::<Vec<String>>()
            .join(", ")
    );

    let mut commands = String::new();
    for spec in &table.commands {
        commands.push_str(&command(spec));
        commands.push_str(",\n");
    }
    let _ = writeln!(
        out,
        "pub static COMMANDS: &[CommandSpec] = &[\n{commands}];\n"
    );

    let mut nouns = String::new();
    for noun in &table.nouns {
        let _ = writeln!(
            nouns,
            "NounSpec {{ name: {}, summary: {}, description: {}, group: {}, hidden: {} }},",
            literal(&noun.name),
            literal(&noun.summary),
            option(noun.description.as_ref()),
            group(&noun.group),
            noun.hidden,
        );
    }
    let _ = writeln!(out, "pub static NOUNS: &[NounSpec] = &[\n{nouns}];\n");

    let mut topics = String::new();
    for topic in &table.topics {
        let _ = writeln!(
            topics,
            "TopicSpec {{ name: {}, summary: {}, text: {} }},",
            literal(&topic.name),
            literal(&topic.summary),
            literal(&topic.text),
        );
    }
    let _ = writeln!(out, "pub static TOPICS: &[TopicSpec] = &[\n{topics}];\n");

    let mut exits = String::new();
    for exit in &table.exit_codes {
        let _ = writeln!(
            exits,
            "ExitCodeMeaning {{ code: {}, name: {}, means: {} }},",
            exit.code,
            literal(&exit.name),
            literal(&exit.means),
        );
    }
    let _ = writeln!(
        out,
        "pub static EXIT_CODES: &[ExitCodeMeaning] = &[\n{exits}];\n"
    );

    // Every route, then sorted by key for lookup. A key claimed twice fails the build, as the
    // TypeScript table's own index does.
    let mut routes: Vec<(String, usize, Option<usize>)> = Vec::new();
    let mut seen_routes: BTreeMap<String, String> = BTreeMap::new();
    let mut by_id: BTreeSet<String> = BTreeSet::new();
    let mut claim = |key: String,
                     command: &str,
                     index: usize,
                     alias: Option<usize>|
     -> Result<(), BuildError> {
        if let Some(taken) = seen_routes.get(&key) {
            return Err(BuildError::Data(format!(
                "{key:?} reaches both {taken} and {command}"
            )));
        }
        seen_routes.insert(key.clone(), command.to_owned());
        routes.push((key, index, alias));
        Ok(())
    };
    for (index, spec) in table.commands.iter().enumerate() {
        if !by_id.insert(spec.id.clone()) {
            return Err(BuildError::Data(format!("two commands are {}", spec.id)));
        }
        claim(spec.words.join(" "), &spec.id, index, None)?;
        for (alias_index, alias) in spec.aliases.iter().enumerate() {
            claim(alias.words.join(" "), &spec.id, index, Some(alias_index))?;
        }
    }
    for (index, spec) in table.commands.iter().enumerate() {
        if spec.noun_default && spec.words.len() > 1 {
            claim(
                spec.words[..spec.words.len() - 1].join(" "),
                &spec.id,
                index,
                None,
            )?;
        }
    }
    routes.sort_by(|left, right| left.0.cmp(&right.0));

    let mut route_code = String::new();
    for (key, command, alias) in &routes {
        let alias = alias.map_or_else(|| "None".to_owned(), |index| format!("Some({index})"));
        let _ = writeln!(
            route_code,
            "RouteEntry {{ key: {}, command: {command}, alias: {alias} }},",
            literal(key)
        );
    }
    let _ = writeln!(
        out,
        "pub static ROUTES: &[RouteEntry] = &[\n{route_code}];\n"
    );

    let mut by_id_code = String::new();
    for id in &by_id {
        let index = table
            .commands
            .iter()
            .position(|spec| &spec.id == id)
            .ok_or_else(|| BuildError::Data(format!("missing command {id}")))?;
        let _ = writeln!(by_id_code, "({}, {index}),", literal(id));
    }
    let _ = writeln!(
        out,
        "pub static BY_ID: &[(&str, usize)] = &[\n{by_id_code}];\n"
    );

    // Prefix → the words that may follow, sorted and deduplicated.
    let mut next: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (key, _, _) in &routes {
        if key.is_empty() {
            continue;
        }
        let words: Vec<&str> = key.split(' ').collect();
        for (position, word) in words.iter().enumerate() {
            let prefix = words[..position].join(" ");
            next.entry(prefix).or_default().insert((*word).to_owned());
        }
    }
    let mut next_code = String::new();
    for (prefix, words) in &next {
        let words: Vec<String> = words.iter().map(|word| literal(word)).collect();
        let _ = writeln!(
            next_code,
            "NextEntry {{ prefix: {}, words: &[{}] }},",
            literal(prefix),
            words.join(", ")
        );
    }
    let _ = writeln!(out, "pub static NEXT: &[NextEntry] = &[\n{next_code}];\n");

    let out_dir = std::env::var("OUT_DIR")
        .map_err(|error| BuildError::Data(format!("OUT_DIR isn't set: {error}")))?;
    fs::write(Path::new(&out_dir).join("table_data.rs"), out)?;
    Ok(())
}
