// SPDX-License-Identifier: Apache-2.0
//! Classifying a provider's failure into a fixed, safe category (`discovery-failure.ts`,
//! `discovery-errors.ts`).
//!
//! Provider prose never leaves this module. Categories come from bounded inspection of the
//! error's own fields and their chain, and the person sees one of a fixed set of messages
//! and hints. Only shapes ace controls are read; credentials and vendor objects are not.

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::cli::{CliTooOld, cli_too_old_message};

/// The categories a discovery failure can have (`DiscoveryFailureCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureCode {
    NotInstalled,
    NotConfigured,
    AuthExpired,
    Unreachable,
    CliTooOld,
    CliUnsupported,
    RateLimited,
    ParseFailure,
    Timeout,
    PersistenceFailed,
    DiscoveryFailed,
    NoModels,
}

/// Every category ace can report, in the protocol's order.
pub const DISCOVERY_FAILURE_CODES: [FailureCode; 12] = [
    FailureCode::NotInstalled,
    FailureCode::NotConfigured,
    FailureCode::AuthExpired,
    FailureCode::Unreachable,
    FailureCode::CliTooOld,
    FailureCode::CliUnsupported,
    FailureCode::RateLimited,
    FailureCode::ParseFailure,
    FailureCode::Timeout,
    FailureCode::PersistenceFailed,
    FailureCode::DiscoveryFailed,
    FailureCode::NoModels,
];

impl FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotInstalled => "not_installed",
            Self::NotConfigured => "not_configured",
            Self::AuthExpired => "auth_expired",
            Self::Unreachable => "unreachable",
            Self::CliTooOld => "cli_too_old",
            Self::CliUnsupported => "cli_unsupported",
            Self::RateLimited => "rate_limited",
            Self::ParseFailure => "parse_failure",
            Self::Timeout => "timeout",
            Self::PersistenceFailed => "persistence_failed",
            Self::DiscoveryFailed => "discovery_failed",
            Self::NoModels => "no_models",
        }
    }

    /// The six categories a provider's own failure chain can name.
    fn explicit(value: &str) -> Option<Self> {
        Some(match value {
            "not_installed" => Self::NotInstalled,
            "not_configured" => Self::NotConfigured,
            "auth_expired" => Self::AuthExpired,
            "unreachable" => Self::Unreachable,
            "cli_too_old" => Self::CliTooOld,
            "cli_unsupported" => Self::CliUnsupported,
            "rate_limited" => Self::RateLimited,
            "parse_failure" => Self::ParseFailure,
            "timeout" => Self::Timeout,
            "persistence_failed" => Self::PersistenceFailed,
            "discovery_failed" => Self::DiscoveryFailed,
            _ => return None,
        })
    }
}

impl std::fmt::Display for FailureCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The one error the client sees (`ModelDiscoveryError`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveryError {
    pub code: FailureCode,
    pub message: String,
    pub hint: String,
    #[serde(rename = "actionId", skip_serializing_if = "Option::is_none", default)]
    pub action_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub severity: Option<Severity>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Info,
    Warning,
}

/// What a discovery port reports when it fails, in the shape the classifier reads.
///
/// A port fills only what it knows: a status code, an error name, a message, or a nested
/// cause. Nothing here is published; [`discovery_error`] turns it into a fixed category.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryFailure {
    pub code: Option<String>,
    pub discovery_code: Option<String>,
    pub name: Option<String>,
    pub reason: Option<String>,
    /// An Effect-style `_tag`.
    pub tag: Option<String>,
    pub detail: Option<String>,
    pub message: Option<String>,
    /// A number, or a three-digit string, as provider SDKs send them.
    pub status: Option<f64>,
    /// `true` when the failure was a parse error (a Zod or `SyntaxError` in the TypeScript).
    pub parse_failure: bool,
    pub cause: Option<Box<DiscoveryFailure>>,
    pub error: Option<Box<DiscoveryFailure>>,
    pub data: Option<Box<DiscoveryFailure>>,
    pub response: Option<Box<DiscoveryFailure>>,
    pub body: Option<Box<DiscoveryFailure>>,
    /// Already one of ace's own errors, re-reported (a per-source copy of a CLI refusal).
    pub known: Option<DiscoveryError>,
    /// A CLI refused before or during discovery for being too old.
    pub too_old: Option<CliTooOld>,
}

