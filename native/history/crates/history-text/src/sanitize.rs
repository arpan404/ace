// SPDX-License-Identifier: Apache-2.0

//! `sanitizeUserText` and `sanitizeTypedText` (`packages/native-session/src/user-text.ts`): the
//! context envelopes CLIs and IDEs save around a person's words, removed before display.

use std::sync::LazyLock;

use regex::Regex;

use crate::js::{self, SPACE_CLASS};

const CONTEXT_TAGS: [&str; 10] = [
    "recommended_plugins",
    "local-command-caveat",
    "local-command-stdout",
    "environment_context",
    "user_instructions",
    "system-reminder",
    "skills_instructions",
    "plugins_instructions",
    "command-name",
    "command-message",
];

/// JavaScript's ASCII `\b`.
const B: &str = r"(?-u:\b)";

#[allow(clippy::expect_used)]
fn compile(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a constant pattern")
}

fn s(pattern: &str) -> String {
    pattern
        .replace("\\s", &format!("[{SPACE_CLASS}]"))
        .replace("\\b", B)
}

static CONTEXT_OPENING: LazyLock<Regex> = LazyLock::new(|| {
    compile(&s(&format!(
        r"(?i)<({})(?:\s[^>]*)?>",
        CONTEXT_TAGS.join("|")
    )))
});
static ACE_ORIGIN: LazyLock<Regex> = LazyLock::new(|| compile(r"^\[ace-origin:[^\]\r\n]+\]\n?"));
static INSTRUCTIONS: LazyLock<Regex> =
    LazyLock::new(|| compile(&s(r"(?i)^#\s+(?:AGENTS|CLAUDE)\.md\b")));
static OPENING: LazyLock<Regex> =
    LazyLock::new(|| compile(&s(r"^<([A-Za-z0-9_][A-Za-z0-9_:-]*)(?:\s[^>]*)?>")));
static LEADING_COMMAND: LazyLock<Regex> =
    LazyLock::new(|| compile(&s(r"^/(?:[A-Za-z0-9_-]+)(?:\s|$)")));
static PLACEHOLDERS: LazyLock<[Regex; 4]> = LazyLock::new(|| {
    [
        compile(&s(r"(?i)\[(?:Image|Attachment)(?:\s*[0-9]+|\s*:)[^\]]*\]")),
        compile(&s(
            r"(?i)\[Attached (?:image|file|screenshot)\b[^\]]*(?:saved at|saved to):?[^\]]*\]",
        )),
        compile(&s(
            r"(?im)^\s*(?:mimeType|sizeBytes|attachmentId):[^\n]*(?:\n|$)",
        )),
        compile(&s(
            r"(?i)^\s*(?:\[?Attached (?:image|file|screenshot)[^\n]*|<image>)[\n]?",
        )),
    ]
});
/// A file name line; removed only when attachment fields follow it (the TypeScript rule's
/// lookahead, checked by [`FIELD_AHEAD`] where the line ends).
static NAME_LINE: LazyLock<Regex> =
    LazyLock::new(|| compile(&s(r"(?im)^\s*(?:name|fileName):[^\n]*\n")));
static FIELD_AHEAD: LazyLock<Regex> =
    LazyLock::new(|| compile(&s(r"(?i)^\s*(?:mimeType|sizeBytes|attachmentId):")));
/// Standalone handoffs contain generated instructions rather than a new request. The bool says
/// whether every match is replaced (`/g`) or only the first.
static WRAPPERS: LazyLock<[(Regex, bool); 5]> = LazyLock::new(|| {
    [
        (
            compile(&s(
                r"(?i)^The user interrupted the previous turn on purpose\b(?s:.)*",
            )),
            false,
        ),
        (
            compile(&s(
                r"(?i)^A previous agent produced the plan below\b(?s:.)*",
            )),
            false,
        ),
        (
            compile(&s(
                r"(?i)^Continue this conversation using the transcript context below\b(?s:.)*",
            )),
            false,
        ),
        (
            compile(&s(
                r"(?i)\[User attached one or more images\b[^\]]*(?:\]|$)",
            )),
            true,
        ),
        (compile(&s(r"(?i)^Title request:\s*")), false),
    ]
});

/// `/^\s*(?:name|fileName):[^\n]*\n(?=\s*(?:mimeType|sizeBytes|attachmentId):)/gim`. A match
/// can only start at a name line and always ends where that line does, so a candidate whose
/// lookahead fails rules out every match starting inside it too.
fn without_name_lines(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut kept = 0;
    for candidate in NAME_LINE.find_iter(text) {
        if FIELD_AHEAD.is_match(&text[candidate.end()..]) {
            out.push_str(&text[kept..candidate.start()]);
            kept = candidate.end();
        }
    }
    out.push_str(&text[kept..]);
    out
}

/// Whether `text` contains `needle`, ignoring ASCII case.
fn has_ignore_case(text: &str, needle: &str) -> bool {
    text.as_bytes()
        .windows(needle.len())
        .any(|w| w.eq_ignore_ascii_case(needle.as_bytes()))
}

