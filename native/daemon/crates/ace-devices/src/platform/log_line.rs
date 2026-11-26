// SPDX-License-Identifier: Apache-2.0
//! `log-line.ts`: simctl's structured envelope rendered as a readable log line. Android stays
//! plain text. Lengths are the TypeScript's: the line is cut to 65,536 UTF-16 units before it is
//! read, and what is shown to 4,096; an emoji at either bound is cut where `.slice` cuts it.

use std::sync::LazyLock;

use ace_json::JsString;
use regex::Regex;

/// The most of a log line that is read at all, in UTF-16 units.
pub const LINE_LIMIT: usize = 65_536;
/// The most of a rendered log line that is shown, in UTF-16 units.
pub const RENDER_LIMIT: usize = 4_096;

/// What a line that looks like an envelope but cannot be read says.
pub const UNREADABLE: &str = "Couldn't read a device log entry.";

/// The ANSI escape sequences Node's `stripVTControlCharacters` removes: `ansi-regex` 6, with
/// ASCII digit classes as JavaScript spells them.
const ANSI_PATTERN: &str = concat!(
    r"[\u{1B}\u{9B}][\[\]()#;?]*",
    r"(?:(?:(?:(?:;[-a-zA-Z0-9/#&.:=?%@~_]+)*|[a-zA-Z0-9]+(?:;[-a-zA-Z0-9/#&.:=?%@~_]*)*)?",
    r"(?:\u{7}|\u{1B}\u{5C}|\u{9C}))",
    r"|(?:(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-nq-uy=><~]))",
);

static ANSI: LazyLock<Option<Regex>> = LazyLock::new(|| Regex::new(ANSI_PATTERN).ok());

/// One line of a device's log, as the device view shows it.
pub fn device_log_line(line: &str) -> JsString {
    let clean = JsString::from(strip_vt(line)).slice_units(0, LINE_LIMIT);
    if !clean.as_str().trim_start().starts_with('{') {
        return clean.slice_units(0, RENDER_LIMIT);
    }
    render(&clean).unwrap_or_else(|| JsString::from(UNREADABLE))
}

/// simctl's envelope, or `None` when it is not the object the schema names.
fn render(clean: &JsString) -> Option<JsString> {
    let value = ace_json::parse(clean.as_str()).ok()?;
    let entry = value.as_object()?;
    let event = entry.get("eventMessage")?.as_js_str()?;
    let timestamp = match entry.get("timestamp") {
        None => None,
        Some(value) => Some(value.as_js_str()?),
    };
    let image = match entry.get("processImagePath") {
        None => None,
        Some(value) => Some(value.as_js_str()?),
    };
    let message = JsString::from(strip_vt(event.as_str()));
    let parts: Vec<JsString> = [
        timestamp.and_then(|text| first_time(text.as_str()).map(JsString::from)),
        image.map(|path| JsString::from(last_segment(path.as_str()))),
        Some(message),
    ]
    .into_iter()
    .flatten()
    .filter(|part| !part.is_empty())
    .collect();
    let mut out = JsString::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.push_str(" ");
        }
        out.push_js(part);
    }
    Some(out.slice_units(0, RENDER_LIMIT))
}

/// The first `HH:MM:SS` in a timestamp, as `/\d{2}:\d{2}:\d{2}/` finds it.
fn first_time(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    (0..bytes.len().saturating_sub(7)).find_map(|at| {
        let window = &bytes[at..at + 8];
        let shape = window[2] == b':'
            && window[5] == b':'
            && window
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 2 || index == 5 || byte.is_ascii_digit());
        shape.then(|| &text[at..at + 8])
    })
}