impl DiscoveryFailure {
    pub fn new(message: &str) -> Self {
        Self {
            message: Some(message.to_owned()),
            ..Self::default()
        }
    }

    pub fn with_code(code: FailureCode) -> Self {
        Self {
            code: Some(code.as_str().to_owned()),
            ..Self::default()
        }
    }

    pub fn with_status(status: f64) -> Self {
        Self {
            status: Some(status),
            ..Self::default()
        }
    }
}

/// The text rules of `discoveryFailureCode`, compiled once in order.
fn classifications() -> &'static [(Option<Regex>, FailureCode)] {
    static PATTERNS: std::sync::OnceLock<Vec<(Option<Regex>, FailureCode)>> =
        std::sync::OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (
                r"(?i)not.configured|missing.api.key|no.api.key|not.logged.in|not.signed.in|(?:CURSOR_API_KEY|api.?key).*(?:required|missing|not.set)|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|cannot.find.module|ENOENT",
                FailureCode::NotConfigured,
            ),
            (
                r"(?i)authentication|unauthenticated|unauthorized|auth.expired|\b(?:401|403)\b",
                FailureCode::AuthExpired,
            ),
            (
                r"(?i)RateLimitError|rate.limit|\b429\b",
                FailureCode::RateLimited,
            ),
            (
                r"(?i)parse.failure|unreadable.*metadata|MalformedResponse|UnsupportedContentType",
                FailureCode::ParseFailure,
            ),
            (
                r"(?i)unsupported.*version|version.*unsupported|method.*not.*found|cli.*too.old",
                FailureCode::CliTooOld,
            ),
            (
                r"(?i)NetworkError|Transport|ECONN|ENOTFOUND|unreachable|fetch failed|network|offline",
                FailureCode::Unreachable,
            ),
        ]
        .into_iter()
        .map(|(source, code)| (Regex::new(source).ok(), code))
        .collect()
    })
}

/// The three-digit status a failure names, if any.
fn status_of(failure: &DiscoveryFailure) -> Option<u32> {
    let value = failure.status?;
    if !value.is_finite() || value.fract() != 0.0 {
        return None;
    }
    let value = value as i64;
    (0..=999).contains(&value).then_some(value as u32)
}

fn text_of(failure: &DiscoveryFailure) -> String {
    let bounded = |text: &Option<String>| {
        text.as_deref()
            .map(|text| ace_models::text::slice_utf16(text, 8192))
            .unwrap_or_default()
    };
    [
        bounded(&failure.name),
        bounded(&failure.reason),
        bounded(&failure.tag),
        bounded(&failure.code),
        bounded(&failure.detail),
        bounded(&failure.message),
    ]
    .join(" ")
}

/// `discoveryFailureCode`: only a fixed category leaves this function.
pub fn discovery_failure_code(
    failure: Option<&DiscoveryFailure>,
    fallback: FailureCode,
) -> FailureCode {
    let mut pending: Vec<&DiscoveryFailure> = failure.into_iter().collect();
    let mut entries = 0;
    let mut parse_failure = false;
    let mut text = String::new();
    while entries < 12 {
        let Some(current) = pending.first().copied() else {
            break;
        };
        pending.remove(0);
        entries += 1;
        let entry = current;
        if entry.parse_failure {
            parse_failure = true;
        }
        for explicit in [&entry.discovery_code, &entry.code].into_iter().flatten() {
            if let Some(code) = FailureCode::explicit(explicit)
                && code != FailureCode::DiscoveryFailed
            {
                return code;
            }
        }
        match status_of(entry) {
            Some(401 | 403) => return FailureCode::AuthExpired,
            Some(429) => return FailureCode::RateLimited,
            Some(500..=599) => return FailureCode::Unreachable,
            _ => {}
        }
        text.push_str(&text_of(entry));
        text.push(' ');
        for nested in [
            &entry.cause,
            &entry.error,
            &entry.data,
            &entry.response,
            &entry.body,
        ]
        .into_iter()
        .flatten()
        {
            pending.push(nested);
        }
    }
    if parse_failure {
        return FailureCode::ParseFailure;
    }
    classify_text(&text).unwrap_or(fallback)
}