/// Whether `text` starts with `prefix`, ignoring ASCII case.
fn starts_ignore_case(text: &str, prefix: &str) -> bool {
    text.as_bytes()
        .get(..prefix.len())
        .is_some_and(|p| p.eq_ignore_ascii_case(prefix.as_bytes()))
}

/// The daemon's `[ace-origin:…]` prefix, kept for the provider but never shown to the person.
pub fn strip_ace_origin_marker(value: &str) -> String {
    if !value.starts_with("[ace-origin:") {
        return value.to_owned();
    }
    ACE_ORIGIN.replace(value, "").into_owned()
}

fn tokens(tag: &str, insensitive: bool) -> Regex {
    let flags = if insensitive { "(?i)" } else { "" };
    compile(&s(&format!(
        r"{flags}<(/?){}(?:\s[^>]*)?>",
        regex::escape(tag)
    )))
}

/// Also hides nested and unfinished envelopes in a streamed text part.
fn without_context_blocks(value: &str) -> String {
    let mut text = value.to_owned();
    if !text.contains('<') {
        return text;
    }
    loop {
        let Some(opening) = CONTEXT_OPENING.captures(&text) else {
            return text;
        };
        let (Some(whole), Some(tag)) = (opening.get(0), opening.get(1)) else {
            return text;
        };
        let start = whole.start();
        let tokens = tokens(tag.as_str(), true);
        let mut depth = 0i64;
        let mut end = text.len();
        for token in tokens.captures_iter(&text[start..]) {
            depth += if token.get(1).is_some_and(|m| !m.is_empty()) {
                -1
            } else {
                1
            };
            if depth == 0 {
                end = start + token.get(0).map_or(0, |m| m.end());
                break;
            }
        }
        text = format!("{}{}", &text[..start], &text[end..]);
    }
}

/// Remove the context envelopes saved by CLIs and IDEs, and a leading slash command.
pub fn sanitize_user_text(value: &str) -> String {
    clean(value, |text| {
        if text.starts_with('/') {
            LEADING_COMMAND.replace(text, "").into_owned()
        } else {
            text.to_owned()
        }
    })
}

/// The same clean-up, keeping a leading slash command.
pub fn sanitize_typed_text(value: &str) -> String {
    clean(value, str::to_owned)
}

fn clean(value: &str, command: impl Fn(&str) -> String) -> String {
    let mut text = strip_ace_origin_marker(js::trim(value));
    if text.starts_with('#') && INSTRUCTIONS.is_match(&text) {
        let marker = "</INSTRUCTIONS>";
        let Some(end) = text.find(marker) else {
            return String::new();
        };
        text = js::trim_start(&text[end + marker.len()..]).to_owned();
    }
    while text.starts_with('<')
        && let Some(opening) = OPENING.captures(&text)
    {
        let (Some(whole), Some(tag)) = (opening.get(0), opening.get(1)) else {
            break;
        };
        let tag = tag.as_str().to_owned();
        let opening_len = whole.end();
        // Other XML belongs to the person, including incomplete examples.
        if tag != "command-args" && !CONTEXT_TAGS.contains(&tag.as_str()) {
            break;
        }
        let mut depth = 0i64;
        let mut end = 0;
        for token in tokens(&tag, false).captures_iter(&text) {
            depth += if token.get(1).is_some_and(|m| !m.is_empty()) {
                -1
            } else {
                1
            };
            if depth == 0 {
                end = token.get(0).map_or(0, |m| m.end());
                break;
            }
        }
        // A cut-off injected envelope must never become a title.
        if end == 0 {
            return String::new();
        }
        let inner = &text[opening_len.min(end)..end];
        let close = format!("</{tag}>");
        let block = inner.strip_suffix(close.as_str()).unwrap_or(inner);
        let rest = &text[end..];
        text = if tag == "command-args" {
            format!("{block}\n{rest}")
        } else {
            rest.to_owned()
        };
        text = js::trim_start(&text).to_owned();
    }
    let mut text = command(&without_context_blocks(&text));
    // Each rule is skipped when its text cannot match, without changing what it removes.
    let [image, attached, fields, leading] = &*PLACEHOLDERS;
    if text.contains('[') {
        text = image.replace_all(&text, "").into_owned();
        text = attached.replace_all(&text, "").into_owned();
    }
    if text.contains(':') {
        text = without_name_lines(&text);
        text = fields.replace_all(&text, "").into_owned();
    }
    if has_ignore_case(&text, "attached") || text.contains("<image>") {
        text = leading.replace(&text, "").into_owned();
    }
    text = js::trim(&text).to_owned();
    let prefixes = [
        "The user interrupted",
        "A previous agent",
        "Continue this conversation",
        "",
        "Title request:",
    ];
    for ((pattern, global), prefix) in WRAPPERS.iter().zip(prefixes) {
        let possible = if *global {
            has_ignore_case(&text, "[User attached")
        } else {
            starts_ignore_case(&text, prefix)
        };
        if possible {
            let replaced = if *global {
                pattern.replace_all(&text, "")
            } else {
                pattern.replace(&text, "")
            };
            text = js::trim(&replaced).to_owned();
        }
    }
    text
}
