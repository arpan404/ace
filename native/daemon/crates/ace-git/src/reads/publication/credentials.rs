// SPDX-License-Identifier: Apache-2.0
//! The free-text credential scan (`publication-credentials.ts` and
//! `publication-assignment-keys.ts`, G3d): credential field names, the assignment scanner, the
//! literal signatures and the structured JSON walk.

use std::sync::OnceLock;

use ace_json::Value;
use regex::Regex;

use crate::core::error::{GitError, GitErrorCode};
use yaml_rust2::parser::{Event, Parser};

use super::incomplete_publication_scan;

pub(crate) fn regex_of(
    slot: &'static OnceLock<Option<Regex>>,
    pattern: &str,
) -> Option<&'static Regex> {
    slot.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CredentialValue {
    Field,
    ExecEnv,
}

impl CredentialValue {
    pub(crate) fn sensitive(self) -> GitError {
        match self {
            Self::Field => GitError::new(
                GitErrorCode::SensitivePublication,
                "Sensitive YAML credential field",
            ),
            Self::ExecEnv => GitError::new(
                GitErrorCode::SensitivePublication,
                "Sensitive YAML exec environment",
            ),
        }
    }
}

fn structured_incomplete() -> GitError {
    GitError::new(
        GitErrorCode::PublicationScanIncomplete,
        "Structured credential scan incomplete",
    )
}

/// Shared redaction's literal signature: an exact configured value or a credential pattern.
pub fn has_sensitive_span(text: &str) -> bool {
    !ace_redaction::sensitive_spans(text, None).is_empty()
}

/// The credential field names publication's assignment, JSON and YAML checks share.
pub fn is_publication_credential_key(key: &str) -> bool {
    static POLICY: OnceLock<Option<Regex>> = OnceLock::new();
    // These describe credential policy or location, rather than carrying its value.
    let policy = regex_of(
        &POLICY,
        r"(?i)[_-](?:(?:min|max)[_-])?(?:length|age)$|[_-](?:url|endpoint|path|file|expiry|expiration|ttl|expires[_-]at|timeout|enabled|required|policy|pattern|algorithm|encoding|format)$",
    );
    let credential = credential_shape();
    let words = camel_to_words(key);
    if policy.is_some_and(|policy| policy.is_match(&words)) {
        return false;
    }
    ace_redaction::is_secret_key(key)
        || credential.is_some_and(|credential| credential.is_match(key))
}

/// `key.replace(/([a-z0-9])([A-Z])/g, "$1_$2")`.
fn camel_to_words(key: &str) -> String {
    let characters: Vec<char> = key.chars().collect();
    let mut out = String::with_capacity(key.len() + 4);
    for (index, character) in characters.iter().enumerate() {
        out.push(*character);
        if (character.is_ascii_lowercase() || character.is_ascii_digit())
            && characters
                .get(index + 1)
                .is_some_and(|next| next.is_ascii_uppercase())
        {
            out.push('_');
        }
    }
    out
}

fn credential_shape() -> Option<&'static Regex> {
    static CREDENTIAL: OnceLock<Option<Regex>> = OnceLock::new();
    regex_of(
        &CREDENTIAL,
        r"(?i)^(?:_?auth(?:token)?|private[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?|client-key-data|client-certificate-data|auth-provider)$",
    )
}

fn is_credential_shaped(key: &str) -> bool {
    credential_shape().is_some_and(|pattern| pattern.is_match(key))
}

/// One credential-looking assignment in free text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub keys: Vec<String>,
    pub key_start: usize,
    pub key_end: usize,
    pub populated: bool,
}

fn is_bare(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '/' | '@' | '-')
}

fn is_horizontal(character: char) -> bool {
    matches!(character, ' ' | '\t')
}

fn is_boundary(character: Option<char>) -> bool {
    character.is_none_or(|character| {
        crate::core::reviewer::js_whitespace(character)
            || matches!(character, ';' | '{' | ',' | '(')
    })
}

