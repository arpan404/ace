//! What a ChatGPT sign-in's tokens say about the account: read from the JSON Web Tokens' payload.
//! The ID token decides the account, once its issuer, audience and end are checked; the access
//! token only has to agree with it.

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

/// What a sign-in's ID token must say to be taken: who issued it, for which client, and now.
#[derive(Debug, Clone, Copy)]
pub struct Expect<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    /// Unix seconds.
    pub now: i64,
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn account_id(token: &Value) -> Option<String> {
    text(token.get(AUTH_CLAIM)?.get("chatgpt_account_id"))
}

/// Whether the ID token was issued by `expect.issuer` for `expect.client_id` and hasn't ended.
/// The tokens come straight from the issuer's token endpoint over TLS, which stands in for its
/// signature (OpenID Connect Core 3.1.3.7); these checks catch a token meant for someone else.
fn issued_for(token: &Value, expect: Expect<'_>) -> Result<(), String> {
    if token.get("iss").and_then(Value::as_str) != Some(expect.issuer) {
        return Err("the sign-in's ID token is from another issuer".to_owned());
    }
    // OpenID Connect Core 3.1.3.7: this client must be an audience; with others beside it, the
    // token must name this client as the one it was issued to (`azp`), and any `azp` must be it.
    let ours = |v: &Value| v.as_str() == Some(expect.client_id);
    let audience = match token.get("aud") {
        Some(Value::String(one)) => one == expect.client_id,
        Some(Value::Array(all)) if all.len() == 1 => all.iter().all(ours),
        Some(Value::Array(all)) => all.iter().any(ours) && token.get("azp").is_some_and(ours),
        _ => false,
    };
    let party = token.get("azp").is_none_or(ours);
    if !audience || !party {
        return Err("the sign-in's ID token is for another app".to_owned());
    }
    match token.get("exp").and_then(Value::as_i64) {
        Some(exp) if exp > expect.now => Ok(()),
        _ => Err("the sign-in's ID token has ended".to_owned()),
    }
}

/// The account a sign-in is for, from its checked ID token, with the access token naming the same
/// account (or none). Refused, in one line, when the ID token is not this client's from this
/// issuer, has ended, or the two tokens name different accounts.
pub fn account(
    id_token: Option<&str>,
    access_token: &str,
    expect: Expect<'_>,
) -> Result<Account, String> {
    let id = id_token
        .and_then(payload)
        .ok_or("the sign-in sent no ID token")?;
    issued_for(&id, expect)?;
    let access = payload(access_token);
    let named = account_id(&id).ok_or("this sign-in names no ChatGPT account")?;
    if access
        .as_ref()
        .and_then(account_id)
        .is_some_and(|other| other != named)
    {
        return Err("the sign-in's tokens name different ChatGPT accounts".to_owned());
    }
    Ok(Account {
        account_id: named,
        email: text(id.get("email"))
            .or_else(|| text(id.get(PROFILE_CLAIM).and_then(|p| p.get("email")))),
        plan: text(id.get(AUTH_CLAIM).and_then(|a| a.get("chatgpt_plan_type"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn unsigned(claims: &Value) -> String {
        let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
        format!(
            "{}.{}.unsigned",
            encode(&json!({"alg": "none"})),
            encode(claims)
        )
    }

    const EXPECT: Expect<'static> = Expect {
        issuer: "https://auth.example",
        client_id: "client-1",
        now: 1_000,
    };

    fn id(changes: Value) -> String {
        let mut claims = json!({
            "iss": "https://auth.example", "aud": "client-1", "exp": 2_000,
            "email": "sam@example.com",
            AUTH_CLAIM: { "chatgpt_account_id": "acct-9", "chatgpt_plan_type": "plus" }
        });
        if let (Some(base), Some(more)) = (claims.as_object_mut(), changes.as_object()) {
            for (key, value) in more {
                base.insert(key.clone(), value.clone());
            }
        }
        unsigned(&claims)
    }

    #[test]
    fn a_checked_id_token_names_the_account_its_email_and_plan() {
        let access = unsigned(&json!({ "exp": 1_900_000_000 }));
        assert_eq!(
            account(Some(&id(json!({}))), &access, EXPECT),
            Ok(Account {
                account_id: "acct-9".to_owned(),
                email: Some("sam@example.com".to_owned()),
                plan: Some("plus".to_owned()),
            })
        );
        assert_eq!(expires(&access), Some(1_900_000_000));
        let listed = id(json!({ "aud": ["client-1"] }));
        assert!(account(Some(&listed), &access, EXPECT).is_ok());
        let named = id(json!({ "aud": ["other", "client-1"], "azp": "client-1" }));
        assert!(account(Some(&named), &access, EXPECT).is_ok());
    }

    #[test]
    fn an_id_token_from_another_issuer_for_another_app_or_ended_is_refused() {
        let access = unsigned(&json!({}));
        for bad in [
            json!({ "iss": "https://evil.example" }),
            json!({ "iss": null }),
            json!({ "aud": "someone-else" }),
            json!({ "aud": ["someone-else"] }),
            // Another audience beside this client, with no party named or another one named.
            json!({ "aud": ["other", "client-1"] }),
            json!({ "aud": ["other", "client-1"], "azp": "other" }),
            json!({ "azp": "other" }),
            json!({ "exp": 1_000 }),
            json!({ "exp": null }),
        ] {
            assert!(
                account(Some(&id(bad.clone())), &access, EXPECT).is_err(),
                "{bad}"
            );
        }
        assert!(account(None, &access, EXPECT).is_err(), "no ID token");
        assert!(account(Some("not-a-jwt"), &access, EXPECT).is_err());
    }

    #[test]
    fn tokens_naming_different_accounts_are_refused_and_an_access_token_alone_never_decides() {
        let other = unsigned(&json!({ AUTH_CLAIM: { "chatgpt_account_id": "acct-evil" } }));
        assert!(account(Some(&id(json!({}))), &other, EXPECT).is_err());
        let same = unsigned(&json!({ AUTH_CLAIM: { "chatgpt_account_id": "acct-9" } }));
        assert!(account(Some(&id(json!({}))), &same, EXPECT).is_ok());
        let unnamed = id(json!({ AUTH_CLAIM: {} }));
        assert!(account(Some(&unnamed), &same, EXPECT).is_err());
        assert_eq!(expires("a.%%%.b"), None);
    }
}
