//! What a ChatGPT sign-in's tokens say about the account: read from the JSON Web Tokens' payload.
//! The tokens came straight from OpenAI's token endpoint over TLS, so their signature is not
//! checked here; nothing in them is trusted beyond naming the account and when it ends.

use base64::Engine;
use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
use serde_json::Value;

/// The claim OpenAI keeps its account facts under.
const AUTH_CLAIM: &str = "https://api.openai.com/auth";
/// The claim it may keep the profile (the email) under.
const PROFILE_CLAIM: &str = "https://api.openai.com/profile";

/// The account a sign-in is for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    /// ChatGPT's id for the account (workspace), sent with every call.
    pub account_id: String,
    pub email: Option<String>,
    /// `free`, `plus`, `pro`, `team`, … as the token says.
    pub plan: Option<String>,
}

/// The payload of a JSON Web Token, if it is one.
pub fn payload(token: &str) -> Option<Value> {
    let middle = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD
        .decode(middle.trim_end_matches('='))
        .or_else(|_| URL_SAFE.decode(middle))
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// When the token ends, in Unix seconds, if it says.
pub fn expires(token: &str) -> Option<i64> {
    payload(token)?.get("exp")?.as_i64()
}

/// The account named by the sign-in's ID token, else its access token. `None` when neither names
/// a ChatGPT account.
pub fn account(id_token: Option<&str>, access_token: &str) -> Option<Account> {
    let tokens: Vec<Value> = id_token
        .into_iter()
        .chain(std::iter::once(access_token))
        .filter_map(payload)
        .collect();
    let find = |read: &dyn Fn(&Value) -> Option<String>| tokens.iter().find_map(read);
    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let account_id = find(&|t| text(t.get(AUTH_CLAIM)?.get("chatgpt_account_id")))?;
    Some(Account {
        account_id,
        email: find(&|t| text(t.get("email")).or_else(|| text(t.get(PROFILE_CLAIM)?.get("email")))),
        plan: find(&|t| text(t.get(AUTH_CLAIM)?.get("chatgpt_plan_type"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A token whose payload is `claims`, unsigned: for tests and the fake sign-in server.
    fn unsigned(claims: &Value) -> String {
        let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
        format!(
            "{}.{}.unsigned",
            encode(&serde_json::json!({"alg": "none"})),
            encode(claims)
        )
    }

    #[test]
    fn the_id_token_names_the_account_its_email_and_plan() {
        let id = unsigned(&json!({
            "email": "sam@example.com",
            AUTH_CLAIM: { "chatgpt_account_id": "acct-9", "chatgpt_plan_type": "plus" }
        }));
        let access = unsigned(&json!({ "exp": 1_900_000_000 }));
        assert_eq!(
            account(Some(&id), &access),
            Some(Account {
                account_id: "acct-9".to_owned(),
                email: Some("sam@example.com".to_owned()),
                plan: Some("plus".to_owned()),
            })
        );
        assert_eq!(expires(&access), Some(1_900_000_000));
    }

    #[test]
    fn the_access_token_fills_what_the_id_token_leaves_out() {
        let access = unsigned(&json!({
            AUTH_CLAIM: { "chatgpt_account_id": "acct-2" },
            PROFILE_CLAIM: { "email": "kim@example.com" }
        }));
        let found = account(None, &access);
        assert_eq!(
            found.as_ref().map(|a| a.account_id.as_str()),
            Some("acct-2")
        );
        assert_eq!(
            found.and_then(|a| a.email).as_deref(),
            Some("kim@example.com")
        );
    }

    #[test]
    fn a_token_naming_no_account_or_no_token_at_all_reads_as_none() {
        assert_eq!(account(None, &unsigned(&json!({"email": "x@y"}))), None);
        assert_eq!(account(None, "not-a-jwt"), None);
        assert_eq!(expires("a.%%%.b"), None);
    }
}