/// ECMAScript `\s` as a regex class: Rust's `\s` includes U+0085 and excludes U+FEFF.
const URI_PATTERN: &str = concat!(
    "(?i)(?:https?|ssh)://[^",
    "\t\n\x0B\x0C\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}",
    "/@:]+:[^",
    "\t\n\x0B\x0C\r \\x{A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}",
    "/@]+@"
);

/// A forward-only cursor over the text's characters; the budget counts UTF-16 units.
struct Cursor {
    characters: Vec<char>,
    position: usize,
    /// UTF-16 units stepped through since `key_start`, kept as a running count.
    units: usize,
}

impl Cursor {
    fn at(&self, offset: isize) -> Option<char> {
        let index = self.position as isize + offset;
        if index < 0 {
            return None;
        }
        self.characters.get(index as usize).copied()
    }

    fn advance(&mut self) -> Result<(), GitError> {
        if self.position >= self.characters.len() {
            return Ok(());
        }
        self.units += self.characters[self.position].len_utf16();
        self.position += 1;
        if self.units > 16_384 {
            return Err(incomplete_publication_scan());
        }
        Ok(())
    }

    fn slice(&self, start: usize, end: usize) -> String {
        self.characters[start..end].iter().collect()
    }

    fn done(&self) -> bool {
        self.position >= self.characters.len()
    }
}

/// Every credential-looking assignment, in order (`publicationAssignments`).
pub fn publication_assignments(text: &str) -> Result<Vec<Assignment>, GitError> {
    let mut cursor = Cursor {
        characters: text.chars().collect(),
        position: 0,
        units: 0,
    };
    let mut assignments: Vec<Assignment> = Vec::new();
    let mut count = 0usize;
    while !cursor.done() {
        let initial = cursor.characters[cursor.position];
        if !is_boundary(cursor.at(-1)) || (!is_bare(initial) && initial != '"' && initial != '\'') {
            cursor.position += 1;
            continue;
        }
        let start = cursor.position;
        cursor.units = 0;
        let spaces = |cursor: &mut Cursor| -> Result<(), GitError> {
            while cursor.at(0).is_some_and(is_horizontal) {
                cursor.advance()?;
            }
            Ok(())
        };
        let mut parts: Vec<String> = Vec::new();
        let mut key_end = cursor.position;
        let mut valid = true;
        while valid {
            if parts.len() >= 64 {
                return Err(incomplete_publication_scan());
            }
            let component = cursor.position;
            let quote = cursor.at(0);
            if quote == Some('"') || quote == Some('\'') {
                let quote = quote.unwrap_or('"');
                cursor.advance()?;
                while !cursor.done() && cursor.at(0) != Some(quote) {
                    if cursor.at(0).is_some_and(|c| c == '\r' || c == '\n') {
                        break;
                    }
                    if quote == '"' && cursor.at(0) == Some('\\') {
                        cursor.advance()?;
                        if cursor.done() || cursor.at(0).is_some_and(|c| c == '\r' || c == '\n') {
                            break;
                        }
                    }
                    cursor.advance()?;
                }
                if cursor.at(0) != Some(quote) {
                    valid = false;
                    break;
                }
                cursor.advance()?;
            } else {
                while cursor.at(0).is_some_and(is_bare) {
                    cursor.advance()?;
                }
                // npm's scoped fields use /:_auth and /:_authToken before '='.
                if cursor.at(0) == Some(':')
                    && cursor.at(-1) == Some('/')
                    && cursor.at(1).is_some_and(is_bare)
                {
                    cursor.advance()?;
                    while cursor.at(0).is_some_and(is_bare) {
                        cursor.advance()?;
                    }
                }
                if cursor.position == component {
                    valid = false;
                    break;
                }
            }
            parts.push(cursor.slice(component, cursor.position));
            key_end = cursor.position;
            spaces(&mut cursor)?;
            if cursor.at(0) != Some('.') {
                break;
            }
            cursor.advance()?;
            spaces(&mut cursor)?;
        }
        if valid && matches!(cursor.at(0), Some('=') | Some(':')) {
            cursor.advance()?;
            spaces(&mut cursor)?;
            count += 1;
            if count > 100_000 {
                return Err(incomplete_publication_scan());
            }
            let mut populated = false;
            if cursor
                .at(0)
                .is_some_and(|c| !c.is_whitespace() && !matches!(c, ';' | ',' | '}' | ']'))
            {
                let quote = cursor.at(0).unwrap_or(' ');
                if quote == '"' || quote == '\'' {
                    cursor.position += 1;
                    let value_start = cursor.position;
                    let mut closed = false;
                    while !cursor.done() {
                        let character = cursor.characters[cursor.position];
                        if character == '\r' || character == '\n' {
                            break;
                        }
                        cursor.position += 1;
                        if character == quote {
                            populated = cursor.position - 1 > value_start;
                            closed = true;
                            break;
                        }
                        if quote == '"'
                            && character == '\\'
                            && !cursor.done()
                            && !cursor.at(0).is_some_and(|c| c == '\r' || c == '\n')
                        {
                            cursor.position += 1;
                        }
                    }
                    if !closed
                        || cursor.at(0).is_some_and(|c| {
                            !c.is_whitespace() && !matches!(c, ';' | ',' | '}' | ')' | ']')
                        })
                    {
                        populated = true;
                    }
                } else {
                    populated = true;
                    while cursor.at(0).is_some_and(|c| {
                        !c.is_whitespace() && !matches!(c, ';' | ',' | '{' | '}' | '(' | ')')
                    }) {
                        cursor.position += 1;
                    }
                }
            }
            assignments.push(Assignment {
                keys: parts,
                key_start: start,
                key_end,
                populated,
            });
        }
    }
    Ok(assignments)
}

