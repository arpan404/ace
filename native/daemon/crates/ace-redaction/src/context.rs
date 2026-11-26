// SPDX-License-Identifier: Apache-2.0
//! The redactors of `packages/redaction/src/index.ts`: one lexical rule set (workspace,
//! home, host, user, exact environment values and their escaped spellings) applied to
//! literal prose, to one JSONL record, to diagnostics that may embed JSON in prose, and to a
//! stream in bounded chunks.
//!
//! The TypeScript's bounds count UTF-16 code units and so do these; `\/Users\/…`,
//! `\/home\/…`, identifiers and e-mail addresses are hidden as the TypeScript hides them.

use std::collections::HashSet;
use std::sync::LazyLock;

use ace_json::{Map, Value};
use regex::Regex;

use crate::embedded_text::redact_embedded_text;
use crate::environment::EnvironmentMatcher;
use crate::literal_spans::redact_original_text;
use crate::record_environment::redact_record_environment;
use crate::secret_keys::is_secret_key;
use crate::token_counters::accounting_counter;

/// The strings that describe runtime operation, not identity or authentication
/// (`OPERATIONAL_ENV`): redacting them garbles fix-it text.
const OPERATIONAL_ENV: [&str; 14] = [
    "ACE_LOG_LEVEL",
    "LOG_LEVEL",
    "NODE_ENV",
    "DEBUG",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "FORCE_COLOR",
    "XDG_SESSION_CLASS",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_DESKTOP",
    "XDG_CURRENT_DESKTOP",
    "DESKTOP_SESSION",
    // How the daemon listens ("local", "lan", "tailscale"): redacting it garbled fix-it text
    // such as "Run `sudo tailscale set --operator=$USER`".
    "ACE_LISTEN",
];

/// The largest literal text redacted; the TypeScript's `.length` bound (UTF-16 units).
const MAX_TEXT_UNITS: usize = 65_536;
/// The largest redacted literal result.
const MAX_SCRUBBED_UNITS: usize = 262_144;
/// The largest JSONL record redacted, in UTF-16 units.
const MAX_RECORD_UNITS: usize = 262_144;
/// The largest stream chunk, in UTF-16 units.
const MAX_CHUNK_UNITS: usize = 65_536;
/// One stream chunk's nominal size, in bytes (`text.slice(start, start + 4096)`).
const CHUNK_BYTES: usize = 4_096;
/// The recursive clean's visit budget.
const CLEAN_BUDGET: i64 = 10_000;