fn classify_text(text: &str) -> Option<FailureCode> {
    for (pattern, code) in classifications() {
        if pattern
            .as_ref()
            .is_some_and(|pattern| pattern.is_match(text))
        {
            return Some(*code);
        }
    }
    None
}

/// What the message names when it is shown.
#[derive(Default)]
pub struct ErrorContext<'a> {
    pub provider: Option<&'a str>,
    pub source: Option<&'a str>,
    pub backend: Option<&'a str>,
}

fn messages(code: FailureCode) -> (&'static str, &'static str) {
    match code {
        FailureCode::NotInstalled => (
            "OpenCode v2 is not installed.",
            "Install OpenCode v2, then refresh models.",
        ),
        FailureCode::NoModels => (
            "The connected source has no chat models enabled.",
            "Enable models for it in OpenCode, then Refresh.",
        ),
        FailureCode::NotConfigured => (
            "Provider is not configured.",
            "Set up the provider, then refresh models.",
        ),
        FailureCode::AuthExpired => (
            "Provider sign-in has expired.",
            "Sign in again using the provider CLI, then refresh models.",
        ),
        FailureCode::Unreachable => (
            "Provider could not be reached.",
            "Check the provider endpoint and network, then refresh models.",
        ),
        FailureCode::CliTooOld => (
            "The installed CLI cannot list these models.",
            "Update the provider CLI, then refresh models.",
        ),
        FailureCode::CliUnsupported => (
            "This version of the provider CLI isn't supported yet.",
            "Install a supported version of the provider CLI, then refresh models.",
        ),
        FailureCode::RateLimited => (
            "Provider model discovery was rate limited.",
            "Wait a few minutes, then refresh models.",
        ),
        FailureCode::ParseFailure => (
            "Provider returned unreadable model metadata.",
            "Update the CLI and refresh models. Report this if it persists.",
        ),
        FailureCode::Timeout => (
            "Model discovery timed out.",
            "Check the provider connection, then refresh models.",
        ),
        FailureCode::PersistenceFailed => (
            "The model catalog could not be saved.",
            "Check available disk space and permissions, then refresh models.",
        ),
        FailureCode::DiscoveryFailed => (
            "Model discovery failed.",
            "Check sign-in and the provider CLI, then refresh models.",
        ),
    }
}

/// `discoveryError`: a fixed category, message and hint for whatever a port threw.
pub fn discovery_error(
    failure: Option<&DiscoveryFailure>,
    fallback: FailureCode,
    context: &ErrorContext<'_>,
) -> DiscoveryError {
    let named_no_models = failure
        .and_then(|failure| failure.code.as_deref())
        .is_some_and(|code| code == "no_models");
    let kind = if fallback == FailureCode::NoModels || named_no_models {
        FailureCode::NoModels
    } else if failure.is_some_and(|failure| failure.too_old.is_some()) {
        // A `CliTooOldError` names itself by shape as well as by `code`.
        FailureCode::CliTooOld
    } else {
        discovery_failure_code(failure, fallback)
    };
    if kind == FailureCode::CliTooOld
        && let Some(known) = failure.and_then(|failure| failure.known.as_ref())
        && known.code == FailureCode::CliTooOld
        && known.message != messages(FailureCode::CliTooOld).0
    {
        return known.clone();
    }
    if kind == FailureCode::CliTooOld
        && let Some(too_old) = failure.and_then(|failure| failure.too_old.as_ref())
    {
        return DiscoveryError {
            code: kind,
            message: cli_too_old_message(&too_old.name, &too_old.installed, &too_old.required),
            hint: format!("Update {}, then refresh models.", too_old.name),
            action_id: None,
            severity: None,
        };
    }
    let (message, hint) = messages(kind);
    let hint = if context.backend == Some("cursor-sdk")
        && matches!(kind, FailureCode::NotConfigured | FailureCode::AuthExpired)
    {
        if kind == FailureCode::NotConfigured {
            "Sign in to Cursor".to_owned()
        } else {
            "Sign in to Cursor, then refresh models.".to_owned()
        }
    } else if context.provider == Some("opencode") && kind == FailureCode::AuthExpired {
        if context.source == Some("github-copilot") {
            "Reconnect GitHub Copilot in OpenCode (`opencode auth login`), then refresh models."
                .to_owned()
        } else {
            "Reconnect the provider in OpenCode (`opencode auth login`), then refresh models."
                .to_owned()
        }
    } else {
        hint.to_owned()
    };
    DiscoveryError {
        code: kind,
        message: if kind == FailureCode::NoModels && context.source == Some("github-copilot") {
            "GitHub Copilot is connected in OpenCode but has no chat models enabled.".to_owned()
        } else {
            message.to_owned()
        },
        hint,
        action_id: (kind == FailureCode::NotConfigured).then(|| "provider.sign_in".to_owned()),
        severity: matches!(kind, FailureCode::NotInstalled | FailureCode::NotConfigured)
            .then_some(Severity::Info),
    }
}

