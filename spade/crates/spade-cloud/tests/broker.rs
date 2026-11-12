//! The broker over real HTTP: a sign-in from start to sealed tokens, and everything that must
//! refuse one.

mod support;

use spade_cloud::limits::Budget;
use spade_cloud_wire::{Context, OneTimeKey, Purpose, Sealed};
use support::{Cloud, ISSUER, Options, Result, SECRET, VERIFIER, fail};

fn open(
    key: OneTimeKey,
    body: &serde_json::Value,
    app: &str,
    purpose: Purpose,
) -> Result<serde_json::Value> {
    let sealed: Sealed = serde_json::from_value(body["sealed"].clone()).map_err(fail)?;
    let bytes = key.open(&sealed, Context { app, purpose }).map_err(fail)?;
    serde_json::from_slice(&bytes).map_err(fail)
}

#[tokio::test(flavor = "current_thread")]
async fn a_sign_in_ends_with_the_makers_tokens_sealed_to_spades_key_and_nothing_held() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, key) = cloud.begin("asana", "user_a").await?;
    let query = |name: &str| {
        started
            .url
            .query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    assert_eq!(
        query("prompt").as_deref(),
        Some("consent"),
        "the endpoint's own query stays"
    );
    assert_eq!(query("client_id").as_deref(), Some("cloud-client"));
    assert_eq!(
        query("redirect_uri"),
        Some(format!("{}/v1/oauth/callback", cloud.url))
    );
    assert_eq!(query("code_challenge_method").as_deref(), Some("S256"));
    assert_eq!(
        query("resource").as_deref(),
        Some("https://mcp.maker.example/asana")
    );
    assert_eq!(query("scope").as_deref(), Some("default write"));
    assert_ne!(
        started.state, started.sign_in,
        "the state is not what Spade names it by"
    );

    let (status, body) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!((status, body["status"].as_str()), (202, Some("waiting")));

    let (status, page) = cloud
        .callback(&[
            ("code", "code-1"),
            ("state", &started.state),
            ("iss", ISSUER),
        ])
        .await?;
    assert_eq!(status, 200);
    assert!(
        page.contains("Signed in. You can close this tab."),
        "{page}"
    );

    let (status, body) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!((status, body["status"].as_str()), (200, Some("done")));
    assert!(
        !body.to_string().contains("access-1"),
        "the answer is sealed"
    );
    let tokens = open(key, &body, "asana", Purpose::Finish)?;
    assert_eq!(
        tokens,
        serde_json::json!({"access_token": "access-1", "refresh_token": "refresh-1",
            "expires_in": 3600, "token_type": "Bearer"})
    );
    assert_eq!(
        cloud.service.sign_ins_held(),
        0,
        "nothing is kept once Spade has the tokens"
    );

    let sent = cloud.sent.lock().map_err(fail)?.clone();
    let form = &sent.forms[0];
    let field = |name: &str| {
        form.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(
        field("client_secret"),
        Some(SECRET),
        "asana takes its secret in the form"
    );
    assert_eq!(field("code_verifier"), Some(VERIFIER));
    assert_eq!(
        field("redirect_uri"),
        Some(format!("{}/v1/oauth/callback", cloud.url).as_str())
    );
    assert_eq!(field("resource"), Some("https://mcp.maker.example/asana"));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_app_taking_basic_authentication_gets_the_secret_in_the_header_not_the_form() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, key) = cloud.begin("box", "user_a").await?;
    cloud
        .callback(&[("code", "code-1"), ("state", &started.state)])
        .await?;
    let (status, body) = cloud
        .finish("box", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        open(key, &body, "box", Purpose::Finish)?["access_token"],
        "access-1"
    );
    let sent = cloud.sent.lock().map_err(fail)?.clone();
    assert!(
        sent.authorizations[0]
            .as_deref()
            .is_some_and(|a| a.starts_with("Basic "))
    );
    assert!(!sent.forms[0].iter().any(|(k, _)| k == "client_secret"));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn another_account_or_app_can_neither_finish_nor_disturb_a_sign_in() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, _key) = cloud.begin("asana", "user_a").await?;
    cloud
        .callback(&[("code", "code-1"), ("state", &started.state)])
        .await?;
    let (status, body) = cloud
        .finish("asana", "user_b", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(
        (status, body["error"].as_str()),
        (404, Some("unknown_sign_in"))
    );
    let (status, _) = cloud
        .finish("box", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 404, "a sign-in to asana can't be finished as box");
    let (status, _) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 200, "the owner still finishes it");
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn a_wrong_verifier_ends_the_sign_in_before_any_exchange() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, _key) = cloud.begin("asana", "user_a").await?;
    cloud
        .callback(&[("code", "code-1"), ("state", &started.state)])
        .await?;
    let wrong = "x".repeat(43);
    let (status, body) = cloud
        .finish("asana", "user_a", &started.sign_in, &wrong)
        .await?;
    assert_eq!(
        (status, body["error"].as_str()),
        (400, Some("wrong_verifier"))
    );
    let (status, _) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 404, "one wrong guess ends it");
    assert!(
        cloud.sent.lock().map_err(fail)?.forms.is_empty(),
        "the maker was never asked"
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_answer_naming_another_issuer_or_a_declined_sign_in_ends_it_as_declined() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, _key) = cloud.begin("asana", "user_a").await?;
    let (status, page) = cloud
        .callback(&[
            ("code", "code-1"),
            ("state", &started.state),
            ("iss", "https://evil.example"),
        ])
        .await?;
    assert_eq!(status, 200);
    assert!(page.contains("cancelled"), "{page}");
    let (status, body) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!((status, body["error"].as_str()), (409, Some("declined")));

    let (started, _key) = cloud.begin("asana", "user_a").await?;
    cloud
        .callback(&[("error", "access_denied"), ("state", &started.state)])
        .await?;
    let (status, _) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 409);
    assert!(cloud.sent.lock().map_err(fail)?.forms.is_empty());
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn a_sign_in_expires_after_ten_minutes() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, _key) = cloud.begin("asana", "user_a").await?;
    cloud.advance(600_000);
    let (status, page) = cloud
        .callback(&[("code", "code-1"), ("state", &started.state)])
        .await?;
    assert_eq!(status, 400);
    assert!(page.contains("expired or was already used"), "{page}");

    let (started, _key) = cloud.begin("asana", "user_a").await?;
    cloud
        .callback(&[("code", "code-1"), ("state", &started.state)])
        .await?;
    cloud.advance(600_000);
    let (status, body) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!((status, body["error"].as_str()), (410, Some("expired")));
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn neither_a_callback_nor_a_finish_can_be_replayed() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let (started, _key) = cloud.begin("asana", "user_a").await?;
    let first = [("code", "code-1"), ("state", started.state.as_str())];
    assert_eq!(cloud.callback(&first).await?.0, 200);
    let (status, _) = cloud
        .callback(&[("code", "code-attacker"), ("state", &started.state)])
        .await?;
    assert_eq!(status, 400, "a second answer for one state is refused");
    let (status, _) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 200, "the first code stood");
    let (status, _) = cloud
        .finish("asana", "user_a", &started.sign_in, VERIFIER)
        .await?;
    assert_eq!(status, 404);
    assert_eq!(cloud.callback(&first).await?.0, 400);
    assert_eq!(
        cloud.sent.lock().map_err(fail)?.forms.len(),
        1,
        "one exchange only"
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn only_a_live_machine_grant_from_aces_account_keys_is_let_in() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let body = serde_json::json!({"code_challenge": "a".repeat(43), "public_key": "x"});
    let now = support::NOW;
    for grant in [
        None,
        Some(cloud.grant("user_a", "device")),
        Some(cloud.grant_with("user_a", "machine", now - 300_000, now)),
        Some(cloud.grant("user_a", "machine").replace('.', ".x")),
        Some("not-a-grant".to_owned()),
    ] {
        let (status, answer) = cloud
            .post("/v1/oauth/asana/start", grant.as_deref(), body.clone())
            .await?;
        assert_eq!(
            (status, answer["error"].as_str()),
            (401, Some("unauthorized")),
            "{grant:?}"
        );
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_unknown_app_or_one_without_its_client_set_is_refused() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let grant = cloud.grant("user_a", "machine");
    let body = serde_json::json!({});
    let (status, answer) = cloud
        .post("/v1/oauth/notion/start", Some(&grant), body.clone())
        .await?;
    assert_eq!(
        (status, answer["error"].as_str()),
        (404, Some("unknown_app"))
    );
    let (status, answer) = cloud
        .post("/v1/oauth/canva/start", Some(&grant), body)
        .await?;
    assert_eq!(
        (status, answer["error"].as_str()),
        (503, Some("app_unavailable"))
    );
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn an_account_past_its_budget_waits_while_another_account_goes_on() -> Result {
    let cloud = Cloud::start(Options {
        budget: Budget {
            burst: 3,
            every_ms: 10_000,
        },
        ..Options::default()
    })
    .await?;
    for _ in 0..3 {
        cloud.begin("asana", "user_a").await?;
    }
    let refused = cloud
        .begin("asana", "user_a")
        .await
        .err()
        .unwrap_or_default();
    assert!(
        refused.contains("429") && refused.contains("rate_limited"),
        "{refused}"
    );
    cloud.begin("asana", "user_b").await?;
    cloud.advance(10_000);
    cloud.begin("asana", "user_a").await?;
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn a_refresh_comes_back_sealed_and_a_revoked_token_says_sign_in_again() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let grant = cloud.grant("user_a", "machine");
    let key = OneTimeKey::generate(&ring::rand::SystemRandom::new()).map_err(fail)?;
    let (status, body) = cloud
        .post(
            "/v1/oauth/asana/refresh",
            Some(&grant),
            serde_json::json!({"refresh_token": "refresh-1", "public_key": key.public_key()}),
        )
        .await?;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        open(key, &body, "asana", Purpose::Refresh)?["access_token"],
        "access-2"
    );

    let key = OneTimeKey::generate(&ring::rand::SystemRandom::new()).map_err(fail)?;
    let (status, body) = cloud
        .post(
            "/v1/oauth/asana/refresh",
            Some(&grant),
            serde_json::json!({"refresh_token": "revoked", "public_key": key.public_key()}),
        )
        .await?;
    assert_eq!((status, body["error"].as_str()), (400, Some("refused")));
    assert_eq!(cloud.service.sign_ins_held(), 0, "a refresh keeps nothing");
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn health_answers_without_a_grant() -> Result {
    let cloud = Cloud::start(Options::default()).await?;
    let response = cloud
        .http
        .get(format!("{}/health", cloud.url))
        .send()
        .await
        .map_err(fail)?;
    assert_eq!(response.status().as_u16(), 200);
    Ok(())
}