static FILE_URL_HOME: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r#"(?i)(\bfile://[^/\s"'<>]*)/(?:Users|home)/[^/\s"'<>?#]+"#,
        "the file-URL home pattern",
    )
});
static ABSOLUTE_HOME: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r#"(?i)(^|[^A-Za-z0-9_./\\-])(/(?:Users|home)/[^/\s"'<>]+)"#,
        "the absolute-home pattern",
    )
});
static TEMP_PATH: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r#"/(?:private/)?var/folders/[^/\s'"<>]+/[^/\s'"<>]+/[TC]/"#,
        "the temporary-directory pattern",
    )
});
static IDENTIFYING_KEYS: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r#""(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)":"[^"]*""#,
        "the identifying-key pattern",
    )
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"(?:^|[^A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})",
        "the e-mail pattern",
    )
});
/// The e-mail scan's positions for the streaming redactor (no capture, so a match's ends
/// are the address's own).
static EMAIL_SCAN: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        "the e-mail scan pattern",
    )
});
static IDENTITY_FIELD: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"^(installationId|deviceId|accountId|account_uuid|userId|user_id|organizationId|organization_uuid|orgId)$",
        "the identity-field pattern",
    )
});
/// E-mails that identify no person and stay readable.
const KEEP_EMAILS: [&str; 2] = ["recorder@ace.invalid", "noreply@anthropic.com"];
static STRUCTURED_START: LazyLock<Regex> =
    LazyLock::new(|| regex(r#"^\s*[\[{"]"#, "the structured-start pattern"));

/// Compiles a literal pattern this crate owns; a failure is a programming error, never input.
#[allow(clippy::expect_used)]
fn regex(source: &str, what: &str) -> Regex {
    Regex::new(source).expect(what)
}

/// What a redactor may and may not reveal about the machine and the request.
#[derive(Debug, Clone, Default)]
pub struct Context {
    pub workspace: Option<String>,
    pub home: Option<String>,
    pub username: Option<String>,
    pub host: Option<String>,
    /// The environment's entries in the caller's order. A name holding an empty value or an
    /// operational word is not sensitive.
    pub env: Vec<(String, String)>,
}

impl Context {
    fn sensitive_environment(&self) -> Vec<(&str, &str)> {
        self.env
            .iter()
            .filter(|(name, value)| !value.is_empty() && !OPERATIONAL_ENV.contains(&name.as_str()))
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect()
    }
}

/// The lexical rules, built once per redactor.
#[derive(Debug)]
struct Lexical {
    paths: Vec<(Regex, &'static str)>,
    user: Option<Regex>,
    environment: EnvironmentMatcher,
    short_values: HashSet<String>,
}

fn escape(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        if matches!(
            character,
            '.' | '*' | '+' | '?' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '^' | '$' | '\\'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

impl Lexical {
    fn new(context: &Context) -> Lexical {
        let home = context.home.as_deref().unwrap_or("");
        let username = context.username.as_deref().unwrap_or("");
        let host = context.host.as_deref().unwrap_or("");
        let short_host = host.split('.').next().unwrap_or(host);
        let workspace = context.workspace.as_deref().unwrap_or("");
        // Longest first so the workspace path wins over its home-directory prefix.
        let mut paths = Vec::new();
        for (value, replacement) in [
            (escape(workspace), "<WORKSPACE>"),
            (escape(&workspace.replace('/', "-")), "-<WORKSPACE>"),
            (escape(home), "<HOME>"),
            (escape(host), "<HOST>"),
            (escape(short_host), "<HOST>"),
        ] {
            if value.is_empty() {
                continue;
            }
            paths.push((regex(&value, "a literal path pattern"), replacement));
        }
        let user = if ace_json::utf16_len(username) >= 3 {
            Some(regex(
                &format!(r"\b{}\b", escape(username)),
                "the literal user pattern",
            ))
        } else {
            None
        };
        let sensitive = context.sensitive_environment();
        let values: Vec<&str> = sensitive
            .iter()
            .filter(|(name, value)| ace_json::utf16_len(value) >= 4 || is_secret_key(name))
            .map(|(_, value)| *value)
            .collect();
        let short_values = sensitive
            .iter()
            .map(|(_, value)| *value)
            .filter(|value| ace_json::utf16_len(value) < 4)
            .map(str::to_owned)
            .collect();
        Lexical {
            paths,
            user,
            environment: EnvironmentMatcher::new(&values),
            short_values,
        }
    }

    fn scrub(&self, line: &str) -> String {
        if self.short_values.contains(line) {
            return String::from("<ENV>");
        }
        let mut out = redact_original_text(line, Some(&self.environment));
        for (pattern, replacement) in &self.paths {
            if pattern.is_match(&out) {
                out = pattern.replace_all(&out, *replacement).into_owned();
            }
        }
        out = FILE_URL_HOME.replace_all(&out, "$1<HOME>").into_owned();
        out = ABSOLUTE_HOME.replace_all(&out, "$1<HOME>").into_owned();
        out = TEMP_PATH.replace_all(&out, "<TEMP>/").into_owned();
        out = IDENTIFYING_KEYS
            .replace_all(&out, |captures: &regex::Captures<'_>| {
                format!(
                    "\"{}\":\"<ID>\"",
                    captures.get(1).map_or("", |key| key.as_str())
                )
            })
            .into_owned();
        out = EMAIL
            .replace_all(&out, |captures: &regex::Captures<'_>| {
                let whole = captures.get(0).map_or("", |found| found.as_str());
                let address = captures.get(1).map_or("", |found| found.as_str());
                if KEEP_EMAILS.contains(&address) {
                    whole.to_owned()
                } else {
                    format!("{}<EMAIL>", &whole[..whole.len() - address.len()])
                }
            })
            .into_owned();
        if let Some(user) = &self.user {
            out = user.replace_all(&out, "<USER>").into_owned();
        }
        out
    }
}

/// The literal-text bounds, and the recursive clean's shared budget.
struct Budget {
    remaining: i64,
}

/// One built redactor: the lexical rules and the environment matcher.
#[derive(Debug)]
pub struct Redactor {
    lexical: Lexical,
}

/// A stream chunk exceeded the budget: the caller must not emit it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkTooLarge;

impl std::fmt::Display for ChunkTooLarge {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Sensitive SDK text exceeds redaction chunk budget")
    }
}

impl std::error::Error for ChunkTooLarge {}

impl Redactor {
    /// Builds the rules once; the environment's values live only in the matcher.
    pub fn new(context: &Context) -> Redactor {
        Redactor {
            lexical: Lexical::new(context),
        }
    }

    /// One literal piece of prose (an error message, a log line), bounded.
    pub fn text(&self, text: &str) -> String {
        if ace_json::utf16_len(text) > MAX_TEXT_UNITS {
            return String::from("<OVERSIZED REDACTED>");
        }
        let safe = self.lexical.scrub(text);
        if ace_json::utf16_len(&safe) > MAX_SCRUBBED_UNITS {
            String::from("<OVERSIZED REDACTED>")
        } else {
            safe
        }
    }

    /// One JSONL record: parsed, keys classified, values scrubbed, and re-serialized with
    /// `JSON.stringify`'s rules. `literal_fields` name the keys whose text is literal prose.
    pub fn record(&self, literal_fields: &[&str], line: &str) -> String {
        if ace_json::utf16_len(line) > MAX_RECORD_UNITS {
            return String::from("\"<OVERSIZED REDACTED>\"");
        }
        let literal: HashSet<&str> = literal_fields.iter().copied().collect();
        let mut budget = Budget {
            remaining: CLEAN_BUDGET,
        };
        let record = redact_record_environment(line, Some(&self.lexical.environment));
        match ace_json::parse(&record) {
            Ok(value) => {
                match ace_json::ser::to_string(&self.clean(&value, 0, None, &literal, &mut budget))
                {
                    Ok(clean) => clean,
                    Err(_) => String::from("\"<REDACTION FAILED: RECORD OMITTED>\""),
                }
            }
            // A damaged structured record must never fall back to weaker lexical rules.
            Err(_) if STRUCTURED_START.is_match(line) => {
                String::from("\"<INVALID STRUCTURED DATA OMITTED>\"")
            }
            Err(_) => self.embedded(line, &literal, &mut budget, 0),
        }
    }

    /// A diagnostic: prose that may embed JSON, scrubbed record by record.
    pub fn diagnostic(&self, text: &str) -> String {
        if ace_json::utf16_len(text) > MAX_TEXT_UNITS {
            return String::from("<OVERSIZED REDACTED>");
        }
        let literal: HashSet<&str> = HashSet::new();
        let mut budget = Budget {
            remaining: CLEAN_BUDGET,
        };
        self.embedded(text, &literal, &mut budget, 0)
    }

    /// `text` in bounded chunks, each scrubbed, with secrets that cross a boundary kept
    /// whole by extending the chunk to the secret's end.
    pub fn stream(&self, text: &str) -> Result<Vec<String>, ChunkTooLarge> {
        let spans = crate::literal_spans::sensitive_spans(text, Some(&self.lexical.environment));
        let mut span_index = 0usize;
        let mut scans: Vec<Scan<'_>> = [&*EMAIL_SCAN, &*IDENTIFYING_KEYS]
            .into_iter()
            .map(|scan| Scan {
                regex: scan.clone(),
                found: scan.find_at(text, 0),
            })
            .collect();
        let mut chunks = Vec::new();
        let mut start = 0usize;
        while start < text.len() {
            let mut end = (start + CHUNK_BYTES).min(text.len());
            let mut parts = String::with_capacity(end - start);
            let mut plain = start;
            for scan in &mut scans {
                while scan
                    .found
                    .as_ref()
                    .is_some_and(|found| found.end() <= start)
                {
                    scan.found = scan.regex.find_at(text, start);
                }
            }
            let mut changed = true;
            while changed {
                changed = false;
                while let Some(span) = spans.get(span_index) {
                    if span.start >= end {
                        break;
                    }
                    parts.push_str(&text[plain..span.start]);
                    parts.push_str(&span.replacement);
                    plain = span.end;
                    if span.end > end {
                        end = span.end;
                        changed = true;
                    }
                    span_index += 1;
                }
                for scan in &mut scans {
                    while let Some(found) = scan.found {
                        if found.start() >= end {
                            break;
                        }
                        if found.end() > end {
                            end = found.end();
                            changed = true;
                        }
                        scan.found = scan.regex.find_at(text, found.end());
                    }
                }
            }
            // A chunk must end on a character boundary, as the TypeScript's unit boundary
            // never splits a surrogate pair.
            while end < text.len() && !text.is_char_boundary(end) {
                end += 1;
            }
            if ace_json::utf16_len(&text[start..end]) > MAX_CHUNK_UNITS {
                return Err(ChunkTooLarge);
            }
            parts.push_str(&text[plain..end]);
            chunks.push(self.lexical.scrub(&parts));
            start = end;
        }
        Ok(chunks)
    }

    fn embedded(
        &self,
        text: &str,
        literal: &HashSet<&str>,
        budget: &mut Budget,
        depth: u32,
    ) -> String {
        let scrub = |value: &str| self.lexical.scrub(value);
        let mut record = |record: &str| self.clean_record(record, literal, budget, depth);
        redact_embedded_text(text, &scrub, &mut record, Some(&self.lexical.environment))
    }

    fn clean_record(
        &self,
        record: &str,
        literal: &HashSet<&str>,
        budget: &mut Budget,
        depth: u32,
    ) -> String {
        let record = redact_record_environment(record, Some(&self.lexical.environment));
        match ace_json::parse(&record) {
            Ok(value) => {
                ace_json::ser::to_string(&self.clean(&value, depth, None, literal, budget))
                    .unwrap_or_else(|_| String::from("\"<REDACTION FAILED: RECORD OMITTED>\""))
            }
            Err(_) => String::from("\"<INVALID STRUCTURED DATA OMITTED>\""),
        }
    }

    fn clean(
        &self,
        value: &Value,
        depth: u32,
        field: Option<&str>,
        literal: &HashSet<&str>,
        budget: &mut Budget,
    ) -> Value {
        budget.remaining -= 1;
        if budget.remaining < 0 || depth > 32 {
            return Value::from("<OMITTED>");
        }
        match value {
            Value::String(text) => {
                let text = text.as_str();
                if let Some(field) = field
                    && literal.contains(field)
                {
                    return Value::from(self.lexical.scrub(text));
                }
                let trimmed = text.trim_start();
                if trimmed.starts_with('{') || trimmed.starts_with('[') || trimmed.starts_with('"')
                {
                    let embedded = redact_record_environment(text, Some(&self.lexical.environment));
                    return match ace_json::parse(&embedded) {
                        Ok(value) => match ace_json::ser::to_string(&self.clean(
                            &value,
                            depth + 1,
                            None,
                            literal,
                            budget,
                        )) {
                            Ok(serialized) => Value::from(serialized),
                            Err(_) => Value::from("<INVALID STRUCTURED DATA OMITTED>"),
                        },
                        Err(_) => Value::from("<INVALID STRUCTURED DATA OMITTED>"),
                    };
                }
                Value::from(self.embedded(text, literal, budget, depth + 1))
            }
            Value::Array(items) => {
                let take = budget.remaining.max(0) as usize;
                Value::Array(
                    items
                        .iter()
                        .take(take)
                        .map(|item| self.clean(item, depth + 1, None, literal, budget))
                        .collect(),
                )
            }
            Value::Object(entries) => {
                let mut result = Map::new();
                for (key, item) in entries.iter() {
                    if budget.remaining <= 0 {
                        break;
                    }
                    let key = key.as_str();
                    let cleaned = if is_secret_key(key) && !accounting_counter(key, item) {
                        Value::from("<SECRET>")
                    } else if IDENTITY_FIELD.is_match(key) {
                        Value::from("<ID>")
                    } else {
                        self.clean(item, depth + 1, Some(key), literal, budget)
                    };
                    result.insert(self.lexical.scrub(key), cleaned);
                }
                Value::Object(result)
            }
            other => other.clone(),
        }
    }
}

/// One regex's position in the streaming scan.
struct Scan<'a> {
    regex: Regex,
    found: Option<regex::Match<'a>>,
}

/// Whether `key`'s value is a secret that must never be seen (as `isSensitiveField`).
pub fn is_sensitive_field(key: &str, value: &Value) -> bool {
    is_secret_key(key) && !accounting_counter(key, value)
}