#[cfg(test)]
mod tests {
    //! Ports `packages/models/src/discovery-errors.test.ts`: "safe provider error shapes
    //! produce an actionable category", "nested auth failures survive generic wrappers and
    //! unrelated null fields", and "unknown discovery failures expose only a fixed message
    //! and corrective hint". Also ports `catalog.process.test.ts`'s "unclassified
    //! diagnostics stay in bounded local logs while client and stored errors stay fixed".

    use super::*;

    fn cursor() -> ErrorContext<'static> {
        ErrorContext {
            provider: Some("cursor"),
            source: None,
            backend: Some("cursor-sdk"),
        }
    }

    #[test]
    fn safe_provider_error_shapes_produce_an_actionable_category() {
        let nested_auth = DiscoveryFailure {
            name: Some("ClientError".into()),
            reason: Some("UnexpectedStatus".into()),
            cause: Some(Box::new(DiscoveryFailure {
                status: Some(401.0),
                body: Some(Box::new(DiscoveryFailure::new("secret"))),
                ..DiscoveryFailure::default()
            })),
            ..DiscoveryFailure::default()
        };
        let json_in_message = DiscoveryFailure::new(
            r#"{"code":-32603,"data":{"code":"not_configured","message":"API key missing"}}"#,
        );
        let cases = [
            (
                DiscoveryFailure {
                    name: Some("AuthenticationError".into()),
                    message: Some("private token".into()),
                    ..DiscoveryFailure::default()
                },
                FailureCode::AuthExpired,
            ),
            (
                DiscoveryFailure::with_code(FailureCode::NotConfigured),
                FailureCode::NotConfigured,
            ),
            (
                DiscoveryFailure::with_status(403.0),
                FailureCode::AuthExpired,
            ),
            (
                DiscoveryFailure {
                    name: Some("NetworkError".into()),
                    ..DiscoveryFailure::default()
                },
                FailureCode::Unreachable,
            ),
            (
                DiscoveryFailure {
                    code: Some("ECONNREFUSED".into()),
                    ..DiscoveryFailure::default()
                },
                FailureCode::Unreachable,
            ),
            (
                DiscoveryFailure::with_status(503.0),
                FailureCode::Unreachable,
            ),
            (
                DiscoveryFailure::with_status(429.0),
                FailureCode::RateLimited,
            ),
            (
                DiscoveryFailure::with_status(401.0),
                FailureCode::AuthExpired,
            ),
            (nested_auth, FailureCode::AuthExpired),
            (json_in_message, FailureCode::NotConfigured),
            (
                DiscoveryFailure {
                    data: Some(Box::new(DiscoveryFailure {
                        message: Some("Unauthorized secret".into()),
                        ..DiscoveryFailure::default()
                    })),
                    ..DiscoveryFailure::default()
                },
                FailureCode::AuthExpired,
            ),
        ];
        for (failure, expected) in cases {
            let detail = discovery_error(Some(&failure), FailureCode::DiscoveryFailed, &cursor());
            assert_eq!(detail.code, expected);
            let published = serde_json::to_string(&detail).unwrap_or_default();
            assert!(!published.contains("private"));
            assert!(!published.contains("secret"));
            assert!(!published.contains("token"));
            if matches!(
                expected,
                FailureCode::AuthExpired | FailureCode::NotConfigured
            ) {
                assert!(detail.hint.contains("Sign in to Cursor"));
            }
            if expected == FailureCode::NotConfigured {
                assert_eq!(detail.hint, "Sign in to Cursor");
                assert_eq!(detail.severity, Some(Severity::Info));
                assert_eq!(detail.action_id.as_deref(), Some("provider.sign_in"));
            }
        }
    }

    #[test]
    fn nested_auth_failures_survive_generic_wrappers_and_unrelated_null_fields() {
        let cases = [
            DiscoveryFailure {
                code: Some("discovery_failed".into()),
                cause: Some(Box::new(DiscoveryFailure {
                    response: Some(Box::new(DiscoveryFailure::with_status(401.0))),
                    ..DiscoveryFailure::default()
                })),
                ..DiscoveryFailure::default()
            },
            DiscoveryFailure {
                cause: Some(Box::new(DiscoveryFailure {
                    status: Some(403.0),
                    ..DiscoveryFailure::default()
                })),
                ..DiscoveryFailure::default()
            },
            DiscoveryFailure {
                tag: Some("APIError".into()),
                data: Some(Box::new(DiscoveryFailure::with_status(401.0))),
                ..DiscoveryFailure::default()
            },
            DiscoveryFailure {
                error: Some(Box::new(DiscoveryFailure {
                    code: Some("discovery_failed".into()),
                    response: Some(Box::new(DiscoveryFailure::with_status(401.0))),
                    ..DiscoveryFailure::default()
                })),
                ..DiscoveryFailure::default()
            },
        ];
        for failure in cases {
            assert_eq!(
                discovery_error(
                    Some(&failure),
                    FailureCode::DiscoveryFailed,
                    &ErrorContext::default()
                )
                .code,
                FailureCode::AuthExpired
            );
        }
    }

    #[test]
    fn unknown_failures_expose_only_a_fixed_message_and_corrective_hint() {
        let failure = DiscoveryFailure::new(
            "Metadata bootstrap failed: Bearer private-bearer; configured key private-env-key",
        );
        let detail = discovery_error(Some(&failure), FailureCode::DiscoveryFailed, &cursor());
        assert_eq!(detail.code, FailureCode::DiscoveryFailed);
        assert_eq!(detail.message, "Model discovery failed.");
        assert!(detail.hint.contains("Check sign-in"));
        let published = serde_json::to_string(&detail).unwrap_or_default();
        assert!(!published.contains("Metadata bootstrap failed"));
    }

    #[test]
    fn a_too_old_before_the_catalog_starts_keeps_both_versions() {
        let failure = DiscoveryFailure {
            too_old: Some(crate::cli::CliTooOld {
                cli: "opencode".into(),
                name: "OpenCode".into(),
                installed: "2.0.21".into(),
                required: "2.0.22".into(),
            }),
            ..DiscoveryFailure::default()
        };
        let detail = discovery_error(Some(&failure), FailureCode::DiscoveryFailed, &cursor());
        assert_eq!(detail.code, FailureCode::CliTooOld);
        assert_eq!(
            detail.message,
            "OpenCode 2.0.21 is older than 2.0.22, the oldest version ace supports."
        );
        assert_eq!(detail.hint, "Update OpenCode, then refresh models.");
    }

    #[test]
    fn opencode_auth_failures_name_the_provider_to_reconnect() {
        let detail = discovery_error(
            Some(&DiscoveryFailure::with_status(401.0)),
            FailureCode::DiscoveryFailed,
            &ErrorContext {
                provider: Some("opencode"),
                source: Some("github-copilot"),
                backend: None,
            },
        );
        assert!(
            detail
                .hint
                .contains("Reconnect GitHub Copilot in OpenCode (`opencode auth login`)")
        );
    }
}
