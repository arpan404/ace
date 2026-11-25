// SPDX-License-Identifier: Apache-2.0
//! A thread's provisional title from its first message (E5.4c, `packages/ui-core/src/thread-title.ts`
//! and `composer-markers.ts`): the first line with words in it, as plain words - no Markdown,
//! mentions, chips or file markers - collapsed to single spaces, at most 60 characters, cut at a
//! word boundary. Pure, and measured in UTF-16 code units as JavaScript measures a string.

use ace_adapter_api::util::is_js_space;
use ace_json::{JsString, Value};

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
        if rest
            .get(..prefix.len())
            .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
        {
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
        let words_start = if bytes[at] == b'!' && bytes.get(at + 1) == Some(&b'[') {
            Some(at + 2)
        } else if bytes[at] == b'[' {
            Some(at + 1)
        } else {
            None
        };
        // A link only when the whole `!?[...](...)` matches: otherwise every character stays.
        if let Some(words_start) = words_start
            && let Some(close) = line[words_start..]
                .find(']')
                .map(|index| words_start + index)
            && bytes.get(close + 1) == Some(&b'(')
            && let Some(url_end) = line[close + 2..].find(')').map(|index| close + 2 + index)
        {
            out.push_str(&line[words_start..close]);
            at = url_end + 1;
            continue;
        }
        out.push_str(&line[at..at + char_len(bytes, at)]);
        at += char_len(bytes, at);
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
///
/// The result is a JavaScript string, so a cut that lands inside a surrogate pair keeps the
/// lone surrogate the way `String.prototype.slice` does.
pub fn provisional_title(parts: &[Value], fallback: &str) -> JsString {
    let text = prose(&first_line(parts));
    if text.is_empty() {
        return JsString::from(fallback);
    }
    let text = JsString::from(text);
    if text.len_utf16() <= TITLE_LIMIT {
        return text;
    }
    // Room for the ellipsis inside the limit, in UTF-16 code units as JavaScript slices.
    let room = text.slice_units(0, TITLE_LIMIT - 1);
    let units: Vec<u16> = room.units().collect();
    let cut = match units.iter().rposition(|unit| *unit == u16::from(b' ')) {
        Some(space) if space > 0 => JsString::from_units(&units[..space]),
        _ => room,
    };
    let mut title = cut;
    title.push_js(&JsString::from("\u{2026}"));
    title
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
    fn a_bang_before_a_link_that_does_not_parse_stays_its_own_character() {
        // `!` then `[note]` with no `(url)`: the regex matches nothing, so the words keep the `!`.
        assert_eq!(
            provisional_title(&text("Hi![note] fix it"), UNTITLED_THREAD),
            "Hi![note] fix it"
        );
        // A real image link still reads as its words.
        assert_eq!(
            provisional_title(&text("Hi![shot](a.png) now"), UNTITLED_THREAD),
            "Hishot now"
        );
    }

    #[test]
    fn a_cut_inside_a_surrogate_pair_keeps_the_lone_surrogate() {
        // 58 units, then an astral character whose pair straddles the 59-unit cut.
        let mut long = "x".repeat(58);
        long.push('\u{1f600}');
        long.push_str(&"y".repeat(20));
        let title = provisional_title(&text(&long), UNTITLED_THREAD);
        let units: Vec<u16> = title.units().collect();
        assert_eq!(units.len(), TITLE_LIMIT);
        assert_eq!(units[58], 0xd83d, "the high surrogate is kept");
        assert_eq!(units[59], 0x2026);
        assert!(!title.is_well_formed());
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
