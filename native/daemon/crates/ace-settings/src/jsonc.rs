// SPDX-License-Identifier: Apache-2.0
//! Reading and editing a JSONC settings file (`jsonc.ts`).
//!
//! A person's file may carry comments and trailing commas, and edits must leave both
//! where they are. The scanner validates every decoded value and property name before
//! the object parser can overwrite a duplicate, records each known setting's scalar
//! range in UTF-16 units (the protocol's offsets), and keeps enough layout to replace a
//! scalar, insert a setting or remove one without rewriting the rest of the file.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

use crate::schema::is_key;
use crate::validation::{
    MAX_DOCUMENT_BYTES, SettingsCode, SettingsError, guard_property, guard_secrets,
};

/// One scalar's whereabouts: byte offsets into the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScalarRange {
    pub start: usize,
    pub end: usize,
}

/// Where a setting's property begins and its value ends, for edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PropertySpan {
    pub key_start: usize,
    pub value_end: usize,
    pub comma_before: Option<usize>,
    pub comma_after: Option<usize>,
}

/// The `settings` object's layout.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SettingsLayout {
    pub open: usize,
    pub close: usize,
    pub indent: String,
    pub properties: BTreeMap<String, PropertySpan>,
    pub last_value_end: Option<usize>,
}

/// A scanned document: its value, size and scalar ranges.
#[derive(Debug, Clone)]
pub struct Scanned {
    pub value: Value,
    pub bytes: usize,
    pub ranges: BTreeMap<String, ScalarRange>,
    pub layout: Option<SettingsLayout>,
    pub text: String,
}

impl Scanned {
    /// A setting's scalar range in UTF-16 units, as the protocol reports offsets.
    pub fn utf16_range(&self, key: &str) -> Option<(usize, usize)> {
        let range = self.ranges.get(key)?;
        Some((
            utf16_len(&self.text[..range.start]),
            utf16_len(&self.text[range.start..range.end]),
        ))
    }
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

struct Scanner<'a> {
    text: &'a str,
    bytes: &'a [u8],
    at: usize,
    objects: Vec<Option<BTreeSet<String>>>,
    ranges: BTreeMap<String, ScalarRange>,
    layout: Option<SettingsLayout>,
    syntax: Option<usize>,
    duplicate: Option<usize>,
}

type Scan<T> = Result<T, SettingsError>;

