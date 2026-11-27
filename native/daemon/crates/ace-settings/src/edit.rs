// SPDX-License-Identifier: Apache-2.0
//! Path edits for a JSONC settings file (`jsonc-parser`'s `modify`): one property's value is
//! replaced, inserted or removed, and every comment, the indentation and the line ending
//! style of the rest of the file stay where they are.

use serde_json::Value;

use crate::jsonc::{Segment, detect_indent, line_indent, parse_document};
use crate::validation::{SettingsCode, SettingsError};

fn error(message: &str) -> SettingsError {
    SettingsError::new(SettingsCode::Validation, message)
}

fn eol_of(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

/// The value as `jsonc-parser` writes it: multi-line, one level deeper than `indent`.
fn format_value(value: &Value, indent: &str, unit: &str, eol: &str) -> String {
    match value {
        Value::Object(entries) if !entries.is_empty() => {
            let child = format!("{indent}{unit}");
            let mut out = String::from("{");
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(eol);
                out.push_str(&child);
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push_str(": ");
                out.push_str(&format_value(item, &child, unit, eol));
            }
            out.push_str(eol);
            out.push_str(indent);
            out.push('}');
            out
        }
        Value::Array(items) if !items.is_empty() => {
            let child = format!("{indent}{unit}");
            let mut out = String::from("[");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(eol);
                out.push_str(&child);
                out.push_str(&format_value(item, &child, unit, eol));
            }
            out.push_str(eol);
            out.push_str(indent);
            out.push(']');
            out
        }
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Replaces the value at `path`, or removes the property when `value` is `None`.
///
/// `path` names object properties from the document root, as `edit(text, ["settings", key])`
/// does in the TypeScript; the parent object must exist.
pub fn modify(text: &str, path: &[&str], value: Option<&Value>) -> Result<String, SettingsError> {
    let Some((key, parent_path)) = path.split_last() else {
        return Err(error("Settings document has no settings object"));
    };
    let scanned = parse_document(text)?;
    let segments: Vec<Segment> = parent_path
        .iter()
        .map(|step| Segment::Key((*step).to_owned()))
        .collect();
    let Some(parent) = scanned.layouts.get(&segments) else {
        return Err(error("Settings document has no settings object"));
    };
    let unit = detect_indent(text);
    let eol = eol_of(text);
    if let Some(span) = parent.properties.get(*key) {
        let Some(value) = value else {
            // Removal takes the leading comment and whitespace with the property, and the
            // comma that would otherwise dangle, as `jsonc-parser` does.
            let start = span.comma_before.unwrap_or(parent.open);
            let end = if span.comma_before.is_none() {
                span.comma_after
                    .map(|comma| comma + 1)
                    .unwrap_or(span.value_end)
            } else {
                span.value_end
            };
            let mut out = String::with_capacity(text.len());
            out.push_str(&text[..start]);
            out.push_str(&text[end..]);
            return Ok(out);
        };
        let existing = text[span.value_start..span.value_end].trim_start();
        let container = existing.starts_with(['{', '[']);
        let content = if container || value.is_object() || value.is_array() {
            format_value(value, &line_indent(text, span.key_start), &unit, eol)
        } else {
            serde_json::to_string(value).unwrap_or_default()
        };
        let mut out = String::with_capacity(text.len() + content.len());
        out.push_str(&text[..span.value_start]);
        out.push_str(&content);
        out.push_str(&text[span.value_end..]);
        return Ok(out);
    }
    let Some(value) = value else {
        return Ok(text.to_owned());
    };
    let property = format!(
        "{}: {}",
        serde_json::to_string(key).unwrap_or_default(),
        format_value(value, &parent.indent, &unit, eol)
    );
    let mut out = String::with_capacity(text.len() + property.len() + 2);
    match parent.last_value_end {
        Some(last) => {
            // After the last value, before a comment that trails it.
            out.push_str(&text[..last]);
            out.push(',');
            out.push_str(eol);
            out.push_str(&parent.indent);
            out.push_str(&property);
            out.push_str(&text[last..]);
        }
        None => {
            // An empty object: the property on its own line, and whatever trivia the object
            // already held (a comment, say) kept after it.
            let inner = text[parent.open..parent.close].trim_end();
            let closing = parent
                .indent
                .strip_suffix(unit.as_str())
                .unwrap_or_default();
            out.push_str(&text[..parent.open]);
            out.push_str(eol);
            out.push_str(&parent.indent);
            out.push_str(&property);
            out.push_str(inner);
            out.push_str(eol);
            out.push_str(closing);
            out.push_str(&text[parent.close..]);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    //! The `jsonc-parser.modify` cases the document and its migrations rely on: an insertion
    //! keeps a comment and uses the file's indentation, a removal takes its comment too, and
    //! a replacement keeps the rest of the file byte for byte.

    use super::*;
    use serde_json::json;

    #[test]
    fn an_insertion_into_an_empty_object_keeps_its_comment_and_indentation() {
        let text = "{\n  \"version\": 2,\n  \"settings\": { /* keep */ }\n}\n";
        let next = modify(
            text,
            &["settings", "threads.sortBy"],
            Some(&json!("manual")),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            next,
            "{\n  \"version\": 2,\n  \"settings\": {\n    \"threads.sortBy\": \"manual\" /* keep */\n  }\n}\n"
        );
    }

    #[test]
    fn an_insertion_after_a_commented_value_keeps_the_files_own_indentation() {
        let text = "{\n    \"version\": 2,\n    \"settings\": {\n        \"future\": 1 // describes future\n    }\n}\n";
        let next = modify(
            text,
            &["settings", "threads.sortBy"],
            Some(&json!("manual")),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert!(
            next.contains("        \"threads.sortBy\": \"manual\""),
            "{next}"
        );
        assert!(next.contains("// describes future"));
        assert!(parse_document(&next).is_ok());
    }

    #[test]
    fn a_tabbed_file_keeps_its_tabs() {
        let text = "{\n\t\"version\": 2,\n\t\"settings\": {\n\t}\n}\n";
        let next = modify(
            text,
            &["settings", "threads.sortBy"],
            Some(&json!("manual")),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            next,
            "{\n\t\"version\": 2,\n\t\"settings\": {\n\t\t\"threads.sortBy\": \"manual\"\n\t}\n}\n"
        );
    }

    #[test]
    fn a_removal_takes_its_leading_comment_and_leaves_no_blank_line() {
        let text = "{\n  \"version\": 2,\n  \"settings\": {\n    // about a\n    \"a\": 1,\n    \"b\": 2\n  }\n}\n";
        let next = modify(text, &["settings", "a"], None).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(
            next,
            "{\n  \"version\": 2,\n  \"settings\": {\n    \"b\": 2\n  }\n}\n"
        );
    }

    #[test]
    fn an_object_value_is_written_with_the_files_indentation_and_line_endings() {
        let text = "{\r\n  \"version\": 1,\r\n  \"values\": {\r\n    \"threads.sortBy\": \"manual\"\r\n  }\r\n}\r\n";
        let value = json!({ "threads.sortBy": "manual" });
        let next =
            modify(text, &["settings"], Some(&value)).unwrap_or_else(|error| panic!("{error}"));
        assert!(
            next.contains("\r\n  \"settings\": {\r\n    \"threads.sortBy\": \"manual\"\r\n  }\r\n"),
            "{next}"
        );
    }

    #[test]
    fn removing_an_absent_property_is_a_no_op() {
        let text = "{\n  \"version\": 2,\n  \"settings\": {}\n}\n";
        assert_eq!(
            modify(text, &["settings", "threads.sortBy"], None)
                .unwrap_or_else(|error| panic!("{error}")),
            text
        );
    }
}
