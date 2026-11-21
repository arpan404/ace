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
/// The one rule with a lookahead: a file name line followed by its attachment fields.
#[allow(clippy::expect_used)]
static NAME_LINE: LazyLock<fancy_regex::Regex> = LazyLock::new(|| {
    fancy_regex::Regex::new(&s(
        r"(?im)^\s*(?:name|fileName):[^\n]*\n(?=\s*(?:mimeType|sizeBytes|attachmentId):)",
    ))
    .expect("a constant pattern")
});
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

/// The daemon's `[ace-origin:…]` prefix, kept for the provider but never shown to the person.
pub fn strip_ace_origin_marker(value: &str) -> String {
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
    clean(value, |text| LEADING_COMMAND.replace(text, "").into_owned())
}

/// The same clean-up, keeping a leading slash command.
pub fn sanitize_typed_text(value: &str) -> String {
    clean(value, str::to_owned)
}

fn clean(value: &str, command: impl Fn(&str) -> String) -> String {
    let mut text = strip_ace_origin_marker(js::trim(value));
    if INSTRUCTIONS.is_match(&text) {
        let marker = "</INSTRUCTIONS>";
        let Some(end) = text.find(marker) else {
            return String::new();
        };
        text = js::trim_start(&text[end + marker.len()..]).to_owned();
    }
    while let Some(opening) = OPENING.captures(&text) {
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
    let [image, attached, fields, leading] = &*PLACEHOLDERS;
    text = image.replace_all(&text, "").into_owned();
    text = attached.replace_all(&text, "").into_owned();
    text = NAME_LINE.replace_all(&text, "").into_owned();
    text = fields.replace_all(&text, "").into_owned();
    text = leading.replace(&text, "").into_owned();
    text = js::trim(&text).to_owned();
    for (pattern, global) in &*WRAPPERS {
        let replaced = if *global {
            pattern.replace_all(&text, "")
        } else {
            pattern.replace(&text, "")
        };
        text = js::trim(&replaced).to_owned();
    }
    text
}
