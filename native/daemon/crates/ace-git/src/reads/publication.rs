// SPDX-License-Identifier: Apache-2.0
//! The publication safety scan (`publication-credentials.ts`, `publication-assignment-keys.ts`,
//! `publication-sensitive.ts`, `publication-yaml.ts`, `publication-scan.ts`; G3d).
//!
//! Proof: every case of `publication-sensitive.test.ts` moved to this module's tests, and the
//! feature-level wiring in the daemon's publication process files.

use std::collections::HashSet;
use std::sync::OnceLock;

use ace_json::Value;
use regex::Regex;
use yaml_rust2::parser::{Event, Parser, Tag};

use crate::core::error::{GitError, GitErrorCode};
use crate::reads::{Command, CommandPort, checked};

/// `metadataLimit`: bytes of a metadata read (tree listings, rev-list).
pub const METADATA_LIMIT: usize = 8 * 1024 * 1024;
/// `contentLimit`: total object bytes one scan inspects.
pub const CONTENT_LIMIT: u64 = 128 * 1024 * 1024;
/// `objectLimit`: the largest single object one scan inspects.
pub const OBJECT_LIMIT: u64 = 8 * 1024 * 1024;
/// The most objects one scan collects.
pub const OBJECT_COUNT_LIMIT: usize = 100_000;
/// The largest YAML one scan parses.
pub const YAML_BYTE_LIMIT: usize = 1024 * 1024;
/// The most documents one YAML file may hold.
pub const YAML_DOCUMENT_LIMIT: usize = 20;
/// The most nodes one YAML document set may hold.
pub const YAML_NODE_LIMIT: usize = 100_000;
/// The deepest YAML nesting one scan walks.
pub const YAML_DEPTH_LIMIT: usize = 64;

pub fn incomplete_publication_scan() -> GitError {
    GitError::new(
        GitErrorCode::PublicationScanIncomplete,
        "Publication safety scan incomplete",
    )
}

fn sensitive_publication() -> GitError {
    GitError::new(
        GitErrorCode::SensitivePublication,
        "Sensitive publication content",
    )
}

