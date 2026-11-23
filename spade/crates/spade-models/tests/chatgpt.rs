//! Calls on a ChatGPT sign-in account (ADR 0214), against a local fake Responses server: the
//! account's token and id go with every call, the backend is only ever asked to stream, and a
//! signed-out account fails with one plain line before anything is sent.

use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::Deserialize;
use spade_models::{
    Bearers, Catalog, Credential, Effort, Endpoint, Format, Keys, Model, ModelError, Models,
    Prompt, SignIn,
};
use spade_testkit::{FakeProvider, Script, Seen};

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

/// A client whose only account is at `root`, with `token` as its access token (none: signed out),
/// whose tokens may go to `backend`. A refused token is replaced by `<token>-new`. Records which
/// accounts asked for a token, and the tokens reported refused.
struct Client {
    models: Models,
    asked: Arc<Mutex<Vec<String>>>,
    rejected: Arc<Mutex<Vec<String>>>,
    /// How many sends may still go before the account's credential changes (signed out, say);
    /// unlimited unless a test sets it.
    sends_left: Arc<std::sync::atomic::AtomicI64>,
}

fn client_for(root: &str, backend: &str, token: Option<&'static str>) -> Result<Client> {
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![account(root)]);
    let asked = Arc::new(Mutex::new(Vec::new()));
    let rejected = Arc::new(Mutex::new(Vec::new()));
    let current = Arc::new(Mutex::new(token.map(str::to_owned)));
    let (log, now) = (asked.clone(), current.clone());
    let (refused, renewed) = (rejected.clone(), current);
    let sends_left = Arc::new(std::sync::atomic::AtomicI64::new(i64::MAX));
    let left = sends_left.clone();
    models.set_bearers(Bearers::new(
        backend,
        move |id| {
            log.lock().unwrap_or_else(|p| p.into_inner()).push(id);
            let token = now.lock().unwrap_or_else(|p| p.into_inner()).clone();
            Box::pin(async move {
                token
                    .map(|token| Credential {
                        token,
                        generation: 1,
                    })
                    .ok_or_else(|| {
                        "This ChatGPT account is signed out. Sign in again in Settings › Spade › Models."
                            .to_owned()
                    })
            })
        },
        move |_id, old: Credential| {
            refused
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(old.token.clone());
            let next = format!("{}-new", old.token);
            *renewed.lock().unwrap_or_else(|p| p.into_inner()) = Some(next.clone());
            Box::pin(async move {
                Ok(Credential {
                    token: next,
                    generation: old.generation,
                })
            })
        },
        move |_id, _generation| {
            left.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) > 0
        },
    ));
    Ok(Client {
        models,
        asked,
        rejected,
        sends_left,
    })
}

fn models(
    fake: &FakeProvider,
    token: Option<&'static str>,
) -> Result<(Models, Arc<Mutex<Vec<String>>>)> {
    let client = client_for(&fake.root, &fake.root, token)?;
    Ok((client.models, client.asked))
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

#[tokio::test]
async fn a_sign_in_is_never_sent_to_an_address_other_than_the_backend() -> Result {
    let fake = FakeProvider::start("never").await?;
    let client = client_for(
        &fake.root,
        "https://chatgpt.example/backend/",
        Some("access-1"),
    )?;
    let error = client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert!(matches!(error, ModelError::SignIn { .. }), "{error:?}");
    let listed = client.models.list("chatgpt").await;
    assert!(listed.is_err());
    assert!(fake.seen().is_empty(), "nothing reached the other address");
    assert!(
        client
            .asked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty(),
        "no token was even looked up"
    );
    Ok(())
}

#[tokio::test]
async fn a_refused_token_gets_one_new_token_and_the_call_is_sent_once_more() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(401), Script::reply("ok")]).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let reply = client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await?;
    assert_eq!(reply.text, "ok");
    let seen = fake.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(
        header(&seen[1], "authorization").as_deref(),
        Some("Bearer access-1-new")
    );
    assert_eq!(
        *client.rejected.lock().unwrap_or_else(|p| p.into_inner()),
        vec!["access-1".to_owned()]
    );
    Ok(())
}

