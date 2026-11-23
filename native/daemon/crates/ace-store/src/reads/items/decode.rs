// SPDX-License-Identifier: Apache-2.0
//! Decoded sizes for untrusted rows: budgets run on exactly the JSON the client gets
//! (behaviour.md section 8), and the client gets the shell's lenient decode, not the stored
//! bytes. This mirrors what `decodeStoredItem` (packages/protocol/src/items.ts) makes of an
//! item: the same values (validation never rewrites one), schema key order (order never
//! changes a length), defaults filled, unknown keys dropped, unknown variants wrapped with
//! their data. The shell still decodes and throws exactly where the loader would; this only
//! predicts its byte length, so a row the decode rejects still fails the same way.
//!
//! What is mirrored, and where it is defined:
//! - every variant's kept keys and filled-in defaults (ItemBase and each AgentItem option,
//!   `Item`'s `unknown` and `artifact`);
//! - `asked`'s `devices` and `shares` defaults, and `raw` entries' per-variant keys;
//! - the unknown wrap `{...input, type: "unknown", raw: [], data: input}`.
//!
//! Anything deeper passes through at its stored size: no deeper defaults exist. A deeper
//! retired key on an old row is bounded to a few bytes and left as a documented residual.

use super::json::{J, json_bytes};

/// Keys an item variant keeps, and the JSON each filled-in default contributes.
struct Variant {
    extra: &'static [&'static str],
    defaults: &'static [(&'static str, &'static str)],
}

/// ItemBase keys every variant carries; only `complete` fills in when absent.
const BASE_KEYS: &[&str] = &[
    "id",
    "agentId",
    "runId",
    "createdAt",
    "nativeId",
    "executionSource",
    "complete",
    "inherited",
    "rawOmitted",
];
const BASE_DEFAULTS: &[(&str, &str)] = &[("complete", "true")];

fn variant_of(kind: &str) -> Option<Variant> {
    let variant = match kind {
        "html" => Variant {
            extra: &["type", "visualization", "raw"],
            defaults: &[("raw", "[]")],
        },
        "image" => Variant {
            extra: &["type", "image", "raw"],
            defaults: &[("raw", "[]")],
        },
        "message" => Variant {
            extra: &[
                "type",
                "role",
                "parts",
                "attachments",
                "synthetic",
                "origin",
                "notAnswered",
                "mergedContext",
                "speaker",
                "raw",
            ],
            defaults: &[("synthetic", "false"), ("raw", "[]")],
        },
        "delegation.started" => Variant {
            extra: &[
                "type",
                "origin",
                "childThreadId",
                "provider",
                "model",
                "accountId",
                "title",
                "role",
                "phase",
                "status",
                "updatedAt",
                "generation",
                "outcome",
                "machine",
                "raw",
            ],
            defaults: &[("outcome", "null"), ("raw", "[]")],
        },
        "delegation.settled" => Variant {
            extra: &["type", "origin", "results", "delivery", "raw"],
            defaults: &[("raw", "[]")],
        },
        "reasoning" => Variant {
            extra: &["type", "text", "source", "summary", "raw"],
            defaults: &[("summary", "false"), ("raw", "[]")],
        },
        "tool_call" => Variant {
            extra: &["type", "call", "measurement"],
            defaults: &[],
        },
        "notice" => Variant {
            extra: &[
                "type",
                "level",
                "commandId",
                "interactionId",
                "code",
                "diagnostic",
                "title",
                "detail",
                "details",
                "toolCallId",
                "measurement",
                "asked",
                "text",
                "source",
                "raw",
            ],
            defaults: &[("raw", "[]")],
        },
        "compaction" => Variant {
            extra: &["type", "tokensBefore", "tokensAfter", "summary", "raw"],
            defaults: &[("raw", "[]")],
        },
        "artifact" => Variant {
            extra: &[
                "type",
                "filename",
                "flags",
                "source",
                "artifactId",
                "path",
                "mimeType",
                "bytes",
            ],
            defaults: &[],
        },
        _ => return None,
    };
    Some(variant)
}

/// The JSON length of `"key":` plus its value.
fn entry_len(key: &str, value_len: usize) -> usize {
    2 + key.len() + 1 + value_len
}