fn regex_of(slot: &'static OnceLock<Option<Regex>>, pattern: &str) -> Option<&'static Regex> {
    slot.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

/// Shared redaction's literal signature: an exact configured value or a credential pattern.
pub fn has_sensitive_span(text: &str) -> bool {
    !ace_redaction::sensitive_spans(text, None).is_empty()
}

/// The credential field names publication's assignment, JSON and YAML checks share.
pub fn is_publication_credential_key(key: &str) -> bool {
    static POLICY: OnceLock<Option<Regex>> = OnceLock::new();
    static CREDENTIAL: OnceLock<Option<Regex>> = OnceLock::new();
    // These describe credential policy or location, rather than carrying its value.
    let policy = regex_of(
        &POLICY,
        r"(?i)[_-](?:(?:min|max)[_-])?(?:length|age)$|[_-](?:url|endpoint|path|file|expiry|expiration|ttl|expires[_-]at|timeout|enabled|required|policy|pattern|algorithm|encoding|format)$",
    );
    let credential = regex_of(
        &CREDENTIAL,
        r"(?i)^(?:_?auth(?:token)?|private[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?|client-key-data|client-certificate-data|auth-provider)$",
    );
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

fn is_credential_shaped(key: &str) -> bool {
    static SHAPED: OnceLock<Option<Regex>> = OnceLock::new();
    regex_of(
        &SHAPED,
        r"(?i)^(?:_?auth(?:token)?|private[_-]?key|(?:aws[_-]?)?access[_-]?key(?:[_-]?id)?|client-key-data|client-certificate-data|auth-provider)$",
    )
    .is_some_and(|pattern| pattern.is_match(key))
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
        character.is_whitespace() || matches!(character, ';' | '{' | ',' | '(')
    })
}

/// A forward-only cursor over the text's characters; the budget counts UTF-16 units.
struct Cursor {
    characters: Vec<char>,
    position: usize,
    key_start: usize,
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
        let units = self.characters[self.position].len_utf16();
        self.position += 1;
        if self.position - self.key_start > 0
            && self.utf16_width(self.key_start, self.position) > 16_384
        {
            return Err(incomplete_publication_scan());
        }
        let _ = units;
        Ok(())
    }

    fn utf16_width(&self, start: usize, end: usize) -> usize {
        self.characters[start..end]
            .iter()
            .map(|character| character.len_utf16())
            .sum()
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
        key_start: 0,
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
        cursor.key_start = start;
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
        || regex_of(&URI, r"(?i)(?:https?|ssh)://[^\s/@:]+:[^\s/@]+@")
            .is_some_and(|pattern| pattern.is_match(text))
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
            return Err(incomplete_publication_scan());
        }
        match value {
            Value::Array(items) => {
                entries += items.len();
                if entries > 100_000 {
                    return Err(incomplete_publication_scan());
                }
                for item in items {
                    pending.push((item, depth + 1));
                }
            }
            Value::Object(fields) if !fields.is_empty() => {
                for (key, value) in fields {
                    entries += 1;
                    if entries > 100_000 {
                        return Err(incomplete_publication_scan());
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

/// A path publication must refuse: a credential store, a key or an `.env`-like file.
pub fn sensitive_publication_path(path: &str) -> bool {
    static STORES: OnceLock<Option<Regex>> = OnceLock::new();
    static NAMES: OnceLock<Option<Regex>> = OnceLock::new();
    static SUFFIXES: OnceLock<Option<Regex>> = OnceLock::new();
    if has_sensitive_span(path) {
        return true;
    }
    path.split('/').any(|part| {
        let lowered = part.to_ascii_lowercase();
        lowered.starts_with(".env")
            || lowered.contains("kubeconfig")
            || regex_of(&STORES, r"(?i)^(?:\.ssh|\.gnupg|\.aws|\.azure|\.docker|\.kube|\.oci|\.gcloud|gcloud|\.boto|\.s3cfg|\.terraformrc|terraform\.rc|\.terraform\.d|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$")
                .is_some_and(|pattern| pattern.is_match(part))
            || regex_of(&NAMES, r"(?i)^(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:[._-].*)?|.*[._-]credentials?(?:[._-].*)?|service[-_]account.*\.json|secrets?(?:[._-].*)?)$")
                .is_some_and(|pattern| pattern.is_match(part))
            || regex_of(&SUFFIXES, r"(?i)\.(?:pem|der|key|p12|pfx|jks|keystore)$")
                .is_some_and(|pattern| pattern.is_match(part))
    })
}

/// Blobs under these names also get structured YAML credential inspection.
pub fn publication_yaml_name(name: &str) -> bool {
    static YAML: OnceLock<Option<Regex>> = OnceLock::new();
    regex_of(&YAML, r"(?i)\.ya?ml$").is_some_and(|pattern| pattern.is_match(name))
}

/// `assertPublicationText`: credentials in bytes, or a pointer the scan cannot inspect.
pub fn assert_publication_text(bytes: &[u8]) -> Result<(), GitError> {
    let text = String::from_utf8_lossy(bytes);
    if contains_publication_credential(&text)? {
        return Err(sensitive_publication());
    }
    if text.starts_with("version https://git-lfs.github.com/spec/v1") {
        return Err(incomplete_publication_scan());
    }
    Ok(())
}

/// One object a publication scan inspects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanObject {
    pub id: String,
    pub object_type: String,
    pub size: u64,
    pub format_yaml: bool,
}

/// One child object a tree or commit names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublicationReference {
    pub id: String,
    pub format_yaml: bool,
}

/// `objectHeader`: `<id> <type> <size>` from a `cat-file --batch-check` line.
pub fn object_header(line: &str) -> Result<ScanObject, GitError> {
    let mut parts = line.split(' ');
    let (Some(id), Some(object_type), Some(size)) = (parts.next(), parts.next(), parts.next())
    else {
        return Err(incomplete_publication_scan());
    };
    if parts.next().is_some() || size.is_empty() || !size.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(incomplete_publication_scan());
    }
    if crate::core::decode::hash_schema(id).is_none()
        || !matches!(object_type, "blob" | "tree" | "commit" | "tag")
    {
        return Err(incomplete_publication_scan());
    }
    Ok(ScanObject {
        id: id.to_owned(),
        object_type: object_type.to_owned(),
        size: crate::core::decode::count(size)?,
        format_yaml: false,
    })
}

/// Binary tree names are inspected independently of blobs, including reused or renamed content.
pub fn assert_publication_tree(
    bytes: &[u8],
    hash_bytes: usize,
) -> Result<Vec<PublicationReference>, GitError> {
    let mut children = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        let space = match bytes[offset..].iter().position(|byte| *byte == b' ') {
            Some(index) => offset + index,
            None => return Err(incomplete_publication_scan()),
        };
        let end = match bytes[space + 1..].iter().position(|byte| *byte == 0) {
            Some(index) => space + 1 + index,
            None => return Err(incomplete_publication_scan()),
        };
        if end + 1 + hash_bytes > bytes.len() {
            return Err(incomplete_publication_scan());
        }
        let Ok(name) = std::str::from_utf8(&bytes[space + 1..end]) else {
            return Err(incomplete_publication_scan());
        };
        if sensitive_publication_path(name) {
            return Err(GitError::new(
                GitErrorCode::SensitivePublication,
                "Sensitive publication path",
            ));
        }
        let mode = String::from_utf8_lossy(&bytes[offset..space]).into_owned();
        if mode != "160000" {
            children.push(PublicationReference {
                id: bytes[end + 1..end + 1 + hash_bytes]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
                format_yaml: mode != "40000" && mode != "040000" && publication_yaml_name(name),
            });
        }
        offset = end + 1 + hash_bytes;
    }
    Ok(children)
}

/// Parse the byte-framed batch result. Raw content never becomes diagnostics or a receipt.
pub fn inspect_publication_batch(
    bytes: &[u8],
    expected: &[ScanObject],
) -> Result<Vec<PublicationReference>, GitError> {
    let mut children = Vec::new();
    let mut offset = 0usize;
    for object in expected {
        let end = match bytes[offset..].iter().position(|byte| *byte == b'\n') {
            Some(index) => offset + index,
            None => return Err(incomplete_publication_scan()),
        };
        let header = String::from_utf8_lossy(&bytes[offset..end]);
        let actual = object_header(header.trim_end())?;
        if actual.id != object.id
            || actual.object_type != object.object_type
            || actual.size != object.size
        {
            return Err(incomplete_publication_scan());
        }
        offset = end + 1;
        let size = usize::try_from(object.size).map_err(|_| incomplete_publication_scan())?;
        if offset + size >= bytes.len() || bytes[offset + size] != b'\n' {
            return Err(incomplete_publication_scan());
        }
        let content = &bytes[offset..offset + size];
        if object.object_type == "tree" {
            children.extend(assert_publication_tree(content, object.id.len() / 2)?);
        } else {
            if object.object_type == "commit" {
                let Some(end_of_header) = find_header_end(content) else {
                    return Err(incomplete_publication_scan());
                };
                let headers: Vec<&str> = std::str::from_utf8(&content[..end_of_header])
                    .map_err(|_| incomplete_publication_scan())?
                    .split('\n')
                    .collect();
                let root = headers.first().and_then(|line| line.strip_prefix("tree "));
                let Some(root) = root.filter(|root| root.len() == object.id.len()) else {
                    return Err(incomplete_publication_scan());
                };
                children.push(PublicationReference {
                    id: crate::core::decode::hash(root)?,
                    format_yaml: false,
                });
                for header in headers.iter().skip(1) {
                    let Some(parent) = header.strip_prefix("parent ") else {
                        continue;
                    };
                    if parent.len() != object.id.len() {
                        return Err(incomplete_publication_scan());
                    }
                    children.push(PublicationReference {
                        id: crate::core::decode::hash(parent)?,
                        format_yaml: false,
                    });
                }
            }
            assert_publication_text(content)?;
            if object.format_yaml {
                assert_publication_yaml(content)?;
            }
        }
        offset += size + 1;
    }
    if offset != bytes.len() {
        return Err(incomplete_publication_scan());
    }
    Ok(children)
}

fn find_header_end(content: &[u8]) -> Option<usize> {
    content.windows(2).position(|pair| pair == b"\n\n")
}

fn allowed_tag(tag: Option<&Tag>) -> bool {
    let Some(tag) = tag else {
        return true;
    };
    let full = if tag.handle == "!" {
        format!("!{}", tag.suffix)
    } else if tag.handle == "!!" {
        format!("tag:yaml.org,2002:{}", tag.suffix)
    } else {
        format!("{}{}", tag.handle, tag.suffix)
    };
    matches!(
        full.as_str(),
        "tag:yaml.org,2002:str"
            | "tag:yaml.org,2002:int"
            | "tag:yaml.org,2002:float"
            | "tag:yaml.org,2002:bool"
            | "tag:yaml.org,2002:null"
            | "tag:yaml.org,2002:map"
            | "tag:yaml.org,2002:seq"
    )
}

fn is_null_scalar(text: &str) -> bool {
    matches!(text, "" | "~" | "null" | "Null" | "NULL")
}

#[derive(Debug)]
enum Frame {
    Mapping {
        keys: HashSet<String>,
        expecting_key: bool,
        exec: bool,
        credential_value: bool,
    },
    Sequence {
        credential_value: bool,
    },
}

enum Pending {
    None,
    Credential,
    ExecEnv,
    ExecMap,
}

/// `assertPublicationYaml`: walk parsed nodes without converting or expanding aliases.
pub fn assert_publication_yaml(bytes: &[u8]) -> Result<(), GitError> {
    if bytes.len() > YAML_BYTE_LIMIT {
        return Err(incomplete_publication_scan());
    }
    let text = std::str::from_utf8(bytes).map_err(|_| incomplete_publication_scan())?;
    let mut parser = Parser::new_from_str(text);
    let mut frames: Vec<Frame> = Vec::new();
    let mut documents = 0usize;
    let mut nodes = 0usize;
    let mut pending = Pending::None;
    loop {
        let (event, _) = match parser.next_token() {
            Ok(event) => event,
            Err(_) => return Err(incomplete_publication_scan()),
        };
        if matches!(event, Event::StreamEnd | Event::Nothing) {
            break;
        }
        // A collection that is a credential's value is populated as soon as it holds anything.
        if frames.last().is_some_and(is_credential_value_frame)
            && !matches!(event, Event::MappingEnd | Event::SequenceEnd)
        {
            return Err(sensitive_publication());
        }
        match event {
            Event::StreamStart => {}
            Event::DocumentStart => {
                documents += 1;
                if documents > YAML_DOCUMENT_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                frames.clear();
                pending = Pending::None;
            }
            Event::DocumentEnd => {
                frames.clear();
                pending = Pending::None;
            }
            Event::Alias(_) => return Err(incomplete_publication_scan()),
            Event::Scalar(value, _, _, tag) => {
                nodes += 1;
                if nodes > YAML_NODE_LIMIT || !allowed_tag(tag.as_ref()) {
                    return Err(incomplete_publication_scan());
                }
                if let Some(Frame::Mapping {
                    keys,
                    expecting_key,
                    exec,
                    ..
                }) = frames.last_mut()
                    && *expecting_key
                {
                    if !keys.insert(value.clone()) {
                        return Err(incomplete_publication_scan());
                    }
                    *expecting_key = false;
                    let lowered = value.to_ascii_lowercase();
                    pending = if is_publication_credential_key(&value) {
                        Pending::Credential
                    } else if lowered == "exec" {
                        Pending::ExecMap
                    } else if *exec && lowered == "env" {
                        Pending::ExecEnv
                    } else {
                        Pending::None
                    };
                    continue;
                }
                if matches!(pending, Pending::Credential | Pending::ExecEnv)
                    && !is_null_scalar(&value)
                {
                    return Err(sensitive_publication());
                }
                if has_sensitive_span(&value) {
                    return Err(GitError::new(
                        GitErrorCode::SensitivePublication,
                        "Sensitive YAML scalar",
                    ));
                }
                pending = Pending::None;
                mark_value_done(&mut frames);
            }
            Event::SequenceStart(_, tag) => {
                nodes += 1;
                if nodes > YAML_NODE_LIMIT || !allowed_tag(tag.as_ref()) {
                    return Err(incomplete_publication_scan());
                }
                if frames.len() > YAML_DEPTH_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                if frames.last().is_some_and(|frame| {
                    matches!(
                        frame,
                        Frame::Mapping {
                            expecting_key: true,
                            ..
                        }
                    )
                }) {
                    return Err(incomplete_publication_scan());
                }
                let credential = matches!(pending, Pending::Credential | Pending::ExecEnv);
                pending = Pending::None;
                frames.push(Frame::Sequence {
                    credential_value: credential,
                });
            }
            Event::MappingStart(_, tag) => {
                nodes += 1;
                if nodes > YAML_NODE_LIMIT || !allowed_tag(tag.as_ref()) {
                    return Err(incomplete_publication_scan());
                }
                if frames.len() > YAML_DEPTH_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                if frames.last().is_some_and(|frame| {
                    matches!(
                        frame,
                        Frame::Mapping {
                            expecting_key: true,
                            ..
                        }
                    )
                }) {
                    return Err(incomplete_publication_scan());
                }
                let credential = matches!(pending, Pending::Credential | Pending::ExecEnv);
                let exec = matches!(pending, Pending::ExecMap);
                pending = Pending::None;
                frames.push(Frame::Mapping {
                    keys: HashSet::new(),
                    expecting_key: true,
                    exec,
                    credential_value: credential,
                });
            }
            Event::SequenceEnd | Event::MappingEnd => {
                let Some(frame) = frames.pop() else {
                    return Err(incomplete_publication_scan());
                };
                if is_credential_value_frame(&frame) {
                    // An empty credential collection is not a value at all.
                }
                mark_value_done(&mut frames);
            }
            Event::StreamEnd | Event::Nothing => break,
        }
    }
    Ok(())
}

fn mark_value_done(frames: &mut [Frame]) {
    if let Some(Frame::Mapping { expecting_key, .. }) = frames.last_mut() {
        *expecting_key = true;
    }
}

fn is_credential_value_frame(frame: &Frame) -> bool {
    match frame {
        Frame::Mapping {
            credential_value, ..
        }
        | Frame::Sequence { credential_value } => *credential_value,
    }
}

/// The publication scan: every tracked path and every reachable object of `head`.
pub async fn scan_publication(
    port: &dyn CommandPort,
    root: &str,
    head: &str,
) -> Result<(), GitError> {
    let scanner = Scanner { port, root };
    let shallow = scanner
        .read(
            vec!["rev-parse".to_owned(), "--is-shallow-repository".to_owned()],
            None,
            METADATA_LIMIT,
        )
        .await?;
    if String::from_utf8_lossy(&shallow).trim() != "false" {
        return Err(incomplete_publication_scan());
    }
    let mut objects: HashSet<String> = HashSet::new();
    let mut yaml_objects: HashSet<String> = HashSet::new();
    let mut yaml_ids: Vec<String> = Vec::new();
    let listing = scanner
        .read(
            vec![
                "ls-tree".to_owned(),
                "-r".to_owned(),
                "-z".to_owned(),
                head.to_owned(),
            ],
            None,
            METADATA_LIMIT,
        )
        .await?;
    for entry in crate::core::decode::nul(&listing)? {
        let Some(tab) = entry.find('\t') else {
            return Err(incomplete_publication_scan());
        };
        let header: Vec<&str> = entry[..tab].split(' ').collect();
        let [_, kind, id] = match header.as_slice() {
            [mode, kind, id] => [*mode, *kind, *id],
            _ => return Err(incomplete_publication_scan()),
        };
        let path = &entry[tab + 1..];
        if path.is_empty() || !matches!(kind, "blob" | "commit") {
            return Err(incomplete_publication_scan());
        }
        if sensitive_publication_path(path) {
            return Err(GitError::new(
                GitErrorCode::SensitivePublication,
                "Sensitive tracked path",
            ));
        }
        if kind == "blob" {
            let id = crate::core::decode::hash(id)?;
            objects.insert(id.clone());
            if publication_yaml_name(path) && !yaml_objects.contains(&id) {
                yaml_objects.insert(id.clone());
                yaml_ids.push(id);
            }
        }
    }
    let reachable = scanner
        .read(
            vec![
                "rev-list".to_owned(),
                "--objects".to_owned(),
                "--no-object-names".to_owned(),
                head.to_owned(),
            ],
            None,
            METADATA_LIMIT,
        )
        .await?;
    for id in String::from_utf8_lossy(&reachable).lines() {
        if !id.is_empty() {
            objects.insert(crate::core::decode::hash(id)?);
        }
    }
    if objects.len() > OBJECT_COUNT_LIMIT {
        return Err(incomplete_publication_scan());
    }
    let mut ids: Vec<String> = objects.iter().cloned().collect();
    let mut total = 0u64;
    let mut batch: Vec<ScanObject> = Vec::new();
    let mut batch_bytes = 0u64;
    for phase_yaml in [false, true] {
        let phase_ids = if phase_yaml {
            yaml_ids.clone()
        } else {
            ids.clone()
        };
        let mut position = 0usize;
        while position < phase_ids.len() {
            let group = &phase_ids[position..phase_ids.len().min(position + 512)];
            position += group.len();
            let mut input = group.join("\n");
            input.push('\n');
            let headers = scanner
                .read(
                    vec!["cat-file".to_owned(), "--batch-check".to_owned()],
                    Some(input.as_bytes()),
                    METADATA_LIMIT,
                )
                .await?;
            let header_text = String::from_utf8_lossy(&headers).into_owned();
            let lines: Vec<&str> = header_text.trim().split('\n').collect();
            if group.is_empty() || lines.len() != group.len() {
                return Err(incomplete_publication_scan());
            }
            for (index, line) in lines.iter().enumerate() {
                let mut object = object_header(line)?;
                if phase_yaml && object.object_type != "blob" {
                    return Err(incomplete_publication_scan());
                }
                if object.id != group[index] || object.size > OBJECT_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                total += object.size;
                if total > CONTENT_LIMIT {
                    return Err(incomplete_publication_scan());
                }
                if batch.len() >= 256 || batch_bytes + object.size > 16 * 1024 * 1024 {
                    let children = scanner.flush(&mut batch, &mut batch_bytes).await?;
                    absorb(
                        children,
                        &mut objects,
                        &mut yaml_objects,
                        &mut yaml_ids,
                        &mut ids,
                    )?;
                }
                object.format_yaml = phase_yaml;
                batch_bytes += object.size + 1;
                batch.push(object);
            }
            let children = scanner.flush(&mut batch, &mut batch_bytes).await?;
            absorb(
                children,
                &mut objects,
                &mut yaml_objects,
                &mut yaml_ids,
                &mut ids,
            )?;
        }
    }
    Ok(())
}

fn absorb(
    children: Vec<PublicationReference>,
    objects: &mut HashSet<String>,
    yaml_objects: &mut HashSet<String>,
    yaml_ids: &mut Vec<String>,
    ids: &mut Vec<String>,
) -> Result<(), GitError> {
    for child in children {
        if child.format_yaml && !yaml_objects.contains(&child.id) {
            yaml_objects.insert(child.id.clone());
            yaml_ids.push(child.id.clone());
        }
        if objects.insert(child.id.clone()) {
            ids.push(child.id);
        }
        if objects.len() > OBJECT_COUNT_LIMIT {
            return Err(incomplete_publication_scan());
        }
    }
    Ok(())
}

/// The scan's reads, through the caller's command port.
struct Scanner<'a> {
    port: &'a dyn CommandPort,
    root: &'a str,
}

