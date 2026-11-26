// SPDX-License-Identifier: Apache-2.0
//! `CursorHost.request`'s catch (`host.ts:215`-`:241`) as one pure mapping: the "ended with
//! code ..." reason for a closed pipe, the rejected `refused` mark, the `detail` only for
//! `models`, and the host's last prose prefixed to `open`, `send` and `cancel`. The classifier
//! that reads host prose (`discoveryFailureCode`/`discoveryFailureReason`) stays TypeScript
//! (E3-cursor.3 point 3): its answer and this file's fallback cross as values.
//! A settlement the bridge already classified as `InputRejected` or `SteerTargetLost` never
//! reaches this mapping; the caller rethrows those first.

use super::commands::refused_by_host;

/// The category TypeScript uses when nothing more specific applies.
pub const DISCOVERY_FAILED: &str = "discovery_failed";
/// A spawn error or exit code 78: the provider was never configured.
pub const NOT_CONFIGURED: &str = "not_configured";

/// The process's exit, read only once its signal aborted (`host.ts:213`).
pub struct ExitState<'a> {
    pub code: Option<i64>,
    pub reason: &'a str,
}

/// What the catch knows when a command's settlement fails.
pub struct RequestFailure<'a> {
    pub method: &'a str,
    /// `discoveryFailureCode(error, failure_fallback(metadata_code, exit))`'s answer: the code
    /// the error, its status or the classifier's prose gave, else the fallback. The classifier
    /// reads host prose and stays TypeScript (E3-cursor.3 point 3), so its answer crosses whole.
    pub code: &'a str,
    /// `discoveryFailureReason`'s answer: the error's bounded, redacted detail. The closed-pipe
    /// check reads this, as `host.ts:223` reads `suppliedReason`.
    pub reason: &'a str,
    /// `CursorHost`'s last stderr prose (`this.errorMessage`).
    pub error_message: Option<&'a str>,
    /// The last detail the host's stderr named (`this.metadataFailureDetail`).
    pub metadata_detail: Option<&'a str>,
    pub exit: Option<ExitState<'a>>,
}

/// The failure the caller's promise rejects with.
pub struct MappedFailure {
    pub message: String,
    pub code: String,
    /// Only a `models` failure whose code is `discovery_failed` carries the reason.
    pub detail: Option<String>,
    pub refused: bool,
}

/// The fallback `discoveryFailureCode` takes as its second argument (`host.ts:216`-`:221`): the
/// metadata's code when the stderr named one, else `not_configured` when the host never started
/// or exited 78, else `discovery_failed`.
pub fn failure_fallback<'a>(
    metadata_code: Option<&'a str>,
    exit: Option<&ExitState<'a>>,
) -> &'a str {
    if let Some(code) = metadata_code {
        return code;
    }
    match exit {
        Some(exit) if exit.reason == "spawn-error" || exit.code == Some(78) => NOT_CONFIGURED,
        _ => DISCOVERY_FAILED,
    }
}

/// `request`'s catch, in its order: the closed pipe's reason, then the message's prose prefix
/// and its extra fields. The code is already the classifier's (see [`failure_fallback`]).
pub fn request_failure(failure: RequestFailure<'_>) -> MappedFailure {
    let exited = failure.exit.as_ref();
    let reason = if is_closed_pipe(failure.reason) {
        let code = exited
            .and_then(|exit| exit.code)
            .map_or_else(|| String::from("none"), |code| code.to_string());
        let exit_reason = exited.map_or("request rejected", |exit| exit.reason);
        let detail = failure.metadata_detail.unwrap_or(failure.reason);
        truncate_utf16(
            &format!("Cursor SDK host ended with code {code} ({exit_reason}). {detail}"),
            2048,
        )
    } else {
        String::from(failure.reason)
    };
    let prose = failure
        .error_message
        .filter(|message| {
            !message.is_empty() && matches!(failure.method, "open" | "send" | "cancel")
        })
        .map_or_else(String::new, |message| format!("{message} "));
    MappedFailure {
        message: format!(
            "{prose}Cursor SDK {} failed; delivery may be uncertain. Inspect history before resending.",
            failure.method
        ),
        detail: (failure.method == "models" && failure.code == DISCOVERY_FAILED)
            .then(|| reason.clone()),
        code: String::from(failure.code),
        refused: refused_by_host(failure.reason),
    }
}

/// `host.ts:225`'s closed-pipe reasons: the ones that mean the host ended under the failure.
fn is_closed_pipe(reason: &str) -> bool {
    matches!(
        reason.to_lowercase().as_str(),
        "process exited" | "process closed" | "json-rpc closed" | "closed" | "eof" | "write epipe"
    )
}

