// SPDX-License-Identifier: Apache-2.0
//! A thread's provisional title from its first message (E5.4c, `packages/ui-core/src/thread-title.ts`
//! and `composer-markers.ts`): the first line with words in it, as plain words - no Markdown,
//! mentions, chips or file markers - collapsed to single spaces, at most 60 characters, cut at a
//! word boundary. Pure, and measured in UTF-16 code units as JavaScript measures a string.

use ace_adapter_api::util::is_js_space;
use ace_json::Value;

use crate::inputs::signature::without_portable_handoff;

/// What a thread is called until its first message has words in it (`thread-title.ts:14`).
pub const UNTITLED_THREAD: &str = "New thread";

/// The file marker a composer leaves in a message's words (`composer-markers.ts:15`).
pub const ATTACHMENT_MARKER: char = '\u{fffc}';

/// The most characters a provisional title keeps (`thread-title.ts:18`).
const TITLE_LIMIT: usize = 60;

/// JavaScript's `line.trim()` before the first line with anything in it.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_space)
}

/// `text.split(/\r?\n/)` for one line's start: the text up to the next break and where it ends.
fn next_line(text: &str, from: usize) -> (usize, usize) {
    let bytes = text.as_bytes();
    let mut end = from;
    while end < bytes.len() {
        if bytes[end] == b'\n' {
            let line_end = if end > from && bytes[end - 1] == b'\r' {
                end - 1
            } else {
                end
            };
            return (line_end, end + 1);
        }
        end += 1;
    }
    (text.len(), text.len())
}

/// The first line of the message's text that has anything but spaces in it.
fn first_line(parts: &[Value]) -> String {
    let joined = without_portable_handoff(parts)
        .iter()
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
        .map(|part| part.get("text").and_then(Value::as_str).unwrap_or_default())
        .collect::<Vec<&str>>()
        .join("\n");
    let mut at = 0;
    while at <= joined.len() {
        let (end, next) = next_line(&joined, at);
        let line = &joined[at..end];
        if !js_trim(line).is_empty() {
            return line.to_owned();
        }
        if next >= joined.len() {
            break;
        }
        at = next;
    }
    String::new()
}

/// The shortest case-insensitive prefix among the chip markers, after a `[`.
fn chip_prefix(rest: &str) -> Option<usize> {
    for prefix in ["file:", "image:", "attachment:"] {
        if rest.len() >= prefix.len() && rest[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return Some(prefix.len());
        }
    }
    None
}

/// `[words](url)` and `![alt](url)`: the words stay (`thread-title.ts:31`).
fn without_links(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    while at < bytes.len() {
        let open = if bytes[at] == b'!' && bytes.get(at + 1) == Some(&b'[') {
            at + 1
        } else if bytes[at] == b'[' {
            at
        } else {
            out.push_str(&line[at..at + char_len(bytes, at)]);
            at += char_len(bytes, at);
            continue;
        };
        let words_start = open + 1;
        let Some(close) = line[words_start..]
            .find(']')
            .map(|index| words_start + index)
        else {
            out.push('[');
            at = open + 1;
            continue;
        };
        if bytes.get(close + 1) != Some(&b'(') {
            out.push('[');
            at = open + 1;
            continue;
        }
        let Some(url_end) = line[close + 2..].find(')').map(|index| close + 2 + index) else {
            out.push('[');
            at = open + 1;
            continue;
        };
        out.push_str(&line[words_start..close]);
        at = url_end + 1;
    }
    out
}

