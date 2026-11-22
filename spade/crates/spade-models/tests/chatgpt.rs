//! Calls on a ChatGPT sign-in account (ADR 0214), against a local fake Responses server: the
//! account's token and id go with every call, the backend is only ever asked to stream, and a
//! signed-out account fails with one plain line before anything is sent.

use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::Deserialize;
use spade_models::{
    Bearers, Catalog, Endpoint, Format, Keys, Model, ModelError, Models, Prompt, SignIn,
};
use spade_testkit::{FakeProvider, Seen};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn account(root: &str) -> Endpoint {
    Endpoint {
        id: "chatgpt".to_owned(),
        name: "ChatGPT".to_owned(),
        format: Format::OpenAiResponses,
        base_url: root.to_owned(),
        needs_key: false,
        key_env: None,
        headers: Vec::new(),
        session_header: None,
        sign_in: Some(SignIn::ChatGpt {
            account_id: "acct-1".to_owned(),
        }),
        models: vec![Model::unknown("gpt-5.5")],
    }
}

/// A client whose only account is the fake's, with `token` as its access token (none: signed
/// out). Records which accounts asked for a token.
fn models(
    fake: &FakeProvider,
    token: Option<&'static str>,
) -> Result<(Models, Arc<Mutex<Vec<String>>>)> {
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![account(&fake.root)]);
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    models.set_bearers(Bearers::new(move |id| {
        log.lock().unwrap_or_else(|p| p.into_inner()).push(id);
        Box::pin(async move {
            token.map(str::to_owned).ok_or_else(|| {
                "This ChatGPT account is signed out. Sign in again in Settings › Spade › Models."
                    .to_owned()
            })
        })
    }));
    Ok((models, asked))
}

fn header(seen: &Seen, name: &str) -> Option<String> {
    seen.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.clone())
}

#[derive(Debug, Deserialize, JsonSchema)]
struct Verdict {
    relevant: bool,
}

#[tokio::test]
async fn a_call_carries_the_accounts_token_and_id_and_is_always_streamed() -> Result {
    let fake = FakeProvider::start(r#"{"relevant":true}"#).await?;
    let (models, asked) = models(&fake, Some("access-1"))?;
    let reply = models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi").session("conv-1"))
        .await?;
    assert_eq!(reply.text, r#"{"relevant":true}"#);
    let verdict = models
        .generate::<Verdict>("chatgpt/gpt-5.5", &Prompt::ask("relevant?"))
        .await?;
    assert!(verdict.value.relevant);

    let seen = fake.seen();
    assert_eq!(seen.len(), 2);
    for request in &seen {
        assert!(request.path.ends_with("/responses"), "{}", request.path);
        assert_eq!(
            header(request, "authorization").as_deref(),
            Some("Bearer access-1")
        );
        assert_eq!(
            header(request, "chatgpt-account-id").as_deref(),
            Some("acct-1")
        );
        assert_eq!(header(request, "originator").as_deref(), Some("spade"));
        assert_eq!(request.body["stream"], true, "the backend only streams");
        assert_eq!(request.body["store"], false);
        assert!(
            request.body["instructions"].is_string(),
            "instructions always go"
        );
        assert!(request.body.get("max_output_tokens").is_none());
    }
    assert_eq!(header(&seen[0], "session_id").as_deref(), Some("conv-1"));
    assert_eq!(
        *asked.lock().unwrap_or_else(|p| p.into_inner()),
        vec!["chatgpt".to_owned(), "chatgpt".to_owned()]
    );
    Ok(())
}

#[tokio::test]
async fn a_signed_out_account_fails_with_one_line_and_sends_nothing() -> Result {
    let fake = FakeProvider::start("never").await?;
    let (models, _) = models(&fake, None)?;
    let error = models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert!(matches!(error, ModelError::SignIn { .. }), "{error:?}");
    assert_eq!(
        error.to_string(),
        "This ChatGPT account is signed out. Sign in again in Settings › Spade › Models."
    );
    assert!(!error.may_have_billed());
    assert!(fake.seen().is_empty());
    Ok(())
}
