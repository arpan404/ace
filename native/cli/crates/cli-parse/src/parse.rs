// SPDX-License-Identifier: Apache-2.0
//! Reading the words: the longest route, the noun rules, aliases, and the checks after the
//! flags.

use cli_out::{ErrorCode, FlagValue};
use cli_table::{AliasSpec, ArgSpec, CommandSpec, Route};

use crate::flags::{is_flag, take_flag};
use crate::suggest::nearest;
use crate::types::{Line, NounOnly, ParseResult, Parsed, Problem, Usage};

/// The space-joined words up to each word, so route lookups borrow instead of rebuilding.
fn key_ends(words: &[&str]) -> (String, Vec<usize>) {
    let mut key = String::new();
    let mut ends = Vec::with_capacity(words.len());
    for (index, word) in words.iter().enumerate() {
        if index > 0 {
            key.push(' ');
        }
        key.push_str(word);
        ends.push(key.len());
    }
    (key, ends)
}

fn route_for(typed: &[&str]) -> Option<Route> {
    let (key, ends) = key_ends(typed);
    let end = ends.last().copied()?;
    cli_table::route(&key[..end])
}

/// What the command's words name, before the flags after them are read.
enum Resolved<'a> {
    Command {
        command: &'static CommandSpec,
        alias: Option<&'static AliasSpec>,
        typed: Vec<&'a str>,
    },
    Noun(Vec<&'a str>),
}

/// The longest run of words that names a command, or the problem with the words.
fn resolve<'a>(named: &'a [&'a str]) -> Result<Resolved<'a>, Problem> {
    let (key, ends) = key_ends(named);
    let mut matched = 0;
    for count in (1..=named.len()).rev() {
        if cli_table::route(&key[..ends[count - 1]]).is_some() {
            matched = count;
            break;
        }
    }
    if matched == 0 {
        let Some(first) = named.first().copied() else {
            // No words at all: the bare `ace` home.
            let Some(route) = cli_table::route("") else {
                return Err(Problem::new(
                    ErrorCode::UnknownCommand,
                    "ace has no such command.".to_owned(),
                ));
            };
            return Ok(Resolved::Command {
                command: route.command,
                alias: route.alias,
                typed: Vec::new(),
            });
        };
        if cli_table::next("").is_some_and(|words| words.contains(&first)) {
            return Ok(Resolved::Noun(vec![first]));
        }
        return Err(unknown_command(first));
    }
    let typed = &named[..matched];
    let Some(route) = route_for(typed) else {
        return Err(Problem::new(
            ErrorCode::UnknownCommand,
            "ace has no such command.".to_owned(),
        ));
    };
    let command = route.command;
    let alias = route.alias;
    let prefix = &key[..ends[matched - 1]];
    let extra = named.get(matched);
    // A deeper noun typed alone (`ace provider account`) that has no default of its own.
    if let Some(extra) = extra
        && !command.passthrough
    {
        let deeper = format!("{prefix} {extra}");
        if cli_table::has_next(&deeper) && cli_table::route(&deeper).is_none() {
            let mut words = typed.to_vec();
            words.push(extra);
            return Ok(Resolved::Noun(words));
        }
    }
    // `ace thread lsit` reaches the noun's default by its first word only; the second word was
    // meant as a verb.
    if let Some(extra) = extra
        && alias.is_none()
        && typed.len() < command.words.len()
    {
        let suggestion = nearest(extra, cli_table::visible_words(prefix));
        let hint = suggestion.map_or_else(
            || format!("See what it can do with ace help {prefix}."),
            |suggestion| format!("Did you mean ace {prefix} {suggestion}?"),
        );
        let problem = Problem::new(
            ErrorCode::UnknownCommand,
            format!("ace {prefix} has no command {extra}."),
        )
        .with_hint(hint);
        return Err(match suggestion {
            Some(suggestion) => problem.with_suggestion(format!("ace {prefix} {suggestion}")),
            None => problem,
        });
    }
    Ok(Resolved::Command {
        command,
        alias,
        typed: typed.to_vec(),
    })
}

fn unknown_command(first: &str) -> Problem {
    let suggestion = nearest(first, cli_table::visible_words(""));
    let hint = suggestion.map_or_else(
        || "See every command with ace help.".to_owned(),
        |suggestion| format!("Did you mean ace {suggestion}?"),
    );
    let problem = Problem::new(
        ErrorCode::UnknownCommand,
        format!("ace has no command {first}."),
    )
    .with_hint(hint);
    match suggestion {
        Some(suggestion) => problem.with_suggestion(format!("ace {suggestion}")),
        None => problem,
    }
}

fn command_usage(command: &CommandSpec) -> String {
    format!("ace {}", command.words.join(" "))
}

/// The command's own flags first, so an alias's renames apply before lookup.
fn apply_alias<'a>(alias: Option<&AliasSpec>, words: &mut Vec<&'a str>, line: &mut Line<'a>) {
    let Some(alias) = alias else { return };
    for name in alias.set_flags {
        line.flags.set(name, FlagValue::Switch);
    }
    let mut taken = 0;
    for name in alias.words_as {
        let Some(word) = words.get(taken).copied() else {
            break;
        };
        if !line.flags.has(name) {
            line.flags.set(name, FlagValue::Value(word));
        }
        taken += 1;
    }
    if taken > 0 {
        words.drain(..taken);
    }
}

