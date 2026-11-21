//! A package's `checks` (ADR 0204 §3): conditions Spade holds a result to before it counts as
//! done, in the package's own words. A `schema` check runs a rule ([`crate::quality::rule`]) on a
//! contract's output before it reaches the caller and on a card's data before it is shown; a
//! `criterion` check joins the goal's criteria, judged by ADR 0159's check of done. A `code`
//! check needs package code (ADR 0203), which this build doesn't run, so it is refused rather
//! than passed over: checks only ever add conditions. The marketplace reads `checks` the same way
//! (`packages/marketplace/src/checks.ts`), held to it by the conformance suite's
//! `package/checks.json`. Pure.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::quality::rule;
use crate::schema::Misfit;

use super::contract::Contract;
use super::surfaces::Surface;

pub const MOST_CHECKS: usize = 32;
/// The most places one check is on.
pub const MOST_ON: usize = 8;
/// The most `criterion` checks: a goal holds at most 20 criteria, the bot's own among them.
pub const MOST_CRITERIA: usize = 8;
pub const NAME_CHARS: usize = 40;
pub const TEXT_CHARS: usize = 500;
/// A check's fields.
pub const FIELDS: [&str; 6] = ["name", "on", "kind", "rule", "text", "code"];

/// Where a check runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "name")]
pub enum Target {
    /// A contract's output, before `contract_return` reaches the caller.
    Contract(String),
    /// A package card's data, before `card_show` shows it.
    Card(String),
    /// The goal, when the bot claims done.
    Goal,
}

impl Target {
    fn parse(word: &str) -> Option<Self> {
        if word == "goal" {
            return Some(Self::Goal);
        }
        let (kind, name) = word.split_once(':')?;
        match kind {
            "contract" if !name.is_empty() => Some(Self::Contract(name.to_owned())),
            "card" if !name.is_empty() => Some(Self::Card(name.to_owned())),
            _ => None,
        }
    }
}

/// What a check runs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum Kind {
    /// A rule the result holds, as written (read again with [`rule::read`] when it runs).
    Schema { rule: Value },
    /// A line the goal's check of done judges.
    Criterion { text: String },
}

/// One check, read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub name: String,
    pub on: Vec<Target>,
    #[serde(flatten)]
    pub kind: Kind,
}

fn check_name(name: &str) -> bool {
    (1..=NAME_CHARS).contains(&name.len())
        && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Reads `checks` against the package's contracts and cards; every problem goes to `problems`.
pub fn read(
    value: Option<&Value>,
    contracts: &[Contract],
    surfaces: &[Surface],
    problems: &mut Vec<String>,
) -> Vec<Check> {
    let Some(value) = value else {
        return Vec::new();
    };
    let Some(items) = value.as_array().filter(|items| items.len() <= MOST_CHECKS) else {
        problems.push(format!("checks is a list of at most {MOST_CHECKS}"));
        return Vec::new();
    };
    let cards: Vec<&str> = surfaces
        .iter()
        .filter_map(|surface| match surface {
            Surface::Card { id, .. } => Some(id.as_str()),
            Surface::Panel(_) => None,
        })
        .collect();
    let mut names = BTreeSet::new();
    let mut checks = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let at = format!("checks[{i}]");
        let Some(fields) = item.as_object() else {
            problems.push(format!("{at} is an object"));
            continue;
        };
        if let Some(check) = one(&at, fields, contracts, &cards, problems) {
            if !names.insert(check.name.clone()) {
                problems.push("each check has a name of its own".to_owned());
            }
            checks.push(check);
        }
    }
    let criteria = checks
        .iter()
        .filter(|c| matches!(c.kind, Kind::Criterion { .. }))
        .count();
    if criteria > MOST_CRITERIA {
        problems.push(format!(
            "a package has at most {MOST_CRITERIA} criterion checks"
        ));
    }
    checks
}