impl<'a> Scanner<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            bytes: text.as_bytes(),
            at: 0,
            objects: Vec::new(),
            ranges: BTreeMap::new(),
            layout: None,
            syntax: None,
            duplicate: None,
        }
    }

    fn offset(&self, at: usize) -> usize {
        utf16_len(&self.text[..at])
    }

    fn fail(&mut self, at: usize) -> SettingsError {
        if self.syntax.is_none() {
            self.syntax = Some(self.offset(at));
        }
        SettingsError::new(SettingsCode::Validation, "Invalid JSONC settings")
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn skip_trivia(&mut self) -> Scan<()> {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r') => self.at += 1,
                Some(b'/') => match self.bytes.get(self.at + 1) {
                    Some(b'/') => {
                        self.at += 2;
                        while let Some(byte) = self.peek() {
                            self.at += 1;
                            if byte == b'\n' {
                                break;
                            }
                        }
                    }
                    Some(b'*') => {
                        self.at += 2;
                        let start = self.at;
                        let mut closed = false;
                        while self.at + 1 < self.bytes.len() {
                            if self.bytes[self.at] == b'*' && self.bytes[self.at + 1] == b'/' {
                                self.at += 2;
                                closed = true;
                                break;
                            }
                            self.at += 1;
                        }
                        if !closed {
                            return Err(self.fail(start));
                        }
                    }
                    _ => return Ok(()),
                },
                _ => return Ok(()),
            }
        }
    }

    fn parse_string(&mut self) -> Scan<String> {
        let start = self.at;
        if self.peek() != Some(b'"') {
            return Err(self.fail(start));
        }
        self.at += 1;
        while let Some(byte) = self.peek() {
            match byte {
                b'"' => {
                    self.at += 1;
                    let slice = &self.text[start..self.at];
                    return serde_json::from_str::<String>(slice).map_err(|_| self.fail(start));
                }
                b'\\' => {
                    self.at += 2;
                    if self.at > self.bytes.len() {
                        return Err(self.fail(start));
                    }
                }
                _ => self.at += 1,
            }
        }
        Err(self.fail(start))
    }

    // The path stack is pushed and popped by `parse_object`; one shared stack follows
    // the nesting, so it is a vector by design.
    #[allow(clippy::ptr_arg)]
    fn parse_value(&mut self, path: &mut Vec<String>, depth: usize) -> Scan<Value> {
        if depth > 64 {
            return Err(SettingsError::new(
                SettingsCode::Size,
                "Settings nesting exceeds 64 levels",
            ));
        }
        self.skip_trivia()?;
        let start = self.at;
        let value = match self.peek() {
            Some(b'{') => self.parse_object(path, depth)?,
            Some(b'[') => self.parse_array(path, depth)?,
            Some(b'"') => {
                let text = self.parse_string()?;
                guard_secrets(&Value::String(text.clone()))?;
                self.record(path, start, self.at, &Value::String(text.clone()));
                Value::String(text)
            }
            Some(b't') => self.literal("true", Value::Bool(true), start, path)?,
            Some(b'f') => self.literal("false", Value::Bool(false), start, path)?,
            Some(b'n') => self.literal("null", Value::Null, start, path)?,
            Some(b'-' | b'0'..=b'9') => self.number(start, path)?,
            _ => return Err(self.fail(start)),
        };
        Ok(value)
    }

    #[allow(clippy::ptr_arg)]
    fn literal(
        &mut self,
        word: &str,
        value: Value,
        start: usize,
        path: &mut Vec<String>,
    ) -> Scan<Value> {
        if self.text[self.at..].starts_with(word) {
            self.at += word.len();
            self.record(path, start, self.at, &value);
            Ok(value)
        } else {
            Err(self.fail(start))
        }
    }

    #[allow(clippy::ptr_arg)]
    fn number(&mut self, start: usize, path: &mut Vec<String>) -> Scan<Value> {
        self.at += 1;
        while let Some(byte) = self.peek() {
            if byte.is_ascii_digit() || matches!(byte, b'.' | b'e' | b'E' | b'+' | b'-') {
                self.at += 1;
            } else {
                break;
            }
        }
        let value: Value =
            serde_json::from_str(&self.text[start..self.at]).map_err(|_| self.fail(start))?;
        self.record(path, start, self.at, &value);
        Ok(value)
    }

    /// Records a scalar's range when it is a known setting directly under `settings`.
    fn record(&mut self, path: &[String], start: usize, end: usize, value: &Value) {
        if path.len() == 2 && path[0] == "settings" && is_key(&path[1]) {
            let _ = value;
            self.ranges
                .insert(path[1].clone(), ScalarRange { start, end });
        }
    }

    fn parse_object(&mut self, path: &mut Vec<String>, depth: usize) -> Scan<Value> {
        let open = self.at;
        self.at += 1;
        let tracking = path.is_empty();
        let settings = path.len() == 1 && path[0] == "settings";
        let mut layout = if settings {
            self.layout.clone().unwrap_or_default()
        } else {
            SettingsLayout::default()
        };
        if settings {
            layout.open = self.at;
            layout.indent = detect_indent(self.text);
        }
        self.objects.push(Some(BTreeSet::new()));
        let mut object = Map::new();
        let mut comma_before: Option<usize> = None;
        loop {
            self.skip_trivia()?;
            match self.peek() {
                Some(b'}') => break,
                Some(b'"') => {}
                _ => return Err(self.fail(self.at)),
            }
            let key_start = self.at;
            let key = self.parse_string()?;
            guard_property(&key)?;
            let key_offset = self.offset(key_start);
            if let Some(Some(properties)) = self.objects.last_mut()
                && !properties.insert(key.clone())
                && self.duplicate.is_none()
            {
                self.duplicate = Some(key_offset);
            }
            self.skip_trivia()?;
            if self.peek() != Some(b':') {
                return Err(self.fail(self.at));
            }
            self.at += 1;
            path.push(key.clone());
            let value = self.parse_value(path, depth + 1)?;
            path.pop();
            let value_end = self.at;
            object.insert(key.clone(), value);
            if settings {
                layout.properties.insert(
                    key.clone(),
                    PropertySpan {
                        key_start,
                        value_end,
                        comma_before,
                        comma_after: None,
                    },
                );
                layout.last_value_end = Some(value_end);
            }
            self.skip_trivia()?;
            match self.peek() {
                Some(b',') => {
                    let comma = self.at;
                    if settings && let Some(span) = layout.properties.get_mut(&key) {
                        span.comma_after = Some(comma);
                    }
                    comma_before = Some(comma);
                    self.at += 1;
                    // A trailing comma before the closing brace is allowed.
                    self.skip_trivia()?;
                    if self.peek() == Some(b'}') {
                        break;
                    }
                }
                Some(b'}') => break,
                _ => return Err(self.fail(self.at)),
            }
            let _ = tracking;
        }
        let close = self.at;
        self.at += 1;
        self.objects.pop();
        if settings {
            layout.close = close;
            self.layout = Some(layout);
        }
        let _ = open;
        Ok(Value::Object(object))
    }

    fn parse_array(&mut self, path: &mut Vec<String>, depth: usize) -> Scan<Value> {
        self.at += 1;
        self.objects.push(None);
        let mut items = Vec::new();
        loop {
            self.skip_trivia()?;
            match self.peek() {
                Some(b']') => break,
                None => return Err(self.fail(self.at)),
                _ => {}
            }
            items.push(self.parse_value(path, depth + 1)?);
            self.skip_trivia()?;
            match self.peek() {
                Some(b',') => {
                    self.at += 1;
                    self.skip_trivia()?;
                    if self.peek() == Some(b']') {
                        break;
                    }
                }
                Some(b']') => break,
                _ => return Err(self.fail(self.at)),
            }
        }
        self.at += 1;
        self.objects.pop();
        Ok(Value::Array(items))
    }
}