/// The UTF-8 length of the character starting at `at` (a byte inside one never starts a scan).
fn char_len(bytes: &[u8], at: usize) -> usize {
    let byte = bytes[at];
    if byte < 0x80 {
        1
    } else if byte >> 5 == 0b110 {
        2
    } else if byte >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// `[file: a.png]`, `[image: ...]`, `[attachment: ...]`: a chip, not words.
fn without_chips(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::with_capacity(line.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'['
            && let Some(prefix) = chip_prefix(&line[at + 1..])
            && let Some(close) = line[at + 1 + prefix..]
                .find(']')
                .map(|index| at + 1 + prefix + index)
        {
            at = close + 1;
            continue;
        }
        out.push_str(&line[at..at + char_len(bytes, at)]);
        at += char_len(bytes, at);
    }
    out
}

/// A file's place in a composer's words: its chip, not words.
fn without_markers(line: &str) -> String {
    line.chars()
        .filter(|character| *character != ATTACHMENT_MARKER)
        .collect()
}

/// Emphasis and code marks, before mentions so `**@name**` reads as a mention.
fn without_emphasis(line: &str) -> String {
    line.chars()
        .filter(|character| !matches!(character, '*' | '_' | '`' | '~'))
        .collect()
}

/// `\w` in a JavaScript regular expression.
fn is_word(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '_'
}

/// `@path/to/file`: a mention, not words (an email's `@` follows a letter, so it stays).
fn without_mentions(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut previous: Option<char> = None;
    let mut at = 0;
    let characters: Vec<char> = line.chars().collect();
    while at < characters.len() {
        let character = characters[at];
        let starts = previous.is_none_or(is_js_space);
        if character == '@' && starts {
            let end = characters[at + 1..]
                .iter()
                .take_while(|next| is_word(**next) || matches!(**next, '.' | '/' | '-'))
                .count();
            if end > 0 {
                at += 1 + end;
                previous = characters.get(at - 1).copied();
                continue;
            }
        }
        out.push(character);
        previous = Some(character);
        at += 1;
    }
    out
}

/// A heading, quote or list marker before the words, then single spaces.
fn without_markers_and_space(line: &str) -> String {
    let characters: Vec<char> = line.chars().collect();
    let start = characters
        .iter()
        .position(|character| {
            !(is_js_space(*character) || matches!(*character, '#' | '>' | '+' | '-'))
        })
        .unwrap_or(characters.len());
    let mut out = String::with_capacity(line.len());
    let mut spacing = false;
    for character in &characters[start..] {
        if is_js_space(*character) {
            spacing = true;
            continue;
        }
        if spacing && !out.is_empty() {
            out.push(' ');
        }
        spacing = false;
        out.push(*character);
    }
    out
}

/// The line as plain words: links read as their words; chips, mentions and markup go.
fn prose(line: &str) -> String {
    let line = without_links(line);
    let line = without_chips(&line);
    let line = without_markers(&line);
    let line = without_emphasis(&line);
    let line = without_mentions(&line);
    without_markers_and_space(&line)
}

/// The provisional title for a first message (`thread-title.ts:60`): "Fix the login redirect"
/// for "# **Fix** @agent the [login](...) redirect". Longer than 60 characters, it ends at the
/// last word that fits, with an ellipsis.
pub fn provisional_title(parts: &[Value], fallback: &str) -> String {
    let text = prose(&first_line(parts));
    if text.is_empty() {
        return fallback.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= TITLE_LIMIT {
        return text;
    }
    // Room for the ellipsis inside the limit.
    let room = String::from_utf16_lossy(&units[..TITLE_LIMIT - 1]);
    let cut = match room.rfind(' ') {
        Some(space) if space > 0 => &room[..space],
        _ => room.as_str(),
    };
    format!("{cut}\u{2026}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(value: &str) -> Vec<Value> {
        let mut part = ace_json::Map::new();
        part.insert("type", Value::from("text"));
        part.insert("text", Value::from(value));
        vec![Value::Object(part)]
    }

    #[test]
    fn markup_mentions_and_links_read_as_plain_words() {
        assert_eq!(
            provisional_title(
                &text("# **Fix** @agent the [login](https://example.com) redirect"),
                UNTITLED_THREAD
            ),
            "Fix the login redirect"
        );
        // A chip and a stray marker are not words; an email's `@` stays.
        let parts = text("[file: a.png] mail me at me@example.com  [image: b] then go");
        assert_eq!(
            provisional_title(&parts, UNTITLED_THREAD),
            "mail me at me@example.com then go"
        );
        // A heading or quote marker before the words goes, and inner runs collapse.
        assert_eq!(
            provisional_title(&text(">   one    two"), UNTITLED_THREAD),
            "one two"
        );
    }

    #[test]
    fn the_first_line_with_words_wins_and_an_empty_one_falls_back() {
        assert_eq!(
            provisional_title(&text("   \n\n  second line\nthird"), UNTITLED_THREAD),
            "second line"
        );
        assert_eq!(
            provisional_title(&text(" \n *  * "), UNTITLED_THREAD),
            UNTITLED_THREAD
        );
        assert_eq!(provisional_title(&[], "Untitled"), "Untitled");
    }

    #[test]
    fn a_long_title_ends_at_the_last_word_that_fits_within_sixty_characters() {
        let long = "one two three four five six seven eight nine ten eleven twelve";
        let title = provisional_title(&text(long), UNTITLED_THREAD);
        assert_eq!(
            title,
            "one two three four five six seven eight nine ten eleven\u{2026}"
        );
        assert!(title.encode_utf16().count() <= TITLE_LIMIT);
        // One word longer than the limit is cut inside it.
        let word = provisional_title(&text(&"x".repeat(70)), UNTITLED_THREAD);
        assert_eq!(word, format!("{}\u{2026}", "x".repeat(59)));
    }
}
