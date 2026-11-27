// SPDX-License-Identifier: Apache-2.0
//! The lexical rules of `packages/redaction/src/index.ts` (workspace, home, host, user,
//! exact environment values and their JSON-escaped spellings): what a redactor may and may
//! not reveal about the machine and the request, applied line by line. The redactors that
//! use them live in `redactor.rs`.
//!
//! `\/Users\/…`, `\/home\/…`, identifiers and e-mail addresses are hidden as the
//! TypeScript hides them, and the operational environment words stay readable.

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

use crate::environment::EnvironmentMatcher;
use crate::literal_spans::redact_original_text;
use crate::secret_keys::is_secret_key;

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
pub(crate) static IDENTIFYING_KEYS: LazyLock<Regex> = LazyLock::new(|| {
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
pub(crate) static EMAIL_SCAN: LazyLock<Regex> = LazyLock::new(|| {
    regex(
        r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
        "the e-mail scan pattern",
    )
});
/// E-mails that identify no person and stay readable.
const KEEP_EMAILS: [&str; 2] = ["recorder@ace.invalid", "noreply@anthropic.com"];
/// Compiles a literal pattern this crate owns; a failure is a programming error, never input.
#[allow(clippy::expect_used)]
pub(crate) fn regex(source: &str, what: &str) -> Regex {
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

/// The exact values a redactor masks from a caller's environment: every non-operational,
/// non-empty entry whose value is at least four UTF-16 units or whose name says it is a
/// secret. The TypeScript composes the same two filters (`index.ts:38-60`), and
/// [`Lexical::new`] uses this list.
pub fn environment_values(env: &[(String, String)]) -> Vec<String> {
    let context = Context {
        env: env.to_vec(),
        ..Context::default()
    };
    context
        .sensitive_environment()
        .into_iter()
        .filter(|(name, value)| ace_json::utf16_len(value) >= 4 || is_secret_key(name))
        .map(|(_, value)| value.to_owned())
        .collect()
}

/// A matcher over [`environment_values`].
pub fn environment_matcher(env: &[(String, String)]) -> EnvironmentMatcher {
    EnvironmentMatcher::new(&environment_values(env))
}

/// The lexical rules, built once per redactor.
#[derive(Debug)]
pub(crate) struct Lexical {
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
    pub(crate) fn new(context: &Context) -> Lexical {
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
        let values: Vec<String> = environment_values(&context.env);
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

    /// The exact configured values, for the record and stream paths.
    pub(crate) fn environment(&self) -> &EnvironmentMatcher {
        &self.environment
    }

    pub(crate) fn scrub(&self, line: &str) -> String {
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