fn check_arguments(
    command: &'static CommandSpec,
    words: &[&str],
) -> Result<Vec<&'static ArgSpec>, Problem> {
    let args = command.args;
    if !args.iter().any(|arg| arg.variadic) && words.len() > args.len() {
        let takes = if args.is_empty() {
            "takes no arguments".to_owned()
        } else {
            format!(
                "takes {}",
                args.iter()
                    .map(|arg| arg.name)
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        let usage = command_usage(command);
        return Err(Problem::new(
            ErrorCode::TooManyArguments,
            format!(
                "{usage} {takes}, and {} is one too many.",
                words[args.len()]
            ),
        )
        .with_hint(format!(
            "Quote text with spaces, or see ace help {}.",
            command.words.join(" ")
        ))
        .with_command(command.id));
    }
    Ok(args
        .iter()
        .enumerate()
        .filter(|(position, arg)| {
            arg.required && words.get(*position).is_none() && !(arg.variadic && *position > 0)
        })
        .map(|(_, arg)| arg)
        .collect())
}

/// Reads one command line.
#[must_use]
pub fn parse<'a>(input: &'a [&'a str]) -> ParseResult<'a> {
    let mut line = Line::default();
    match run(input, &mut line) {
        Ok(result) => result,
        Err(problem) => ParseResult::Usage(Usage {
            code: problem.code,
            message: problem.message,
            hint: problem.hint,
            suggestion: problem.suggestion,
            argument: problem.argument,
            command: problem.command,
            flags: line.flags,
        }),
    }
}

fn run<'a>(input: &'a [&'a str], line: &mut Line<'a>) -> Result<ParseResult<'a>, Problem> {
    // Global flags may come before the command's words.
    let mut index = 0;
    while index < input.len() && is_flag(input[index]) {
        index = take_flag(input, index, &[], line, &[])?;
    }
    let start = index;
    while index < input.len() && !is_flag(input[index]) && input[index] != "--" {
        index += 1;
    }
    let named = &input[start..index];
    let (mut command, alias, typed) = match resolve(named)? {
        Resolved::Noun(words) => {
            return Ok(ParseResult::Noun(NounOnly {
                words,
                flags: std::mem::take(&mut line.flags),
            }));
        }
        Resolved::Command {
            command,
            alias,
            typed,
        } => (command, alias, typed),
    };
    // An alias may send a flag to another command (`clean --compact`).
    if let Some(alias) = alias {
        for (flag, target) in alias.by_flag {
            let given = input[index..].iter().any(|token| {
                token.strip_prefix("--").is_some_and(|rest| {
                    rest == *flag
                        || rest
                            .strip_prefix(flag)
                            .is_some_and(|rest| rest.starts_with('='))
                })
            });
            if given && let Some(next) = cli_table::by_id(target) {
                command = next;
            }
        }
    }

    let mut words: Vec<&'a str> = Vec::new();
    if let Some(alias) = alias {
        words.extend_from_slice(alias.insert_words);
    }
    words.extend_from_slice(&named[typed.len()..]);
    if command.passthrough {
        for (position, token) in input[index..].iter().enumerate() {
            if position == 0 && *token == "--" {
                continue;
            }
            words.push(token);
        }
        return Ok(ParseResult::Command(Parsed {
            command,
            alias,
            typed,
            words,
            flags: std::mem::take(&mut line.flags),
            lists: std::mem::take(&mut line.lists),
            missing: Vec::new(),
        }));
    }

    while index < input.len() {
        let token = input[index];
        if token == "--" {
            words.extend_from_slice(&input[index + 1..]);
            break;
        }
        if !is_flag(token) {
            words.push(token);
            index += 1;
            continue;
        }
        let renames = alias.map_or(&[][..], |alias| alias.rename_flags);
        index = take_flag(input, index, command.flags, line, renames)
            .map_err(|problem| problem.with_command(command.id))?;
    }
    apply_alias(alias, &mut words, line);
    let missing = check_arguments(command, &words)?;
    Ok(ParseResult::Command(Parsed {
        command,
        alias,
        typed,
        words,
        flags: std::mem::take(&mut line.flags),
        lists: std::mem::take(&mut line.lists),
        missing,
    }))
}