impl Scanner<'_> {
    async fn read(
        &self,
        args: Vec<String>,
        input: Option<&[u8]>,
        capacity: usize,
    ) -> Result<Vec<u8>, GitError> {
        let mut command = Command::owned(self.root, args)
            .with_capture_bytes(capacity)
            .with_env(&[
                ("GIT_NO_REPLACE_OBJECTS", "1"),
                ("GIT_NO_LAZY_FETCH", "1"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GCM_INTERACTIVE", "never"),
                ("GIT_SSH_COMMAND", "ssh -o BatchMode=yes"),
            ]);
        if let Some(input) = input {
            command = command.with_input(input);
        }
        let result = checked(self.port, command).await?;
        if result.truncated {
            return Err(incomplete_publication_scan());
        }
        Ok(result.stdout)
    }

    async fn flush(
        &self,
        batch: &mut Vec<ScanObject>,
        batch_bytes: &mut u64,
    ) -> Result<Vec<PublicationReference>, GitError> {
        if batch.is_empty() {
            return Ok(Vec::new());
        }
        let mut input = String::new();
        for object in batch.iter() {
            input.push_str(&object.id);
            input.push('\n');
        }
        let capacity =
            usize::try_from(*batch_bytes + batch.len() as u64 * 128).unwrap_or(METADATA_LIMIT);
        let bytes = self
            .read(
                vec!["cat-file".to_owned(), "--batch".to_owned()],
                Some(input.as_bytes()),
                capacity,
            )
            .await?;
        let children = inspect_publication_batch(&bytes, batch)?;
        batch.clear();
        *batch_bytes = 0;
        Ok(children)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::credentials::test_support::Fixture;
    use crate::reads::test_support::ProcessCommands;

    fn classify(path: &str, content: &[u8]) -> String {
        if sensitive_publication_path(path) {
            return "sensitive_publication".to_owned();
        }
        if let Err(error) = assert_publication_text(content) {
            return error.code.as_str().to_owned();
        }
        if publication_yaml_name(path)
            && let Err(error) = assert_publication_yaml(content)
        {
            return error.code.as_str().to_owned();
        }
        "publishable".to_owned()
    }

    fn config(user: &str) -> String {
        format!("apiVersion: v1\nkind: Config\nusers:\n- name: fixture\n  user:\n{user}\n")
    }

    fn expect(path: &str, text: &str, verdict: &str) {
        assert_eq!(classify(path, text.as_bytes()), verdict, "{path}: {text:?}");
    }

    // `publication-sensitive.test.ts`: credential assignments that must block.
    #[test]
    fn credential_assignments_are_blocked() {
        for (path, text) in [
            ("config/runtime.conf", "DB_PASSWORD=opaque-value\n"),
            (
                "config/settings.toml",
                "[credentials]\n\"token\" = \"opaque-value\"\n",
            ),
            ("config/runtime.conf", "DB_PASSWORD_CURRENT=opaque-value\n"),
            (
                "config/settings.toml",
                "[credentials]\n'APP_TOKEN' = 'opaque-value'\n",
            ),
            (
                "config/settings.toml",
                "service.\"private\\u005fkey\" = \"opaque-value\"\n",
            ),
            (
                "config/runtime.conf",
                "//registry.example.invalid/:_auth=opaque-value\n",
            ),
            ("config/runtime.conf", "api_token=opaque-value\n"),
            ("config/runtime.conf", "auth=opaque-value\n"),
            ("config/runtime.conf", "private_key=opaque-value\n"),
            (
                "config/runtime.conf",
                "token_url = \"unfinished\nDB_PASSWORD=opaque-value\n",
            ),
            (
                "config/settings.json",
                "{\"api_token_url_secret\":\"opaque-value\"}\n",
            ),
            (
                "config/settings.json",
                &format!("{{\"token_url\":\"github_pat_{}\"}}\n", "a".repeat(32)),
            ),
            (
                "config/settings.json",
                &format!("{{\"ghp_{}\":\"\"}}\n", "a".repeat(32)),
            ),
            (
                "config/settings.json",
                "{\"token_file\":\"-----BEGIN PRIVATE KEY-----\\nsynthetic\\n-----END PRIVATE KEY-----\"}\n",
            ),
            (
                "config/runtime.conf",
                "https://octo:opaque-value@example.invalid\n",
            ),
            (
                "config/runtime.conf",
                "DB_PASSWORD=\"\"\napi_token=opaque-value\n",
            ),
            ("config/runtime.conf", "DB_PASSWORD=\"\"opaque-value\n"),
        ] {
            expect(path, text, "sensitive_publication");
        }
    }

    // The same file's ordinary samples, which must publish.
    #[test]
    fn ordinary_settings_publish() {
        for (path, text) in [
            (
                "config/runtime.conf",
                "DB_HOST=example.invalid\nRETRY_COUNT=3\n",
            ),
            (
                "config/settings.toml",
                "[settings]\n\"host\" = \"example.invalid\"\n",
            ),
            (
                "config/runtime.conf",
                "password_min_length = 8\ntoken_url = \"https://example.invalid\"\n",
            ),
            (
                "config/runtime.conf",
                "api_token_endpoint = \"https://example.invalid\"\nprivate_key_path = \"local/key\"\npassword_file = \"local/pass\"\ntoken_expiry = 120\ntoken_ttl = 60\npassword_max_length = 100\npasswordMinLength = 8\n",
            ),
            (
                "config/settings.toml",
                "[settings]\n\"password_min_length\" = 8\n\"token_url\" = \"https://example.invalid\"\nauth.token_endpoint = \"https://example.invalid\"\n",
            ),
            (
                "config/settings.json",
                "{\"token_url\":\"https://example.invalid\"}\n",
            ),
            (
                "config/settings.yaml",
                "\"token_url\": \"https://example.invalid\"\n",
            ),
            ("config/runtime.conf", "DB_PASSWORD=\"\"\nAPI_TOKEN=''\n"),
            (
                "config/settings.toml",
                "[settings]\n\"token\" = \"\"\n'password' = ''\n\"tok\\u0065n\" = \"\"\n",
            ),
            ("config/settings.json", "{\"password\":\"\"}\n"),
            ("config/settings.yaml", "\"password\": \"\"\n'token': ''\n"),
        ] {
            expect(path, text, "publishable");
        }
    }

    #[test]
    fn many_short_assignments_and_long_values_are_handled_within_their_budgets() {
        expect(
            "config/runtime.conf",
            &"a . a\n".repeat(10_000),
            "publishable",
        );
        let text = format!(
            "banner = \"{}\"\nexample = {}\n",
            "a".repeat(20_000),
            "a".repeat(20_000)
        );
        expect("config/runtime.conf", &text, "publishable");
        for text in [
            "a . ".repeat(50_000),
            "a".repeat(16_385),
            format!("\"{}\"", "a".repeat(16_385)),
        ] {
            expect("config/runtime.conf", &text, "publication_scan_incomplete");
        }
    }

    // The same file's YAML credential cases.
    #[test]
    fn yaml_credential_fields_are_blocked() {
        let samples = [
            (
                "deploy/settings.yaml",
                "auths:\n  registry.example.invalid:\n    'auth': c3ludGhldGljOmNyZWRlbnRpYWw=\n"
                    .to_owned(),
            ),
            (
                "deploy/settings.yaml",
                "'private_key': 'opaque-value'\n".to_owned(),
            ),
            (
                "deploy/kubeconfig.yaml",
                config("    'token': opaque-value"),
            ),
            (
                "deploy/KUBECONFIG.production.yml",
                config("    'token': opaque-value"),
            ),
            ("deploy/cluster.yaml", config("    'token': opaque-value")),
            ("deploy/cluster.yaml", config("    \"token\": opaque-value")),
            ("deploy/cluster.yaml", config("    token: opaque-value")),
            (
                "deploy/cluster.yaml",
                config("    \"t\\u006fken\": opaque-value"),
            ),
            (
                "deploy/cluster.yaml",
                config("    'client-key-data': b3BhcXVlLXZhbHVl"),
            ),
            (
                "deploy/cluster.yaml",
                config("    'client-certificate-data': b3BhcXVlLXZhbHVl"),
            ),
            (
                "deploy/cluster.yaml",
                config("    'password': opaque-value"),
            ),
            (
                "deploy/cluster.yaml",
                config(
                    "    'auth-provider':\n      name: opaque-provider\n      config:\n        cached: opaque-value",
                ),
            ),
            (
                "deploy/cluster.yaml",
                config(
                    "    'exec':\n      command: credential-helper\n      'env':\n      - name: OPAQUE_AUTH\n        value: opaque-value",
                ),
            ),
        ];
        for (path, text) in samples {
            expect(path, &text, "sensitive_publication");
        }
    }

    #[test]
    fn uninspectable_yaml_fails_closed_and_plain_yaml_publishes() {
        let depth: String = (0..66)
            .map(|index| format!("{}value:\n", "  ".repeat(index)))
            .collect();
        let nodes = format!("values:\n{}", "- safe\n".repeat(100_001));
        let documents = "---\nvalue: safe\n".repeat(21);
        for text in [
            "settings: [broken".to_owned(),
            "base: &base {value: safe}\ncopy: *base\n".to_owned(),
            "value: !opaque safe\n".to_owned(),
            format!("#{}", "a".repeat(1024 * 1024)),
            depth,
            nodes,
            documents,
        ] {
            expect("deploy/settings.yaml", &text, "publication_scan_incomplete");
        }
        expect(
            "deploy/settings.yaml",
            "apiVersion: v1\nkind: Config\ncontexts: []\nusers: []\n",
            "publishable",
        );
        expect(
            "deploy/settings.YML",
            "settings: [broken",
            "publication_scan_incomplete",
        );
        expect("deploy/settings.txt", "settings: [broken", "publishable");
    }

    // The same file's sensitive paths and literal secrets.
    #[test]
    fn sensitive_paths_and_literal_secrets_are_blocked() {
        for (path, text) in [
            (".env.production", "setting=value"),
            ("config/credentials.json", "{}"),
            (
                "notes.txt",
                "-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic\n-----END OPENSSH PRIVATE KEY-----",
            ),
            ("src/config.txt", &format!("ghp_{}", "x".repeat(32))),
            ("archive.bin", "\0Bearer synthetic-private-value\0"),
            (
                "docs/link.txt",
                "https://example.invalid/#ticket=opaque-credential",
            ),
            (
                ".docker/config.json",
                "{\"auths\":{\"registry.example.invalid\":{\"auth\":\"c3ludGhldGljOmNyZWRlbnRpYWw=\"}}}",
            ),
            (
                "registry.json",
                "{\"auths\":{\"registry.example.invalid\":{\"a\\u0075th\":\"c3ludGhldGljOmNyZWRlbnRpYWw=\"}}}",
            ),
            (".npmrc", "//registry.example.invalid/:_authToken=synthetic"),
            (
                "copied-config.txt",
                "//registry.example.invalid/:_authToken=synthetic",
            ),
            (".pypirc", "[index-server]\npassword = synthetic"),
            (
                ".netrc",
                "machine example.invalid login synthetic password synthetic",
            ),
            (
                ".git-credentials",
                "https://synthetic:synthetic@example.invalid",
            ),
            (
                ".aws/credentials",
                "[default]\naws_secret_access_key=synthetic",
            ),
            (".azure/msal_token_cache.bin", "synthetic"),
            (".config/gcloud/access_tokens.db", "synthetic"),
            (
                "copied-cloud.json",
                "{\"profile\":{\"aws_access_key_id\":\"synthetic\"}}",
            ),
        ] {
            expect(path, text, "sensitive_publication");
        }
        expect(
            "asset.bin",
            "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
            "publication_scan_incomplete",
        );
    }

    #[tokio::test]
    async fn a_scan_reads_every_tracked_path_and_reachable_object() {
        let fixture = Fixture::new("g3d-scan");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        std::fs::write(repo.join("safe.txt"), "nothing secret\n").expect("safe");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "safe"]);
        let port = ProcessCommands { fixture: &fixture };
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        scan_publication(&port, &repo.to_string_lossy(), &head)
            .await
            .expect("safe scan");

        // A token in a reachable blob is found even in history.
        std::fs::write(repo.join("leak.txt"), format!("ghp_{}", "x".repeat(32))).expect("leak");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "leak"]);
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let error = scan_publication(&port, &repo.to_string_lossy(), &head)
            .await
            .expect_err("leak");
        assert_eq!(error.code, GitErrorCode::SensitivePublication);
    }

    #[tokio::test]
    async fn a_shallow_checkout_and_a_sensitive_path_fail_before_a_read() {
        let fixture = Fixture::new("g3d-scan-paths");
        let repo = fixture.repository("repo");
        fixture.git(&repo, &["config", "user.email", "t@example.invalid"]);
        fixture.git(&repo, &["config", "user.name", "T"]);
        std::fs::create_dir_all(repo.join("config")).expect("dir");
        std::fs::write(repo.join("config/credentials.json"), "{}").expect("credentials");
        fixture.git(&repo, &["add", "."]);
        fixture.git(&repo, &["commit", "--quiet", "-m", "credentials"]);
        let port = ProcessCommands { fixture: &fixture };
        let head = String::from_utf8_lossy(&fixture.git(&repo, &["rev-parse", "HEAD"]))
            .trim_end()
            .to_owned();
        let error = scan_publication(&port, &repo.to_string_lossy(), &head)
            .await
            .expect_err("path");
        assert_eq!(error.code, GitErrorCode::SensitivePublication);
    }
}