/// The last segment of a path split on `/`, as `split("/").at(-1)` gives it.
fn last_segment(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `stripVTControlCharacters`: every ANSI escape sequence removed, everything else kept.
fn strip_vt(text: &str) -> String {
    if !text.contains('\u{1b}') && !text.contains('\u{9b}') {
        return text.to_string();
    }
    match &*ANSI {
        Some(ansi) => ansi.replace_all(text, "").into_owned(),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(value: &JsString) -> Vec<u16> {
        value.units().collect()
    }

    #[test]
    fn the_ansi_pattern_compiles() {
        assert!(ANSI.is_some());
    }

    #[test]
    fn control_sequences_are_stripped_as_node_strips_them() {
        assert_eq!(strip_vt("\u{1b}[31mred\u{1b}[0m"), "red");
        assert_eq!(strip_vt("\u{9b}31mred\u{9b}0m"), "red");
        assert_eq!(strip_vt("a\u{1b}]0;title\u{7}b"), "ab");
        assert_eq!(strip_vt("plain"), "plain");
        assert_eq!(strip_vt("\u{1b}[2K\u{1b}[1Gx"), "x");
    }

    #[test]
    fn a_plain_line_is_cut_to_4096_utf16_units_and_keeps_an_emoji_cut_in_half() {
        let line = "a".repeat(5000);
        assert_eq!(device_log_line(&line).len_utf16(), RENDER_LIMIT);
        // 4,095 units then an astral character: its second unit is the 4,097th.
        let line = format!("{}\u{1f600}", "a".repeat(4_095));
        let shown = device_log_line(&line);
        assert_eq!(shown.len_utf16(), RENDER_LIMIT);
        assert!(
            !shown.is_well_formed(),
            "the cut leaves a lone high surrogate"
        );
        assert_eq!(units(&shown).last(), Some(&0xd83d));
    }

    #[test]
    fn an_envelope_renders_time_process_and_message() {
        let line = r#"{"eventMessage":"hello","timestamp":"2026-11-25 12:34:56.789 +0000","processImagePath":"/usr/libexec/foo"}"#;
        assert_eq!(device_log_line(line).as_str(), "12:34:56 foo hello");
        let line = r#"{"eventMessage":"hello","processImagePath":"/usr/libexec/foo"}"#;
        assert_eq!(device_log_line(line).as_str(), "foo hello");
        let line = r#"{"eventMessage":"","processImagePath":"/x/y"}"#;
        assert_eq!(device_log_line(line).as_str(), "y");
        let line = r#"{"eventMessage":"hi"}"#;
        assert_eq!(device_log_line(line).as_str(), "hi");
    }

    #[test]
    fn an_envelope_cuts_its_message_to_4096_units_keeping_an_emoji_cut_in_half() {
        let message = format!("{}\u{1f600}", "a".repeat(4_095));
        let line = format!(r#"{{"eventMessage":"{message}"}}"#);
        let shown = device_log_line(&line);
        assert_eq!(shown.len_utf16(), RENDER_LIMIT);
        assert!(!shown.is_well_formed());
    }

    #[test]
    fn a_message_with_control_sequences_is_cleaned_before_it_is_shown() {
        let line = r#"{"eventMessage":"\u001b[31mred\u001b[0m"}"#;
        assert_eq!(device_log_line(line).as_str(), "red");
    }

    #[test]
    fn a_line_that_is_not_the_envelope_says_so_rather_than_guessing() {
        for line in [
            "{",
            "{}",
            r#"{"eventMessage":1}"#,
            r#"{"eventMessage":"x","timestamp":null}"#,
            r#"{"eventMessage":"x","processImagePath":false}"#,
        ] {
            assert_eq!(device_log_line(line).as_str(), UNREADABLE, "{line}");
        }
        // Only a line that begins with an object is read as the envelope.
        assert_eq!(device_log_line("[1,2,3]").as_str(), "[1,2,3]");
    }

    #[test]
    fn the_read_cut_at_65536_units_does_not_stop_a_prefix_from_being_shown() {
        let line = "b".repeat(LINE_LIMIT + 100);
        assert_eq!(device_log_line(&line).len_utf16(), RENDER_LIMIT);
    }
}
