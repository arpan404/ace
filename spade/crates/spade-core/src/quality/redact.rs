//! What a case hides before it is written (ADR 0204 §1): secrets, by the same key and token
//! patterns the market refuses ([`crate::redact`]); the person's own addresses and names, read
//! from what Spade knows about them (`about_person` notes), each replaced with a fixed stand-in;
//! and every value the person marked on the review shown before saving.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use super::case::{Case, Given, Outcome, Trigger};
use crate::redact::HIDDEN;

/// What one of the person's addresses reads as in a kept case.
pub const ADDRESS: &str = "person@example.com";

/// What one of the person's names reads as in a kept case.
pub const NAME: &str = "Person";

/// The person's own addresses and names, as the case hides them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Person {
    pub addresses: Vec<String>,
    pub names: Vec<String>,
}

fn address_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
}

/// Every mail address in `text`, as written.
pub fn addresses(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut found = Vec::new();
    for (at, c) in chars.iter().enumerate() {
        if *c != '@' {
            continue;
        }
        let mut start = at;
        while start > 0 && address_char(chars[start - 1]) {
            start -= 1;
        }
        let mut end = at + 1;
        while end < chars.len() && address_char(chars[end]) {
            end += 1;
        }
        let local: String = chars[start..at].iter().collect();
        let domain: String = chars[at + 1..end].iter().collect();
        let domain = domain.trim_end_matches(['.', '-']);
        let tld = domain.rsplit('.').next().unwrap_or("");
        if !local.is_empty()
            && domain.contains('.')
            && tld.len() >= 2
            && tld.chars().all(|c| c.is_ascii_alphabetic())
        {
            found.push(format!("{local}@{domain}"));
        }
    }
    found
}

/// Phrases a fact names the person with: "My name is Dana Reyes", "goes by Dee".
const NAMING: [&str; 6] = ["name is ", "named ", "called ", "goes by ", "i am ", "i'm "];

/// The names facts give the person: the capitalised words after a naming phrase (up to three),
/// whole, and each word of two or more letters.
pub fn names(text: &str) -> Vec<String> {
    // ASCII lowercasing keeps every byte where it was, so positions read the same in both.
    let lower = text.to_ascii_lowercase();
    let mut found = Vec::new();
    for phrase in NAMING {
        let mut from = 0;
        while let Some(at) = lower[from..].find(phrase) {
            let after = from + at + phrase.len();
            from = after;
            // Only at a word's start: "renamed " is not "named ".
            let start = from - phrase.len();
            if start > 0
                && text[..start]
                    .chars()
                    .last()
                    .is_some_and(char::is_alphanumeric)
            {
                continue;
            }
            let words: Vec<&str> = text
                .get(after..)
                .unwrap_or("")
                .split_whitespace()
                .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '\''))
                .take_while(|w| w.chars().next().is_some_and(char::is_uppercase))
                .take(3)
                .collect();
            if words.is_empty() {
                continue;
            }
            found.push(words.join(" "));
            for word in words {
                if word.chars().count() >= 2 {
                    found.push(word.to_owned());
                }
            }
        }
    }
    found
}

impl Person {
    /// The person as `facts` (what Spade knows about them) name them.
    pub fn from_facts<'a>(facts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut person = Self::default();
        for fact in facts {
            person.addresses.extend(addresses(fact));
            person.names.extend(names(fact));
        }
        person.tidy();
        person
    }

    /// Longest first, so a full name is replaced before its parts; no repeats.
    fn tidy(&mut self) {
        for list in [&mut self.addresses, &mut self.names] {
            list.sort_by(|a, b| b.chars().count().cmp(&a.chars().count()).then(a.cmp(b)));
            list.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        }
    }
}

/// `text` with every whole-word occurrence of `word` (any case) replaced by `with`.
fn replace_word(text: &str, word: &str, with: &str) -> String {
    if word.is_empty() {
        return text.to_owned();
    }
    let lower = text.to_ascii_lowercase();
    let needle = word.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut from = 0;
    while let Some(at) = lower[from..].find(&needle) {
        let start = from + at;
        let end = start + needle.len();
        let before = text[..start].chars().last();
        let after = text[end..].chars().next();
        let edge = |c: Option<char>| !c.is_some_and(|c| c.is_alphanumeric() || c == '_');
        out.push_str(&text[from..start]);
        if edge(before) && edge(after) {
            out.push_str(with);
        } else {
            out.push_str(&text[start..end]);
        }
        from = end;
    }
    out.push_str(&text[from..]);
    out
}

/// One string as a kept case holds it: the marked values hidden, the person's addresses and
/// names replaced, then secrets hidden.
fn hide_text(text: &str, person: &Person, marked: &[String]) -> String {
    let mut out = text.to_owned();
    for value in marked {
        if !value.is_empty() {
            out = out.replace(value.as_str(), HIDDEN);
        }
    }
    for address in &person.addresses {
        out = replace_word(&out, address, ADDRESS);
    }
    for name in &person.names {
        out = replace_word(&out, name, NAME);
    }
    crate::redact::text(&out)
}

fn hide_value(value: &Value, person: &Person, marked: &[String]) -> Value {
    match value {
        Value::String(text) => Value::String(hide_text(text, person, marked)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| hide_value(item, person, marked))
                .collect(),
        ),
        Value::Object(fields) => {
            let mut out = Map::new();
            for (key, item) in fields {
                let shown = if crate::redact::secret_name(key) && !item.is_null() {
                    Value::String(HIDDEN.to_owned())
                } else {
                    hide_value(item, person, marked)
                };
                out.insert(hide_text(key, person, marked), shown);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// The marked values worth hiding: trimmed, each at least two characters (one letter would hide
/// every word holding it), longest first.
pub fn marked_values(marked: &[String]) -> Vec<String> {
    let mut values: Vec<String> = marked
        .iter()
        .map(|v| v.trim().to_owned())
        .filter(|v| v.chars().count() >= 2)
        .collect();
    values.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    values.dedup();
    values
}

/// `value` with everything in it hidden as above, read back as its own type. A value that
/// doesn't read back (never, for a case's own parts) is dropped, never written unhidden.
fn hidden<T: Serialize + DeserializeOwned>(
    value: &T,
    person: &Person,
    marked: &[String],
) -> Option<T> {
    let json = serde_json::to_value(value).ok()?;
    serde_json::from_value(hide_value(&json, person, marked)).ok()
}

/// `case` as it is written: everything the run said, was given or got hidden as above. Its own
/// identity (id, bot, reply, package, mark, time) is Spade's and stays as it is.
pub fn case(case: &Case, person: &Person, marked: &[String]) -> Case {
    let marked = marked_values(marked);
    let text = |t: &str| hide_text(t, person, &marked);
    Case {
        trigger: Trigger {
            kind: case.trigger.kind.clone(),
            name: case.trigger.name.as_deref().map(text),
        },
        given: hidden(&case.given, person, &marked).unwrap_or(Given {
            messages: Vec::new(),
            input: None,
        }),
        steps: hidden(&case.steps, person, &marked).unwrap_or_default(),
        tool_results: hidden(&case.tool_results, person, &marked).unwrap_or_default(),
        outcome: hidden(&case.outcome, person, &marked).unwrap_or(Outcome {
            text: String::new(),
            cards: Vec::new(),
            contract: None,
            effects: Vec::new(),
            verdict: None,
        }),
        why: case.why.as_deref().map(text),
        ..case.clone()
    }
}

#[cfg(test)]
mod tests;