fn one(
    at: &str,
    fields: &Map<String, Value>,
    contracts: &[Contract],
    cards: &[&str],
    problems: &mut Vec<String>,
) -> Option<Check> {
    let before = problems.len();
    for key in fields.keys() {
        if !FIELDS.contains(&key.as_str()) {
            problems.push(format!("{at}: {key:?} isn't a field of a check"));
        }
    }
    let name = match fields.get("name").and_then(Value::as_str) {
        Some(name) if check_name(name) => name.to_owned(),
        _ => {
            problems.push(format!(
                "{at}.name is a short name: lower-case letters, digits and dashes"
            ));
            String::new()
        }
    };
    let on = targets(at, fields.get("on"), contracts, cards, problems);
    let kind = match fields.get("kind").and_then(Value::as_str) {
        Some("schema") => {
            if on.contains(&Target::Goal) {
                problems.push(format!(
                    "{at}: a schema check is on contracts and cards, not the goal"
                ));
            }
            match fields.get("rule") {
                Some(value) => {
                    if let Err(found) = rule::read(value, &format!("{at}.rule")) {
                        problems.extend(found);
                    }
                    Some(Kind::Schema {
                        rule: value.clone(),
                    })
                }
                None => {
                    problems.push(format!("{at}.rule is the rule the result must hold"));
                    None
                }
            }
        }
        Some("criterion") => {
            if on != [Target::Goal] {
                problems.push(format!("{at}: a criterion check is on the goal only"));
            }
            match fields.get("text").and_then(Value::as_str).map(str::trim) {
                Some(text) if !text.is_empty() && text.chars().count() <= TEXT_CHARS => {
                    Some(Kind::Criterion {
                        text: text.to_owned(),
                    })
                }
                _ => {
                    problems.push(format!(
                        "{at}.text says in 1 to {TEXT_CHARS} characters what must hold"
                    ));
                    None
                }
            }
        }
        Some("code") => {
            problems.push(format!(
                "{at}: Needs a newer Spade: code checks run once Spade runs a package's code"
            ));
            None
        }
        _ => {
            problems.push(format!("{at}.kind is schema, code or criterion"));
            None
        }
    };
    let kind = kind?;
    (problems.len() == before).then_some(Check { name, on, kind })
}

fn targets(
    at: &str,
    value: Option<&Value>,
    contracts: &[Contract],
    cards: &[&str],
    problems: &mut Vec<String>,
) -> Vec<Target> {
    let words: Option<Vec<&str>> = value
        .and_then(Value::as_array)
        .filter(|items| (1..=MOST_ON).contains(&items.len()))
        .and_then(|items| items.iter().map(Value::as_str).collect());
    let Some(words) = words else {
        problems.push(format!(
            "{at}.on names 1 to {MOST_ON} places: contract:<name>, card:<id> or goal"
        ));
        return Vec::new();
    };
    let mut on = Vec::new();
    for word in words {
        match Target::parse(word) {
            Some(Target::Contract(name)) if !contracts.iter().any(|c| c.name == name) => problems
                .push(format!(
                    "{at}.on: {word:?} isn't one of the package's contracts"
                )),
            Some(Target::Card(id)) if !cards.contains(&id.as_str()) => {
                problems.push(format!(
                    "{at}.on: {word:?} isn't one of the package's cards"
                ));
            }
            Some(target) if on.contains(&target) => {
                problems.push(format!("{at}.on names {word:?} twice"));
            }
            Some(target) => on.push(target),
            None => problems.push(format!(
                "{at}.on: {word:?} is contract:<name>, card:<id> or goal"
            )),
        }
    }
    on
}

/// Every place `value` misses the package's schema checks on `target`, each named by its check:
/// `fare-has-link: output.link: is missing`. Empty when every check holds.
pub fn misses(checks: &[Check], target: &Target, value: &Value, at: &str) -> Vec<String> {
    checks
        .iter()
        .filter(|check| check.on.contains(target))
        .filter_map(|check| match &check.kind {
            Kind::Schema { rule } => Some((check, rule)),
            Kind::Criterion { .. } => None,
        })
        .flat_map(|(check, written)| {
            let found: Vec<Misfit> = match rule::read(written, "rule") {
                Ok(rule) => rule.check(value, at),
                // Read when the package was; a rule this build can't read again never passes.
                Err(_) => vec![Misfit {
                    at: at.to_owned(),
                    why: "its rule couldn't be read".to_owned(),
                }],
            };
            found
                .into_iter()
                .map(move |misfit| format!("{}: {misfit}", check.name))
        })
        .collect()
}

/// The package's criteria for a goal: each `criterion` check's text, in order.
pub fn criteria(checks: &[Check]) -> Vec<String> {
    checks
        .iter()
        .filter(|check| check.on.contains(&Target::Goal))
        .filter_map(|check| match &check.kind {
            Kind::Criterion { text } => Some(text.clone()),
            Kind::Schema { .. } => None,
        })
        .collect()
}

#[cfg(test)]
#[path = "checks_tests.rs"]
mod tests;