/// An `asked` line with its devices and shares defaults filled.
fn asked_size(value: &J) -> usize {
    let J::Obj(_) = value else {
        return json_bytes(value);
    };
    const KEYS: &[&str] = &["about", "to", "devices", "share", "shares", "words"];
    const DEFAULTS: &[(&str, &str)] = &[("devices", "[]"), ("shares", "[]")];
    let mut total = 2usize;
    let mut first = true;
    for key in KEYS {
        let value_len = match value.get(key) {
            Some(found) => json_bytes(found),
            None => match DEFAULTS.iter().find(|(name, _)| *name == *key) {
                Some((_, json)) => json.len(),
                None => continue,
            },
        };
        if !first {
            total += 1;
        }
        first = false;
        total += entry_len(key, value_len);
    }
    total
}

/// A raw payload with only its variant's keys kept, as the union decode keeps them.
fn raw_element_size(element: &J) -> usize {
    let J::Obj(_) = element else {
        return json_bytes(element);
    };
    // The union tries the inline shape first: an element with data keeps type, name and
    // data; otherwise the blob shape keeps its own keys. Anything else fails validation.
    let keys: &[&str] = if element.get("data").is_some() {
        &["type", "name", "data"]
    } else if element.get("blobRef").is_some() {
        &["type", "name", "blobRef", "size", "preview"]
    } else {
        return json_bytes(element);
    };
    let mut total = 2usize;
    let mut first = true;
    for key in keys {
        let Some(found) = element.get(key) else {
            continue;
        };
        if !first {
            total += 1;
        }
        first = false;
        total += entry_len(key, json_bytes(found));
    }
    total
}

/// A raw array with each entry reduced to what the decode keeps.
fn raw_size(value: &J) -> usize {
    let J::Arr(elements) = value else {
        return json_bytes(value);
    };
    let mut total = 2usize;
    let mut first = true;
    for element in elements {
        if !first {
            total += 1;
        }
        first = false;
        total += raw_element_size(element);
    }
    total
}

/// The size of one kept key's value: nested `asked` and `raw` decode with their own rules,
/// everything else passes through byte-identical.
fn nested_size(key: &str, value: &J) -> usize {
    match key {
        "asked" => asked_size(value),
        "raw" => raw_size(value),
        _ => json_bytes(value),
    }
}

fn variant_size(extra: &[&str], defaults: &[(&str, &str)], item: &J) -> usize {
    let mut total = 2usize;
    let mut first = true;
    for key in BASE_KEYS.iter().chain(extra.iter()) {
        let value_len = match item.get(key) {
            Some(found) => nested_size(key, found),
            None => match defaults
                .iter()
                .chain(BASE_DEFAULTS.iter())
                .find(|(name, _)| *name == *key)
            {
                Some((_, json)) => json.len(),
                None => continue,
            },
        };
        if !first {
            total += 1;
        }
        first = false;
        total += entry_len(key, value_len);
    }
    total
}

/// An unknown variant wraps as `{...input, type: "unknown", raw: [], data: input}` with only
/// schema keys kept: the input's own type and raw are replaced, and everything rides along.
fn unknown_size(item: &J) -> usize {
    const EXTRA: &[&str] = &["type", "raw", "data"];
    let mut total = 2usize;
    let mut first = true;
    for key in BASE_KEYS.iter().chain(EXTRA.iter()) {
        let value_len = match *key {
            "type" => "\"unknown\"".len(),
            "raw" => "[]".len(),
            "data" => json_bytes(item),
            _ => match item.get(key) {
                Some(found) => nested_size(key, found),
                None => match BASE_DEFAULTS.iter().find(|(name, _)| *name == *key) {
                    Some((_, json)) => json.len(),
                    None => continue,
                },
            },
        };
        if !first {
            total += 1;
        }
        first = false;
        total += entry_len(key, value_len);
    }
    total
}

/// The byte length of the JSON the shell's decode produces for an assembled item.
pub(crate) fn decoded_size(item: &J) -> usize {
    let kind = match item.get("type") {
        Some(J::Str(units)) => {
            let mut text = String::new();
            for unit in units {
                // Kinds are ASCII; anything else is not a known variant.
                if *unit > 0x7f {
                    return unknown_size(item);
                }
                text.push(*unit as u8 as char);
            }
            text
        }
        _ => return json_bytes(item),
    };
    match variant_of(kind.as_str()) {
        Some(variant) => variant_size(variant.extra, variant.defaults, item),
        None => unknown_size(item),
    }
}

/// The budget size of an assembled item: stored bytes for trusted rows, decoded bytes where
/// the shell decodes before the client sees it.
pub(crate) fn budget_size(item: &J, trusted_item: bool) -> usize {
    if trusted_item {
        json_bytes(item)
    } else {
        decoded_size(item)
    }
}