fn unusable_assignment_key() -> GitError {
    GitError::new(
        GitErrorCode::PublicationScanIncomplete,
        "Assignment key scan incomplete",
    )
}

/// A TOML basic/literal quoted key decoded as a YAML scalar (`assignmentKey`).
fn assignment_key(part: &str) -> Result<String, GitError> {
    let first = part.chars().next();
    if first != Some('"') && first != Some('\'') {
        return Ok(part.to_owned());
    }
    let mut parser = Parser::new_from_str(part);
    let mut scalar: Option<String> = None;
    let mut nodes = 0usize;
    loop {
        match parser.next_token() {
            Ok((Event::StreamEnd, _)) | Ok((Event::Nothing, _)) => break,
            Ok((Event::StreamStart, _))
            | Ok((Event::DocumentStart, _))
            | Ok((Event::DocumentEnd, _)) => {}
            Ok((Event::Scalar(value, _, _, tag), _)) => {
                nodes += 1;
                if tag.is_some() || scalar.is_some() {
                    return Err(unusable_assignment_key());
                }
                scalar = Some(value);
            }
            Ok((Event::Alias(_), _)) => return Err(unusable_assignment_key()),
            Ok((Event::MappingStart(..), _)) | Ok((Event::SequenceStart(..), _)) => {
                return Err(unusable_assignment_key());
            }
            Ok(_) | Err(_) => return Err(unusable_assignment_key()),
        }
    }
    if nodes != 1 {
        return Err(unusable_assignment_key());
    }
    scalar.ok_or_else(unusable_assignment_key)
}

