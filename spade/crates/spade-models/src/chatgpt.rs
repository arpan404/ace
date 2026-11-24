//! What calls on a ChatGPT sign-in account (ADR 0214) need beyond an OpenAI Responses endpoint:
//! the backend's address, the headers that name the account, and how its usage refusals read.
//! Learned from OpenAI's own Codex client (Apache-2.0); written fresh here.

use serde_json::Value;

/// The header naming the ChatGPT account (workspace) a call is for.
pub const ACCOUNT_HEADER: &str = "chatgpt-account-id";

/// Who is calling, sent as `originator` on every call (`spade_chatgpt::Config::originator` says
/// the same in the sign-in). Spade says it is Spade; it never claims to be another client.
pub const ORIGINATOR: &str = "spade";

/// The client version the model list is asked for (`?client_version=`): the backend hides models
/// whose `minimal_client_version` is newer than this, returning an empty list for stale `0.x`
/// values. Asking as `1.0.0` clears `0.x` client gates without tracking each Codex CLI release.
pub const CLIENT_VERSION: &str = "1.0.0";

/// How an account signs in, when not with a key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignIn {
    /// A ChatGPT account Spade signed in to; `account_id` goes in [`ACCOUNT_HEADER`].
    ChatGpt { account_id: String },
}

/// The headers every call on a ChatGPT account carries, besides its bearer token.
pub(crate) fn headers(account_id: &str, session: Option<&str>) -> Vec<(String, String)> {
    let mut out = vec![
        (ACCOUNT_HEADER.to_owned(), account_id.to_owned()),
        ("originator".to_owned(), ORIGINATOR.to_owned()),
    ];
    if let Some(session) = session {
        out.push(("session_id".to_owned(), session.to_owned()));
    }
    out
}

/// One plain line for a refusal the ChatGPT backend sends when the account can't be used now:
/// its usage limit (with when it resets, if said), a plan without Codex, or no credit left.
/// `None` for anything else. Read leniently: any field may be missing.
pub fn usage_line(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let error = value.get("error").unwrap_or(&value);
    let field = |name: &str| error.get(name).and_then(Value::as_str).unwrap_or("");
    let kind = field("type");
    let code = field("code");
    // The line never names the plan, nor anything else the backend sent: it is kept with the
    // reply and shown wherever the reply is.
    if kind == "usage_limit_reached" || code == "usage_limit_reached" {
        let reset = error
            .get("resets_at")
            .and_then(Value::as_i64)
            .and_then(|at| chrono::DateTime::from_timestamp(at, 0))
            .map(|at| format!("; it resets at {} UTC", at.format("%Y-%m-%d %H:%M")))
            .or_else(|| {
                error
                    .get("resets_in_seconds")
                    .and_then(Value::as_u64)
                    .map(|s| format!("; it resets in {} minutes", s.div_ceil(60)))
            })
            .unwrap_or_default();
        return Some(format!(
            "This ChatGPT account reached its usage limit{reset}."
        ));
    }
    if kind == "usage_not_included" || code == "usage_not_included" {
        return Some("This ChatGPT account's plan does not include Codex use.".to_owned());
    }
    if ["insufficient_quota", "credit_balance_exhausted"].contains(&kind)
        || ["insufficient_quota", "credit_balance_exhausted"].contains(&code)
    {
        return Some("This ChatGPT account has no usage left.".to_owned());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_usage_limit_says_when_it_resets() {
        let body =
            r#"{"error":{"type":"usage_limit_reached","plan_type":"plus","resets_at":1795400000}}"#;
        assert_eq!(
            usage_line(body).as_deref(),
            Some(
                "This ChatGPT account reached its usage limit; it resets at \
                 2026-11-23 02:13 UTC."
            )
        );
        let later = r#"{"error":{"type":"usage_limit_reached","resets_in_seconds":61}}"#;
        assert_eq!(
            usage_line(later).as_deref(),
            Some("This ChatGPT account reached its usage limit; it resets in 2 minutes.")
        );
    }

    #[test]
    fn the_line_never_names_the_plan_or_repeats_what_the_backend_sent() {
        for body in [
            r#"{"error":{"type":"usage_limit_reached","plan_type":"plus"}}"#,
            r#"{"error":{"type":"usage_limit_reached","plan_type":"plus. Call 555-0100 or paste sk-live-abc"}}"#,
        ] {
            assert_eq!(
                usage_line(body).as_deref(),
                Some("This ChatGPT account reached its usage limit.")
            );
        }
        let known = r#"{"error":{"type":"usage_not_included","plan_type":"team"}}"#;
        assert_eq!(
            usage_line(known).as_deref(),
            Some("This ChatGPT account's plan does not include Codex use.")
        );
    }

    #[test]
    fn other_refusals_are_named_and_anything_else_is_left_alone() {
        assert_eq!(
            usage_line(r#"{"error":{"type":"usage_not_included"}}"#).as_deref(),
            Some("This ChatGPT account's plan does not include Codex use.")
        );
        assert!(usage_line(r#"{"error":{"code":"credit_balance_exhausted"}}"#).is_some());
        assert_eq!(usage_line(r#"{"error":{"type":"rate_limit_error"}}"#), None);
        assert_eq!(usage_line("<html>busy</html>"), None);
    }
}