fn detect_indent(text: &str) -> String {
    static PATTERN: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| regex::Regex::new(r#"\n([\t ]+)\""#).ok());
    pattern
        .as_ref()
        .and_then(|pattern| pattern.captures(text))
        .and_then(|captures| captures.get(1))
        .map(|indent| indent.as_str().to_owned())
        .unwrap_or_else(|| "  ".to_owned())
}

/// Reads a settings file's text: its value, size, scalar ranges and settings layout.
pub fn parse_document(text: &str) -> Scan<Scanned> {
    let bytes = text.len();
    if bytes > MAX_DOCUMENT_BYTES {
        return Err(SettingsError::new(
            SettingsCode::Size,
            "Settings document exceeds 1 MiB",
        ));
    }
    let mut scanner = Scanner::new(text);
    let scanned = (|| -> Scan<Value> {
        scanner.skip_trivia()?;
        let mut path = Vec::new();
        let value = scanner.parse_value(&mut path, 0)?;
        scanner.skip_trivia()?;
        if scanner.at < scanner.bytes.len() {
            return Err(scanner.fail(scanner.at));
        }
        Ok(value)
    })();
    let value = match scanned {
        Ok(value) => value,
        Err(error) => {
            return Err(match scanner.syntax {
                Some(offset) => {
                    SettingsError::at(SettingsCode::Parse, "Invalid JSONC settings", offset)
                }
                None => error,
            });
        }
    };
    if let Some(offset) = scanner.syntax {
        return Err(SettingsError::at(
            SettingsCode::Parse,
            "Invalid JSONC settings",
            offset,
        ));
    }
    if let Some(offset) = scanner.duplicate {
        return Err(SettingsError::at(
            SettingsCode::Validation,
            "Duplicate JSONC property",
            offset,
        ));
    }
    // Credentials in discarded duplicates and in comments are diagnosed too.
    guard_secrets(&Value::String(text.to_owned()))?;
    Ok(Scanned {
        value,
        bytes,
        ranges: scanner.ranges,
        layout: scanner.layout,
        text: text.to_owned(),
    })
}

/// Replaces one scalar, leaving every comment and the rest of the file untouched.
pub fn replace_scalar(text: &str, range: ScalarRange, content: &str) -> String {
    let mut out = String::with_capacity(text.len() + content.len());
    out.push_str(&text[..range.start]);
    out.push_str(content);
    out.push_str(&text[range.end..]);
    out
}

/// Inserts `key: value` into the settings object, in the file's own indentation and EOL.
pub fn insert_setting(
    text: &str,
    layout: &SettingsLayout,
    key: &str,
    value: &Value,
) -> Result<String, SettingsError> {
    let content = serde_json::to_string(value).map_err(|_| {
        SettingsError::new(SettingsCode::Validation, "Settings are not serializable")
    })?;
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let indent = if layout.indent.is_empty() {
        "  ".to_owned()
    } else {
        layout.indent.clone()
    };
    let property = format!("{indent}\"{key}\": {content}");
    let mut out = String::with_capacity(text.len() + property.len() + 2);
    match layout.last_value_end {
        None => {
            // An empty settings object: open, the property, then the closing line.
            out.push_str(&text[..layout.open]);
            out.push_str(eol);
            out.push_str(&property);
            out.push_str(eol);
            out.push_str(&text[layout.close..]);
        }
        Some(last) => {
            out.push_str(&text[..last]);
            out.push(',');
            out.push_str(eol);
            out.push_str(&property);
            out.push_str(&text[last..]);
        }
    }
    Ok(out)
}

/// Removes one setting's property, and its comma, keeping the rest of the file.
pub fn remove_setting(text: &str, span: &PropertySpan) -> String {
    let (start, end) = match (span.comma_before, span.comma_after) {
        (Some(comma), _) => (comma, span.value_end),
        (None, Some(comma)) => (span.key_start, comma + 1),
        (None, None) => (span.key_start, span.value_end),
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..start]);
    out.push_str(&text[end..]);
    out
}

