// SPDX-License-Identifier: Apache-2.0
//! The help pages' text: one command, the global flags, the exit codes, and their columns.

use cli_table::{ArgSpec, CommandSpec, FlagSpec};

/// One command: usage, what it does, arguments, flags, examples, exit codes, other names.
#[must_use]
pub fn command_page(command: &CommandSpec) -> String {
    let mut lines = vec![
        usage_line(command),
        String::new(),
        sentence(command.summary),
    ];
    if let Some(description) = command.description {
        lines.extend(paragraphs(description));
    }
    let args = command.args;
    if !args.is_empty() {
        let rows: Vec<(String, String)> = args
            .iter()
            .map(|arg| (arg.name.to_owned(), arg.summary.to_owned()))
            .collect();
        lines.push(String::new());
        lines.push("Arguments".to_owned());
        lines.extend(columns(&rows, 2));
    }
    let flags: Vec<&FlagSpec> = command.flags.iter().filter(|flag| !flag.hidden).collect();
    if !flags.is_empty() {
        let rows: Vec<(String, String)> = flags
            .iter()
            .map(|flag| (flag_label(flag), flag.summary.to_owned()))
            .collect();
        lines.push(String::new());
        lines.push("Flags".to_owned());
        lines.extend(columns(&rows, 2));
    }
    if !command.examples.is_empty() {
        let rows: Vec<(String, String)> = command
            .examples
            .iter()
            .map(|example| (example.command.to_owned(), example.summary.to_owned()))
            .collect();
        lines.push(String::new());
        lines.push("Examples".to_owned());
        lines.extend(columns(&rows, 2));
    }
    if !command.exits.is_empty() {
        let rows: Vec<(String, String)> = command
            .exits
            .iter()
            .map(|exit| (exit.code.to_string(), exit.when.to_owned()))
            .collect();
        lines.push(String::new());
        lines.push("Exit codes".to_owned());
        lines.extend(columns(&rows, 2));
    }
    let shortcuts: Vec<String> = command
        .aliases
        .iter()
        .filter(|alias| alias.deprecated_since.is_none() && !alias.quiet)
        .map(|alias| format!("ace {}", alias.words.join(" ")))
        .collect();
    if !shortcuts.is_empty() {
        lines.push(String::new());
        lines.push(format!("Shortcut: {}", shortcuts.join(", ")));
    }
    let old: Vec<String> = command
        .aliases
        .iter()
        .filter(|alias| alias.deprecated_since.is_some())
        .map(|alias| format!("ace {}", alias.words.join(" ")))
        .collect();
    if !old.is_empty() {
        lines.push(format!("Old spelling: {}", old.join(", ")));
    }
    if !command.see_also.is_empty() {
        lines.push(format!("See also: {}", command.see_also.join(", ")));
    }
    lines.push(String::new());
    lines.push(
        "Every command also takes --json, --quiet, --no-input and more: ace help output."
            .to_owned(),
    );
    lines.join("\n")
}

/// The usage line for one command.
#[must_use]
pub fn usage_line(command: &CommandSpec) -> String {
    let args: Vec<String> = command.args.iter().map(argument_label).collect();
    let flags: &[&str] = if command.flags.iter().any(|flag| !flag.hidden) {
        &["[flags]"]
    } else {
        &[]
    };
    std::iter::once("ace".to_owned())
        .chain(command.words.iter().map(|word| (*word).to_owned()))
        .chain(args)
        .chain(flags.iter().map(|flag| (*flag).to_owned()))
        .collect::<Vec<_>>()
        .join(" ")
}

fn argument_label(arg: &ArgSpec) -> String {
    let mut name = arg.name.to_owned();
    if arg.variadic {
        name.push('…');
    }
    if arg.stdin {
        name.push_str("|-");
    }
    if arg.required {
        name
    } else {
        format!("[{name}]")
    }
}

/// `-x, --name VALUE`, as help writes a flag.
#[must_use]
pub fn flag_label(flag: &FlagSpec) -> String {
    let mut label = String::new();
    if let Some(short) = flag.short {
        label.push('-');
        label.push_str(short);
        label.push_str(", ");
    }
    label.push_str("--");
    label.push_str(flag.name);
    if let Some(value) = flag.value {
        label.push(' ');
        label.push_str(value);
    }
    label
}

/// The global flags page (`ace help flags`).
#[must_use]
pub fn global_flags_page() -> String {
    let rows: Vec<(String, String)> = cli_table::global_flags()
        .iter()
        .filter(|flag| !flag.hidden)
        .map(|flag| (flag_label(flag), flag.summary.to_owned()))
        .collect();
    columns(&rows, 2).join("\n")
}

/// The exit codes page (`ace help exit-codes`).
#[must_use]
pub fn exit_codes_page() -> String {
    let rows: Vec<(String, String)> = cli_table::exit_codes()
        .iter()
        .map(|exit| {
            (
                exit.code.to_string(),
                format!("{}: {}", exit.name, exit.means),
            )
        })
        .collect();
    columns(&rows, 2).join("\n")
}

pub(crate) fn topics_page() -> String {
    cli_table::topics()
        .iter()
        .map(|topic| format!("  {:<18} {}", topic.name, topic.summary))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Two aligned columns; the first is padded to the widest cell, capped so text still fits.
#[must_use]
pub fn columns(rows: &[(String, String)], indent: usize) -> Vec<String> {
    let width = rows
        .iter()
        .map(|(left, _)| left.chars().count())
        .max()
        .unwrap_or(0)
        .min(34);
    let pad = " ".repeat(indent);
    rows.iter()
        .map(|(left, right)| {
            if left.chars().count() > width {
                format!("{pad}{left}\n{pad}{}{right}", " ".repeat(width + 2))
            } else {
                let padding = width - left.chars().count();
                format!("{pad}{left}{}  {right}", " ".repeat(padding))
                    .trim_end()
                    .to_owned()
            }
        })
        .collect()
}

fn sentence(text: &str) -> String {
    if text.ends_with(['.', '!', '?']) {
        text.to_owned()
    } else {
        format!("{text}.")
    }
}

/// Prose is wrapped; a line that starts with spaces (a table of forms) is kept as written.
fn paragraphs(text: &str) -> Vec<String> {
    text.split('\n')
        .flat_map(|line| {
            if line.starts_with(char::is_whitespace) || line.is_empty() {
                vec![line.to_owned()]
            } else {
                wrap(line, 78)
            }
        })
        .collect()
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if !line.is_empty() && line.chars().count() + word.chars().count() + 1 > width {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
        } else {
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}
