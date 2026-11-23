// SPDX-License-Identifier: Apache-2.0
//! ace's command table as static data (ADR 0221 §3).

mod data;
mod types;

pub use types::{
    AliasSpec, ArgSpec, CommandSpec, Example, ExitCodeMeaning, ExitSpec, FlagSpec, Group, NounSpec,
    PersonOnly, RefKind, Route, TopicSpec,
};

use std::collections::BTreeSet;

/// Every command, in table order.
#[must_use]
pub fn commands() -> &'static [CommandSpec] {
    data::COMMANDS
}

/// Every noun, in table order.
#[must_use]
pub fn nouns() -> &'static [NounSpec] {
    data::NOUNS
}

/// Every help topic, in table order.
#[must_use]
pub fn topics() -> &'static [TopicSpec] {
    data::TOPICS
}

/// What each exit code means (ADR 0178 §4).
#[must_use]
pub fn exit_codes() -> &'static [ExitCodeMeaning] {
    data::EXIT_CODES
}

/// Flags every command takes, parsed before its own (ADR 0178 §2).
#[must_use]
pub fn global_flags() -> &'static [FlagSpec] {
    data::GLOBAL_FLAGS
}

fn resolve(entry: &'static data::RouteEntry) -> Route {
    let command = &data::COMMANDS[entry.command];
    Route {
        command,
        alias: entry.alias.map(|alias| &command.aliases[alias]),
    }
}

/// A command by its dotted id.
#[must_use]
pub fn by_id(id: &str) -> Option<&'static CommandSpec> {
    data::BY_ID
        .binary_search_by(|(key, _)| (*key).cmp(id))
        .ok()
        .map(|index| &data::COMMANDS[data::BY_ID[index].1])
}

/// The command or alias reached by the space-joined words, if any.
#[must_use]
pub fn route(key: &str) -> Option<Route> {
    let entries = data::ROUTES;
    let index = entries.binary_search_by(|entry| entry.key.cmp(key)).ok()?;
    Some(resolve(&entries[index]))
}

/// Every route's words, one per reachable spelling, in the order the table added them.
pub fn route_keys() -> impl Iterator<Item = &'static str> {
    data::ROUTE_KEYS.iter().copied()
}

/// The words that may follow a space-joined prefix (`thread`, `market maintainer`).
#[must_use]
pub fn next(prefix: &str) -> Option<&'static [&'static str]> {
    let entries = data::NEXT;
    let index = entries
        .binary_search_by(|entry| entry.prefix.cmp(prefix))
        .ok()?;
    Some(entries[index].words)
}

/// Whether anything sits under a command prefix.
#[must_use]
pub fn has_next(prefix: &str) -> bool {
    next(prefix).is_some()
}

/// The words that may follow a prefix, without hidden commands or old spellings, sorted.
#[must_use]
pub fn visible_words(prefix: &str) -> Vec<&'static str> {
    let depth = if prefix.is_empty() {
        0
    } else {
        prefix.split(' ').count()
    };
    let mut visible = BTreeSet::new();
    for entry in data::ROUTES {
        let rests_under_prefix = match entry.key.strip_prefix(prefix) {
            Some(rest) => prefix.is_empty() || rest.starts_with(' '),
            None => false,
        };
        if !rests_under_prefix {
            continue;
        }
        let route = resolve(entry);
        if route.command.hidden {
            continue;
        }
        if let Some(alias) = route.alias
            && (alias.deprecated_since.is_some() || alias.quiet)
        {
            continue;
        }
        let words: Vec<&'static str> = entry.key.split(' ').collect();
        if words.len() <= depth {
            continue;
        }
        if let Some(word) = words.get(depth) {
            visible.insert(*word);
        }
    }
    visible.into_iter().collect()
}
