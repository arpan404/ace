//! Calls on a ChatGPT sign-in account (ADR 0214), against a local fake Responses server: the
//! account's token and id go with every call, the backend is only ever asked to stream, and a
//! signed-out account fails with one plain line before anything is sent.

use std::sync::{Arc, Mutex};

use futures_util::StreamExt;
use schemars::JsonSchema;
use serde::Deserialize;
use spade_models::{
    Bearers, Catalog, Credential, DispatchGuard, Effort, Endpoint, Format, Keys, Model, ModelError,
    Models, Prompt, SignIn,
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
            let open = left.fetch_sub(1, std::sync::atomic::Ordering::SeqCst) > 0;
            Box::pin(async move {
                if open {
                    Ok(Box::new(()) as DispatchGuard)
                } else {
                    Err("signed out".to_owned())
                }
            })
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

#[tokio::test]
async fn a_refresh_that_gives_back_the_same_token_sends_nothing_more() -> Result {
    let fake =
        FakeProvider::start_sequence(vec![Script::failing(401), Script::reply("ok")]).await?;
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![account(&fake.root)]);
    let same = || Credential {
        token: "access-1".to_owned(),
        generation: 1,
    };
    models.set_bearers(Bearers::new(
        fake.root.clone(),
        move |_| Box::pin(async move { Ok(same()) }),
        move |_, old: Credential| Box::pin(async move { Ok(old) }),
        |_, _| Box::pin(async { Ok(Box::new(()) as DispatchGuard) }),
    ));
    let error = models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await
        .err()
        .ok_or("the call should fail")?;
    assert_eq!(error.status(), Some(401));
    assert_eq!(
        fake.seen().len(),
        1,
        "the same request was never sent again"
    );
    Ok(())
}