#[tokio::test]
async fn a_second_refusal_ends_the_call_without_a_third_try() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(401), Script::failing(401)]).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let mut stream = match client
        .models
        .stream("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await
    {
        Ok(stream) => Box::pin(stream),
        Err(error) => {
            assert_eq!(error.status(), Some(401));
            assert_eq!(fake.seen().len(), 2);
            return Ok(());
        }
    };
    let first = stream.next().await;
    assert!(
        matches!(first, Some(Err(ref e)) if e.status() == Some(401)),
        "{first:?}"
    );
    assert_eq!(fake.seen().len(), 2);
    assert_eq!(
        client
            .rejected
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len(),
        1
    );
    Ok(())
}

/// Refuses every call with a body that repeats the request's own `Authorization` header.
async fn echoing() -> Result<String> {
    use axum::http::{HeaderMap, StatusCode};
    let app = axum::Router::new().route(
        "/{*path}",
        axum::routing::post(|headers: HeaderMap| async move {
            let sent = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            (
                StatusCode::BAD_REQUEST,
                format!(r#"{{"error":{{"message":"bad token {sent}","code":"{sent}"}}}}"#),
            )
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(root)
}

#[tokio::test]
async fn a_backend_error_that_echoes_the_token_never_carries_it_into_spades_error() -> Result {
    let root = echoing().await?;
    let client = client_for(&root, &root, Some("secret-access-token-77"))?;
    for result in [
        client
            .models
            .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
            .await
            .err(),
        client
            .models
            .stream("chatgpt/gpt-5.5", &Prompt::ask("hi"))
            .await
            .err(),
    ] {
        let error = result.ok_or("the call should fail")?;
        let shown = format!("{error} {error:?}");
        assert!(!shown.contains("secret-access-token-77"), "{shown}");
        assert_eq!(error.status(), Some(400));
        assert!(
            shown.contains("the ChatGPT backend refused the call (400)"),
            "{shown}"
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_roles_effort_reaches_the_chatgpt_backend_without_an_output_limit() -> Result {
    let fake = FakeProvider::start("ok").await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    for effort in [Effort::High, Effort::Max, Effort::Off] {
        client
            .models
            .chat(
                "chatgpt/gpt-5.5",
                &Prompt::ask("hi").max_tokens(500).effort(effort),
            )
            .await?;
    }
    client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await?;
    let seen = fake.seen();
    let sent: Vec<&serde_json::Value> = seen
        .iter()
        .map(|s| &s.body["reasoning"]["effort"])
        .collect();
    assert_eq!(
        sent,
        vec![
            &serde_json::json!("high"),
            &serde_json::json!("xhigh"),
            &serde_json::json!("none"),
            &serde_json::Value::Null,
        ],
        "the provider's own default sends nothing"
    );
    for request in &seen {
        assert!(request.body.get("max_output_tokens").is_none());
        assert_eq!(
            header(request, "authorization").as_deref(),
            Some("Bearer access-1")
        );
    }
    Ok(())
}

#[tokio::test]
async fn a_backend_that_refuses_the_effort_is_asked_again_without_it_on_the_same_account() -> Result
{
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::reply("ok")]).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let reply = client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi").effort(Effort::High))
        .await?;
    assert_eq!(reply.text, "ok");
    let seen = fake.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].body["reasoning"]["effort"], "high");
    assert!(
        seen[1].body["reasoning"].get("effort").is_none(),
        "{}",
        seen[1].body
    );
    for request in &seen {
        assert_eq!(
            header(request, "authorization").as_deref(),
            Some("Bearer access-1")
        );
        assert_eq!(
            header(request, "chatgpt-account-id").as_deref(),
            Some("acct-1")
        );
    }
    assert!(
        client
            .rejected
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_empty()
    );
    Ok(())
}

#[tokio::test]
async fn a_call_whose_account_was_signed_out_after_its_first_send_sends_nothing_more() -> Result {
    // The first send is refused for its effort; the account is signed out before the second.
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(400), Script::reply("ok")]).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    client
        .sends_left
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let error = client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi").effort(Effort::High))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert!(matches!(error, ModelError::SignIn { .. }), "{error:?}");
    assert_eq!(
        fake.seen().len(),
        1,
        "the fallback was never sent with the old token"
    );
    Ok(())
}

#[tokio::test]
async fn a_401_after_a_refused_effort_is_the_answer_not_the_earlier_refusal() -> Result {
    let fake = FakeProvider::start_sequence(vec![
        Script::failing(400),
        Script::failing(401),
        Script::failing(401),
    ])
    .await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let error = client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi").effort(Effort::High))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert_eq!(error.status(), Some(401), "{error:?}");
    assert_eq!(
        fake.seen().len(),
        3,
        "the refusal, the 401, and one try with the new token"
    );
    assert_eq!(
        client
            .rejected
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .len(),
        1
    );
    Ok(())
}

#[tokio::test]
async fn after_a_401_and_a_refused_effort_no_request_is_sent_twice_the_same() -> Result {
    let fake = FakeProvider::start_sequence(vec![
        Script::failing(401),
        Script::failing(400),
        Script::reply("ok"),
    ])
    .await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let reply = client
        .models
        .chat(
            "chatgpt/gpt-5.5",
            &Prompt::ask("hi").max_tokens(500).effort(Effort::High),
        )
        .await?;
    assert_eq!(reply.text, "ok");
    let seen = fake.seen();
    assert_eq!(seen.len(), 3);
    // The 401's request again with the new token, then without the effort: never a repeat.
    assert_eq!(
        header(&seen[1], "authorization").as_deref(),
        Some("Bearer access-1-new")
    );
    assert_eq!(seen[1].body["reasoning"]["effort"], "high");
    assert!(
        seen[2].body["reasoning"].get("effort").is_none(),
        "{}",
        seen[2].body
    );
    Ok(())
}

/// A model list that refuses the first token with a `401` whose body is prose naming the token,
/// and lists for any other; or refuses every token when `always`.
async fn listing(always: bool) -> Result<String> {
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    let app = axum::Router::new().route(
        "/models",
        axum::routing::get(move |headers: HeaderMap| async move {
            let sent = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            if always || sent == "Bearer access-1" {
                return (
                    StatusCode::UNAUTHORIZED,
                    format!(r#"{{"error":{{"message":"Workspace Acme rejected {sent}"}}}}"#),
                )
                    .into_response();
            }
            axum::Json(serde_json::json!({ "models": [ { "slug": "gpt-5.5" } ] })).into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(root)
}

#[tokio::test]
async fn a_model_list_refused_with_a_401_gets_one_new_token_and_lists() -> Result {
    let root = listing(false).await?;
    let client = client_for(&root, &root, Some("access-1"))?;
    let listed = client.models.list("chatgpt").await?;
    assert_eq!(
        listed.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["gpt-5.5"]
    );
    assert_eq!(
        *client.rejected.lock().unwrap_or_else(|p| p.into_inner()),
        vec!["access-1".to_owned()]
    );
    Ok(())
}

#[tokio::test]
async fn a_signed_in_accounts_list_failure_says_only_fixed_words() -> Result {
    let root = listing(true).await?;
    let client = client_for(&root, &root, Some("access-1"))?;
    let error = client
        .models
        .list("chatgpt")
        .await
        .err()
        .ok_or("it should fail")?;
    let shown = format!("{error} {error:?}");
    assert!(
        !shown.contains("Acme") && !shown.contains("access-1"),
        "{shown}"
    );
    assert!(
        shown.contains("the ChatGPT backend refused the model list (401)"),
        "{shown}"
    );
    Ok(())
}