#[cfg(test)]
mod tests {
    //! Ports `jsonc.ts` through the review's failing inputs: a commented file loads,
    //! a duplicate property is refused with its offset, a syntax error is `parse`,
    //! and a scalar replacement keeps comments and the rest of the file.

    use super::*;

    #[test]
    fn comments_and_trailing_commas_load() {
        let text = "{\n  // ops note\n  \"version\": 2,\n  \"settings\": {\n    \"threads.settleOnClose\": true, // keep\n  },\n}\n";
        let scanned = parse_document(text).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(scanned.value["settings"]["threads.settleOnClose"], true);
        assert!(scanned.ranges.contains_key("threads.settleOnClose"));
        let (offset, length) = scanned
            .utf16_range("threads.settleOnClose")
            .unwrap_or_else(|| panic!("range"));
        assert_eq!(length, 4);
        // ASCII text: UTF-16 offsets are byte offsets here.
        assert_eq!(&text[offset..offset + length], "true");
    }

    #[test]
    fn a_duplicate_property_is_refused_at_its_key() {
        let text = "{\"version\":2,\"settings\":{\"a\":1,\"a\":2}}";
        let error = parse_document(text)
            .err()
            .unwrap_or_else(|| panic!("refuses"));
        assert_eq!(error.code, SettingsCode::Validation);
        assert_eq!(error.message, "Duplicate JSONC property");
        assert_eq!(error.offset, Some(31));
    }

    #[test]
    fn a_syntax_error_is_a_parse_diagnostic_with_its_offset() {
        let text = "{\n  \"version\": 2,\n  \"settings\": {,}\n}\n";
        let error = parse_document(text)
            .err()
            .unwrap_or_else(|| panic!("refuses"));
        assert_eq!(error.code, SettingsCode::Parse);
        assert_eq!(error.message, "Invalid JSONC settings");
        assert_eq!(error.offset, Some(33));
    }

    #[test]
    fn replacing_a_scalar_keeps_the_comments_and_the_rest_of_the_file() {
        let text = "{\n  // note\n  \"version\": 2,\n  \"settings\": {\n    \"threads.settleOnClose\": false, // keep me\n    \"future.note\": 1\n  }\n}\n";
        let scanned = parse_document(text).unwrap_or_else(|error| panic!("{error}"));
        let range = scanned
            .ranges
            .get("threads.settleOnClose")
            .copied()
            .unwrap_or_else(|| panic!("range"));
        let next = replace_scalar(text, range, "true");
        assert!(next.contains("// note"));
        assert!(next.contains("// keep me"));
        assert!(next.contains("\"threads.settleOnClose\": true"));
        assert_eq!(
            parse_document(&next)
                .unwrap_or_else(|error| panic!("{error}"))
                .value["settings"]["threads.settleOnClose"],
            true
        );
    }

    #[test]
    fn a_setting_is_inserted_and_removed_without_touching_comments() {
        let text = "{\n  \"version\": 2,\n  \"settings\": {\n    // here\n    \"threads.settleOnClose\": false\n  }\n}\n";
        let scanned = parse_document(text).unwrap_or_else(|error| panic!("{error}"));
        let layout = scanned.layout.unwrap_or_default();
        let next = insert_setting(text, &layout, "threads.forkOnSwitch", &Value::Bool(true))
            .unwrap_or_else(|error| panic!("{error}"));
        assert!(next.contains("// here"));
        let scanned = parse_document(&next).unwrap_or_else(|error| panic!("{error}"));
        assert_eq!(scanned.value["settings"]["threads.forkOnSwitch"], true);
        let span = scanned
            .layout
            .as_ref()
            .and_then(|layout| layout.properties.get("threads.forkOnSwitch"))
            .cloned()
            .unwrap_or_else(|| panic!("span"));
        let removed = remove_setting(&next, &span);
        let scanned = parse_document(&removed).unwrap_or_else(|error| panic!("{error}"));
        assert!(
            scanned.value["settings"]
                .get("threads.forkOnSwitch")
                .is_none()
        );
        assert_eq!(scanned.value["settings"]["threads.settleOnClose"], false);
    }
}