/// A model list that refuses the first token with a `401` far larger than Spade reads, and lists
/// for any other.
async fn oversized_refusal() -> Result<String> {
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    let app = axum::Router::new().route(
        "/models",
        axum::routing::get(|headers: HeaderMap| async move {
            if headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer access-1")
            {
                return (StatusCode::UNAUTHORIZED, "x".repeat(64 * 1024)).into_response();
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
async fn a_401_model_list_too_large_to_read_is_still_a_401_and_refreshes() -> Result {
    let root = oversized_refusal().await?;
    let mut client = client_for(&root, &root, Some("access-1"))?;
    client.models = client.models.with_listing_bounds(spade_models::ListBounds {
        timeout: std::time::Duration::from_secs(5),
        max_bytes: 1024,
        max_models: 100,
    });
    let listed = client.models.list("chatgpt").await?;
    assert_eq!(listed.len(), 1);
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

/// A model list that names each model after the token it was asked with, and counts the asks;
/// with `refuse`, it refuses every ask with a `401`.
async fn naming_list(refuse: bool) -> Result<(String, Arc<std::sync::atomic::AtomicUsize>)> {
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let count = asked.clone();
    let app = axum::Router::new().route(
        "/models",
        axum::routing::get(move |headers: HeaderMap| {
            let count = count.clone();
            async move {
                count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if refuse {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                let sent = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                axum::Json(serde_json::json!({ "models": [
                    { "slug": "gpt-5.5", "display_name": format!("GPT for {sent}") },
                    { "slug": format!("leak-{sent}") }
                ] }))
                .into_response()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok((root, asked))
}

#[tokio::test]
async fn a_model_list_that_echoes_the_token_never_hands_it_on() -> Result {
    let (root, _) = naming_list(false).await?;
    let client = client_for(&root, &root, Some("access-1"))?;
    let listed = client.models.list("chatgpt").await?;
    let shown = format!("{listed:?}");
    assert!(!shown.contains("access-1"), "{shown}");
    assert_eq!(
        listed.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec!["gpt-5.5"]
    );
    Ok(())
}

#[tokio::test]
async fn a_list_refresh_that_gives_back_the_same_token_asks_nothing_more() -> Result {
    let (root, asked) = naming_list(true).await?;
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![account(&root)]);
    let same = || Credential {
        token: "access-1".to_owned(),
        generation: 1,
    };
    models.set_bearers(Bearers::new(
        root.clone(),
        move |_| Box::pin(async move { Ok(same()) }),
        move |_, old: Credential| Box::pin(async move { Ok(old) }),
        |_, _| Box::pin(async { Ok(Box::new(()) as DispatchGuard) }),
    ));
    assert!(models.list("chatgpt").await.is_err());
    assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 1);
    Ok(())
}

#[tokio::test]
async fn a_typed_reply_that_echoes_the_token_never_carries_it_into_the_error() -> Result {
    let fake = FakeProvider::start(r#"{"relevant":"access-1"}"#).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let error = client
        .models
        .generate::<Verdict>("chatgpt/gpt-5.5", &Prompt::ask("relevant?"))
        .await
        .err()
        .ok_or("the reply should not parse")?;
    let shown = format!("{error} {error:?}");
    assert!(matches!(error, ModelError::Shape { .. }), "{shown}");
    assert!(!shown.contains("access-1"), "{shown}");
    Ok(())
}

/// A model list that refuses `alpha-111` and, for any other token, lists models named after
/// both the refused token and the one it was asked with.
async fn naming_both() -> Result<String> {
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    let app = axum::Router::new().route(
        "/models",
        axum::routing::get(|headers: HeaderMap| async move {
            let sent = headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            if sent == "Bearer alpha-111" {
                return StatusCode::UNAUTHORIZED.into_response();
            }
            axum::Json(serde_json::json!({ "models": [
                { "slug": "gpt-5.5", "display_name": "first was alpha-111, so long" },
                { "slug": "gpt-5.5-mini", "display_name": format!("now {sent}") },
                { "slug": "fine", "display_name": "Fine" }
            ] }))
            .into_response()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let root = format!("http://{}/", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Ok(root)
}

#[tokio::test]
async fn a_refreshed_listing_hands_on_neither_the_first_token_nor_the_new_one() -> Result {
    let root = naming_both().await?;
    let models = Models::new(
        Catalog::from_json(r#"{"endpoints":[]}"#)?,
        Keys::new(|_| None),
        "1.2.3",
    )?;
    models.set_endpoints(vec![account(&root)]);
    // Two unrelated tokens: neither is the start of the other.
    models.set_bearers(Bearers::new(
        root.clone(),
        |_| {
            Box::pin(async {
                Ok(Credential {
                    token: "alpha-111".to_owned(),
                    generation: 1,
                })
            })
        },
        |_, _| {
            Box::pin(async {
                Ok(Credential {
                    token: "omega-222".to_owned(),
                    generation: 1,
                })
            })
        },
        |_, _| Box::pin(async { Ok(Box::new(()) as DispatchGuard) }),
    ));
    let listed = models.list("chatgpt").await?;
    let shown = format!("{listed:?}");
    assert!(!shown.contains("alpha-111"), "the first token: {shown}");
    assert!(!shown.contains("omega-222"), "the refreshed token: {shown}");
    assert!(listed.iter().any(|m| m.name.as_deref() == Some("Fine")));
    Ok(())
}

#[tokio::test]
async fn an_answer_echoing_the_token_split_across_frames_never_hands_it_on() -> Result {
    let fake = FakeProvider::start_with(
        Script::reply("before access-1 after, and access-1 again")
            .chunks(17)
            .call("c1", "note", serde_json::json!({ "said": "access-1" })),
    )
    .await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let mut stream = Box::pin(
        client
            .models
            .stream("chatgpt/gpt-5.5", &Prompt::ask("hi"))
            .await?,
    );
    let (mut seen, mut text) = (String::new(), String::new());
    while let Some(delta) = stream.next().await {
        let delta = delta?;
        if let spade_models::Delta::Text(piece) = &delta {
            text.push_str(piece);
        }
        seen.push_str(&format!("{delta:?}"));
    }
    assert!(!seen.contains("access-1"), "{seen}");
    assert_eq!(text, "before [hidden] after, and [hidden] again");
    Ok(())
}

#[derive(Debug, Deserialize, JsonSchema)]
struct Note {
    said: String,
}

#[tokio::test]
async fn a_typed_answer_echoing_the_token_in_valid_json_never_hands_it_on() -> Result {
    let fake = FakeProvider::start(r#"{"said":"the token is access-1"}"#).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let note = client
        .models
        .generate::<Note>("chatgpt/gpt-5.5", &Prompt::ask("say it"))
        .await?;
    assert!(!note.value.said.contains("access-1"), "{}", note.value.said);
    Ok(())
}

#[tokio::test]
async fn a_typed_answer_spelling_the_token_with_a_json_escape_never_hands_it_on() -> Result {
    // The answer's text spells the token with a `u0061` escape: it is the token only once parsed.
    let answer = format!(r#"{{"said":"the token is {}"}}"#, escaped_token());
    let fake = FakeProvider::start(&answer).await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let note = client
        .models
        .generate::<Note>("chatgpt/gpt-5.5", &Prompt::ask("say it"))
        .await?;
    assert!(!note.value.said.contains("access-1"), "{}", note.value.said);
    Ok(())
}

#[tokio::test]
async fn a_tool_argument_holding_json_with_an_escaped_token_never_hands_it_on() -> Result {
    // The argument is a string of JSON spelling the token with an escape, which a tool decodes.
    let payload = format!(r#"{{"said":"{}"}}"#, escaped_token());
    let fake = FakeProvider::start_with(Script::reply("ok").call(
        "c1",
        "run",
        serde_json::json!({ "payload": payload }),
    ))
    .await?;
    let client = client_for(&fake.root, &fake.root, Some("access-1"))?;
    let reply = client
        .models
        .chat("chatgpt/gpt-5.5", &Prompt::ask("hi"))
        .await?;
    let payload = reply.calls[0].arguments["payload"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let decoded: serde_json::Value = serde_json::from_str(&payload)?;
    assert!(!decoded.to_string().contains("access-1"), "{decoded}");
    assert!(!payload.contains("access-1"), "{payload}");
    Ok(())
}

/// `access-1` as JSON may spell it: its `a` written as a backslash, `u0061`.
fn escaped_token() -> String {
    format!("{}u0061ccess-1", char::from(92u8))
}
