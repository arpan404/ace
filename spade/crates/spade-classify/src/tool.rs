//! A tool call's features: the tool's name split into words (its verb, its object, word pairs),
//! the MCP hints and trusted declaration it came with, its argument keys and their types, the
//! shapes of their values (an e-mail address, an amount, a URL and its host) and the words of short
//! values. A string argument named like a command (`command`, `cmd`, `script`) is also read as
//! a shell command.

use serde_json::Value;
use spade_core::effect::Mcp;

use crate::hash::Bag;
use crate::shell::Found;
use crate::{shape, shell, text};

/// The most keys read, all told, and how deep.
const MOST_KEYS: usize = 48;
const DEEPEST: usize = 3;
/// Values up to this many characters have their words read.
const SHORT: usize = 80;

pub(crate) fn features(name: &str, arguments: &Value, hints: Mcp, bag: &mut Bag) -> Found {
    bag.add("KIND", &["tool"]);
    let folded = text::fold(name, 256);
    let mut found = Found::default();
    if folded.lookalike || folded.invisible {
        bag.add("M", &["lookalike_name"]);
        found.hides = true;
    }
    let words = text::name_words(&folded.text);
    for word in &words {
        bag.add("TN", &[word]);
    }
    for pair in words.windows(2) {
        bag.add("TB", &[&pair[0], &pair[1]]);
    }
    // The tool's own name is the part after a server's prefix (`gmail__send_email`).
    let own = folded
        .text
        .rsplit("__")
        .next()
        .map(text::name_words)
        .unwrap_or_default();
    if let Some(verb) = own.first() {
        bag.add("TV", &[verb]);
    }
    if let Some(object) = own.last() {
        bag.add("TO", &[object]);
    }
    bag.add(
        "HINT",
        &[if hints.read_only {
            "read_only"
        } else {
            "not_read_only"
        }],
    );
    if hints.annotated {
        bag.add("HINT", &["annotated"]);
    }
    if let Some(declared) = hints.declared {
        bag.add("HINT", &["declared", declared.name()]);
    }
    let mut keys = 0;
    walk(arguments, None, 0, &mut keys, bag, &mut found);
    bag.add(
        "NK",
        &[match keys {
            0 => "0",
            1 => "1",
            2 | 3 => "2-3",
            4..=7 => "4-7",
            _ => "8+",
        }],
    );
    bag.grams("TG", &text::squeezed(&folded.text, 256));
    found
}

fn walk(
    value: &Value,
    key: Option<&str>,
    depth: usize,
    keys: &mut usize,
    bag: &mut Bag,
    found: &mut Found,
) {
    match value {
        Value::Object(map) => {
            if depth > DEEPEST {
                bag.add("M", &["deep"]);
                return;
            }
            for (k, v) in map {
                if *keys >= MOST_KEYS {
                    return;
                }
                *keys += 1;
                let k = text::fold(k, 64).text.to_ascii_lowercase();
                for word in text::name_words(&k) {
                    bag.add("K", &[&word]);
                }
                bag.add("KT", &[&k, kind(v)]);
                walk(v, Some(&k), depth + 1, keys, bag, found);
            }
        }
        Value::Array(items) => {
            let k = key.unwrap_or("");
            bag.add(
                "KA",
                &[
                    k,
                    match items.len() {
                        0 => "0",
                        1 => "1",
                        2..=9 => "2-9",
                        _ => "10+",
                    },
                ],
            );
            for item in items.iter().take(4) {
                walk(item, key, depth + 1, keys, bag, found);
            }
        }
        Value::String(s) => {
            let k = key.unwrap_or("");
            let folded = text::fold(s, 4096);
            let shape = shape::of(&folded.text, None, "KS", bag);
            bag.add("KS", &[k, shape]);
            bag.add("S", &[shape]);
            found.outside |= shape::elsewhere(&folded.text, shape);
            if shape.starts_with("path_") {
                found.outside |= shape::place(folded.text.trim(), None).outside();
            }
            if matches!(k, "command" | "cmd" | "script" | "shell" | "commandline")
                && !folded.text.trim().is_empty()
            {
                let inner = shell::features(&folded.text, None, bag);
                found.outside |= inner.outside;
                found.hides |= inner.hides;
            } else if folded.text.chars().count() <= SHORT {
                text::tokens(&folded.text.to_lowercase(), 24, |t| bag.add("V", &[t]));
            }
        }
        Value::Number(n) => {
            let k = key.unwrap_or("");
            let size = n.as_f64().map_or(0.0, f64::abs);
            bag.add(
                "KN",
                &[
                    k,
                    if size < 1.0 {
                        "<1"
                    } else if size < 100.0 {
                        "<100"
                    } else if size < 10_000.0 {
                        "<10k"
                    } else {
                        "big"
                    },
                ],
            );
        }
        Value::Bool(b) => bag.add(
            "KB",
            &[key.unwrap_or(""), if *b { "true" } else { "false" }],
        ),
        Value::Null => bag.add("KT", &[key.unwrap_or(""), "null"]),
    }
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Object(_) => "object",
        Value::Array(_) => "array",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "bool",
        Value::Null => "null",
    }
}