/// `.slice(0, max)` counts UTF-16 units (rule 17). A lone surrogate cannot exist in a `String`,
/// so a cut that would split an astral character stops before it instead.
fn truncate_utf16(text: &str, max: usize) -> String {
    let mut units = 0;
    let mut kept = String::with_capacity(text.len().min(max));
    for character in text.chars() {
        let width = character.len_utf16();
        if units + width > max {
            break;
        }
        units += width;
        kept.push(character);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::{ExitState, RequestFailure, failure_fallback, request_failure, truncate_utf16};

    /// The catch's inputs with only the fields a case names.
    fn failure<'a>(method: &'a str, reason: &'a str, code: &'a str) -> RequestFailure<'a> {
        RequestFailure {
            method,
            code,
            reason,
            error_message: None,
            metadata_detail: None,
            exit: None,
        }
    }

    fn exited<'a>(code: Option<i64>, reason: &'a str) -> ExitState<'a> {
        ExitState { code, reason }
    }

    #[test]
    fn a_refused_reply_keeps_the_refusal_mark_and_the_scripts_prose() {
        let mapped = request_failure(failure(
            "send",
            r#"{"code":-32603,"data":{"refused":true}}"#,
            "discovery_failed",
        ));
        assert_eq!(
            mapped.message,
            "Cursor SDK send failed; delivery may be uncertain. Inspect history before resending."
        );
        assert_eq!(mapped.code, "discovery_failed");
        assert!(mapped.refused);
    }

    #[test]
    fn the_hosts_last_prose_prefixes_open_send_and_cancel_only() {
        let prose = Some("rate limited");
        let mut open = failure("open", "x", "discovery_failed");
        open.error_message = prose;
        assert_eq!(
            request_failure(open).message,
            "rate limited Cursor SDK open failed; delivery may be uncertain. Inspect history before resending."
        );
        let mut configure = failure("configure", "x", "discovery_failed");
        configure.error_message = prose;
        assert_eq!(
            request_failure(configure).message,
            "Cursor SDK configure failed; delivery may be uncertain. Inspect history before resending."
        );
    }

    #[test]
    fn a_closed_pipe_names_the_exit_and_the_metadatas_last_detail() {
        let mut closed = failure("models", "EOF", "discovery_failed");
        closed.exit = Some(exited(Some(1), "exit"));
        closed.metadata_detail = Some("boom");
        let mapped = request_failure(closed);
        assert_eq!(mapped.code, "discovery_failed");
        assert_eq!(
            mapped.detail.as_deref(),
            Some("Cursor SDK host ended with code 1 (exit). boom")
        );
    }

    #[test]
    fn a_spawn_error_falls_back_to_not_configured_and_carries_no_detail() {
        let spawn = exited(None, "spawn-error");
        let code = failure_fallback(None, Some(&spawn));
        assert_eq!(code, "not_configured");
        let mapped = request_failure(failure("models", "EOF", code));
        assert_eq!(mapped.code, "not_configured");
        assert_eq!(mapped.detail, None);
    }

    #[test]
    fn exit_code_78_is_not_configured_and_no_exit_is_discovery_failed() {
        let refused_config = exited(Some(78), "exit");
        assert_eq!(
            failure_fallback(None, Some(&refused_config)),
            "not_configured"
        );
        assert_eq!(failure_fallback(None, None), "discovery_failed");
        assert_eq!(
            failure_fallback(None, Some(&exited(Some(1), "exit"))),
            "discovery_failed"
        );
    }

    #[test]
    fn a_real_eof_with_metadata_auth_expired_reports_the_hosts_death_as_auth_expired() {
        // `discoveryFailureCode(error, "auth_expired")` finds nothing in "EOF" and takes the
        // metadata's code; the detail is not a `discovery_failed` reason, so it is not attached.
        let death = exited(Some(1), "exit");
        let code = failure_fallback(Some("auth_expired"), Some(&death));
        assert_eq!(code, "auth_expired");
        let mapped = request_failure(RequestFailure {
            method: "open",
            code,
            reason: "EOF",
            error_message: None,
            metadata_detail: Some("boom"),
            exit: Some(exited(Some(1), "exit")),
        });
        assert_eq!(mapped.code, "auth_expired");
        assert_eq!(mapped.detail, None);
        assert_eq!(
            mapped.message,
            "Cursor SDK open failed; delivery may be uncertain. Inspect history before resending."
        );
    }

    #[test]
    fn a_closed_pipes_reason_is_cut_at_2048_utf16_units_without_splitting_an_emoji() {
        // 2,047 ASCII units plus an astral character: the cut lands inside the emoji, so it
        // stops before it rather than keeping half a pair.
        let text = format!("{}😀", "a".repeat(2047));
        let cut = truncate_utf16(&text, 2048);
        assert_eq!(cut.encode_utf16().count(), 2047);
        assert!(text.starts_with(&cut));
        assert!(cut.ends_with('a'));
    }
}