fn has_literal_credential(text: &str) -> bool {
    static KEY_BLOCK: OnceLock<Option<Regex>> = OnceLock::new();
    static URI: OnceLock<Option<Regex>> = OnceLock::new();
    has_sensitive_span(text)
        || regex_of(&KEY_BLOCK, r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----")
            .is_some_and(|pattern| pattern.is_match(text))
        || regex_of(&URI, URI_PATTERN).is_some_and(|pattern| pattern.is_match(text))
}

/// Classify assignments before shared signatures: neutralise only credential key ranges.
fn publication_literal_text(text: &str) -> Result<Option<String>, GitError> {
    let mut fragments: Vec<String> = Vec::new();
    let mut position = 0usize;
    for assignment in publication_assignments(text)? {
        let parts = &assignment.keys;
        let mut decoded: Vec<String> = Vec::with_capacity(parts.len());
        for part in parts {
            decoded.push(assignment_key(part)?);
        }
        let key_text: String = text
            .chars()
            .skip(assignment.key_start)
            .take(assignment.key_end.saturating_sub(assignment.key_start))
            .collect();
        if has_literal_credential(&key_text)
            || decoded
                .iter()
                .zip(parts.iter())
                .any(|(decoded, part)| decoded != part && has_literal_credential(decoded))
        {
            return Ok(None);
        }
        let Some(leaf) = decoded.last() else {
            continue;
        };
        // Registry-scoped npm fields retain their complete leaf identifier.
        let key = leaf
            .split(['/', ':'])
            .next_back()
            .unwrap_or(leaf)
            .to_owned();
        if assignment.populated && is_publication_credential_key(&key) {
            return Ok(None);
        }
        if !ace_redaction::is_secret_key(&key) && !is_credential_shaped(&key) {
            continue;
        }
        fragments.push(
            text.chars()
                .skip(position)
                .take(assignment.key_start - position)
                .collect(),
        );
        fragments.push("x".repeat(assignment.key_end - assignment.key_start));
        position = assignment.key_end;
    }
    fragments.push(text.chars().skip(position).collect());
    Ok(Some(fragments.concat()))
}

/// Parse structured fields too: escaped keys and base64 Docker auth need no token signature.
fn has_structured_credential(text: &str) -> Result<bool, GitError> {
    let Ok(root) = ace_json::parse(text) else {
        return Ok(false);
    };
    let mut pending: Vec<(Value, usize)> = vec![(root, 0)];
    let mut entries = 0usize;
    while let Some((value, depth)) = pending.pop() {
        if depth > 64 || entries > 100_000 {
            return Err(structured_incomplete());
        }
        match value {
            Value::Array(items) => {
                entries += items.len();
                if entries > 100_000 {
                    return Err(structured_incomplete());
                }
                for item in items {
                    pending.push((item, depth + 1));
                }
            }
            Value::Object(fields) if !fields.is_empty() => {
                for (key, value) in fields {
                    entries += 1;
                    if entries > 100_000 {
                        return Err(structured_incomplete());
                    }
                    let name = key.to_string_lossy().into_owned();
                    if is_publication_credential_key(&name)
                        && matches!(&value, Value::String(text) if !text.to_string_lossy().trim().is_empty())
                    {
                        return Ok(true);
                    }
                    pending.push((value, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(false)
}

/// Shared redaction signatures plus credential formats that hide their value shape.
pub fn contains_publication_credential(text: &str) -> Result<bool, GitError> {
    let Some(literal) = publication_literal_text(text)? else {
        return Ok(true);
    };
    if has_literal_credential(&literal) {
        return Ok(true);
    }
    has_structured_credential(text)
}

#[cfg(test)]
mod tests {
    use super::contains_publication_credential;

    fn classify(text: &str) -> String {
        match contains_publication_credential(text) {
            Ok(true) => "sensitive_publication".to_owned(),
            Ok(false) => "publishable".to_owned(),
            Err(error) => error.code.as_str().to_owned(),
        }
    }

    // ECMAScript's `\s`: U+FEFF splits, U+0085 does not; Rust's `\s` answers both the other way.
    #[test]
    fn the_scanner_breaks_on_the_runtime_s_whitespace_not_rusts() {
        assert_eq!(
            classify("x\u{feff}private_key=opaque"),
            "sensitive_publication"
        );
        assert_eq!(classify("x\u{85}private_key=opaque"), "publishable");
        assert_eq!(
            classify("https://u:pa\u{85}ss@host"),
            "sensitive_publication"
        );
        assert_eq!(classify("https://u:pa\u{feff}ss@host"), "publishable");
    }
}
