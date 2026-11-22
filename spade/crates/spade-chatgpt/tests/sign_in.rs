//! Signing in to ChatGPT against a local fake of OpenAI's sign-in server, with `keyring-core`'s
//! mock store: no real keychain and no real OpenAI login is ever touched.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{Value, json};
use spade_chatgpt::claims::unsigned;
use spade_chatgpt::{Accounts, BearerError, Config, Finish, Flows, Method, SignedIn};
use spade_connect::oauth::pkce::Random;
use spade_keys::{KeyStore, SERVICE};

type Result<T = ()> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

const AUTH: &str = "https://api.openai.com/auth";

#[derive(Default)]
struct Fake {
    /// Refreshes asked for, by refresh token.
    refreshes: Mutex<Vec<String>>,
    /// Refresh tokens the server refuses.
    dead: Mutex<Vec<String>>,
    /// Polls of the device code so far.
    polls: AtomicUsize,
    /// Codes the token endpoint was asked to trade, with their verifier.
    traded: Mutex<Vec<(String, String)>>,
    /// The access token's `exp`.
    exp: AtomicI64,
}

fn tokens(fake: &Fake, n: usize) -> Value {
    json!({
        "id_token": unsigned(&json!({
            "email": "sam@example.com",
            AUTH: { "chatgpt_account_id": "acct-1", "chatgpt_plan_type": "plus" }
        })),
        "access_token": unsigned(&json!({ "n": n, "exp": fake.exp.load(Ordering::SeqCst) })),
        "refresh_token": format!("refresh-{n}"),
    })
}

async fn token(State(fake): State<Arc<Fake>>, headers: HeaderMap, body: String) -> Response {
    let form = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/x-www-form-urlencoded"));
    if form {
        let fields: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        let field = |k: &str| fields.get(k).cloned().unwrap_or_default();
        if field("grant_type") != "authorization_code" || field("client_id") != "client-1" {
            return StatusCode::BAD_REQUEST.into_response();
        }
        fake.traded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push((field("code"), field("code_verifier")));
        return Json(tokens(&fake, 1)).into_response();
    }
    let Ok(asked) = serde_json::from_str::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let refresh = asked["refresh_token"].as_str().unwrap_or("").to_owned();
    if fake.dead.lock().unwrap_or_else(|p| p.into_inner()).contains(&refresh) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "refresh_token_reused" } })),
        )
            .into_response();
    }
    let mut refreshes = fake.refreshes.lock().unwrap_or_else(|p| p.into_inner());
    refreshes.push(refresh);
    Json(tokens(&fake, refreshes.len() + 1)).into_response()
}

async fn usercode() -> Json<Value> {
    Json(json!({ "device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": "1" }))
}

async fn device_token(State(fake): State<Arc<Fake>>, Json(asked): Json<Value>) -> Response {
    if asked["device_auth_id"] != "dev-1" || asked["user_code"] != "ABCD-1234" {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if fake.polls.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({
        "authorization_code": "device-code",
        "code_challenge": "c",
        "code_verifier": "device-verifier"
    }))
    .into_response()
}

struct Setup {
    fake: Arc<Fake>,
    flows: Arc<Flows>,
    keys: KeyStore,
    now: Arc<AtomicI64>,
}

/// Counts up, so every random value differs.
struct Counter(AtomicUsize);

impl Random for Counter {
    fn fill(&self, buf: &mut [u8]) -> std::result::Result<(), String> {
        let n = self.0.fetch_add(1, Ordering::SeqCst);
        for (i, byte) in buf.iter_mut().enumerate() {
            *byte = u8::try_from((n + i) % 251).unwrap_or(0);
        }
        Ok(())
    }
}

async fn setup() -> Result<Setup> {
    let fake = Arc::new(Fake::default());
    fake.exp.store(10_000, Ordering::SeqCst);
    let app = Router::new()
        .route("/oauth/token", post(token))
        .route("/api/accounts/deviceauth/usercode", post(usercode))
        .route("/api/accounts/deviceauth/token", post(device_token))
        .with_state(fake.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let issuer = format!("http://{}", listener.local_addr()?);
    tokio::spawn(async move { axum::serve(listener, app).await });
    let keys = KeyStore::with_store(keyring_core::mock::Store::new()?, SERVICE);
    let now = Arc::new(AtomicI64::new(1_000));
    let clock_now = now.clone();
    let config = Config {
        issuer,
        client_id: "client-1".to_owned(),
        callback_port: 0,
        originator: "spade".to_owned(),
        wait: Duration::from_secs(20),
    };
    let accounts = Arc::new(Accounts::new(
        Some(keys.clone()),
        config,
        Arc::new(move || clock_now.load(Ordering::SeqCst)),
    )?);
    let flows = Flows::new(accounts, Arc::new(Counter(AtomicUsize::new(1))));
    Ok(Setup {
        fake,
        flows,
        keys,
        now,
    })
}

/// Keeps each finished sign-in's tokens as account `chatgpt`, and remembers who it was.
fn keeper(flows: &Arc<Flows>, seen: Arc<Mutex<Vec<spade_chatgpt::Account>>>) -> Finish {
    let accounts = flows.accounts().clone();
    Arc::new(move |done: SignedIn| {
        let accounts = accounts.clone();
        let seen = seen.clone();
        Box::pin(async move {
            accounts
                .keep("chatgpt", &done.tokens)
                .await
                .map_err(|e| e.to_string())?;
            seen.lock().unwrap_or_else(|p| p.into_inner()).push(done.account);
            Ok("chatgpt".to_owned())
        })
    })
}

async fn until_ended(flows: &Flows, id: &str) -> Result<spade_chatgpt::FlowView> {
    for _ in 0..200 {
        let view = flows.view(id).ok_or("the sign-in is gone")?;
        if view.state != "waiting" {
            return Ok(view);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Err("the sign-in never ended".into())
}

fn query(url: &str, name: &str) -> Option<String> {
    url::Url::parse(url)
        .ok()?
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

#[tokio::test]
async fn a_browser_sign_in_comes_back_to_the_loopback_and_keeps_its_tokens_in_the_keychain()
-> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen.clone()))
        .await?;
    let url = flow.url.clone().ok_or("no sign-in address")?;
    assert_eq!(query(&url, "client_id").as_deref(), Some("client-1"));
    assert_eq!(query(&url, "code_challenge_method").as_deref(), Some("S256"));
    assert_eq!(query(&url, "originator").as_deref(), Some("spade"));
    let redirect = query(&url, "redirect_uri").ok_or("no redirect")?;
    assert!(redirect.starts_with("http://127.0.0.1:"), "{redirect}");
    let state = query(&url, "state").ok_or("no state")?;

    let http = reqwest::Client::new();
    // A code with another state is turned away, and the sign-in keeps waiting for its own.
    let stray = http
        .get(format!("{redirect}?code=stolen&state=other"))
        .send()
        .await?;
    assert_eq!(stray.status(), 400);
    assert_eq!(s.flows.view(&flow.id).map(|v| v.state), Some("waiting"));
    let back = http
        .get(format!("{redirect}?code=code-1&state={state}"))
        .send()
        .await?;
    assert_eq!(back.status(), 200);

    let ended = until_ended(&s.flows, &flow.id).await?;
    assert_eq!(ended.state, "done", "{:?}", ended.error);
    assert_eq!(ended.endpoint.as_deref(), Some("chatgpt"));
    let traded = s.fake.traded.lock().unwrap_or_else(|p| p.into_inner()).clone();
    assert_eq!(traded.len(), 1);
    assert_eq!(traded[0].0, "code-1");
    assert_eq!(
        spade_connect::oauth::pkce::challenge(&traded[0].1),
        query(&url, "code_challenge").unwrap_or_default(),
        "the verifier traded is the one the challenge was made from"
    );
    let who = seen.lock().unwrap_or_else(|p| p.into_inner()).clone();
    assert_eq!(who[0].email.as_deref(), Some("sam@example.com"));
    assert_eq!(who[0].plan.as_deref(), Some("plus"));
    assert_eq!(
        s.keys.sign_in_secret("chatgpt", "refresh")?.as_deref(),
        Some("refresh-1")
    );
    // The view never carries a token.
    let shown = serde_json::to_string(&ended)?;
    assert!(!shown.contains("refresh-1") && !shown.contains("code-1"), "{shown}");
    Ok(())
}

#[tokio::test]
async fn a_device_sign_in_shows_a_code_and_finishes_once_the_person_approves() -> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let flow = s
        .flows
        .start(Method::Device, keeper(&s.flows, seen))
        .await?;
    assert_eq!(flow.user_code.as_deref(), Some("ABCD-1234"));
    assert!(flow.url.as_deref().is_some_and(|u| u.ends_with("/codex/device")));
    let ended = until_ended(&s.flows, &flow.id).await?;
    assert_eq!(ended.state, "done", "{:?}", ended.error);
    assert!(s.fake.polls.load(Ordering::SeqCst) >= 2, "it waited past a pending poll");
    let traded = s.fake.traded.lock().unwrap_or_else(|p| p.into_inner()).clone();
    assert_eq!(
        traded,
        vec![("device-code".to_owned(), "device-verifier".to_owned())]
    );
    Ok(())
}

#[tokio::test]
async fn a_cancelled_sign_in_ends_and_frees_its_port_for_the_next() -> Result {
    let s = setup().await?;
    let seen = Arc::new(Mutex::new(Vec::new()));
    let first = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen.clone()))
        .await?;
    assert!(s.flows.cancel(&first.id));
    assert_eq!(s.flows.view(&first.id).map(|v| v.state), Some("cancelled"));
    assert!(!s.flows.cancel(&first.id), "only a waiting sign-in cancels");
    // Starting another cancels a waiting one.
    let second = s
        .flows
        .start(Method::Browser, keeper(&s.flows, seen.clone()))
        .await?;
    let third = s.flows.start(Method::Device, keeper(&s.flows, seen)).await?;
    assert_eq!(s.flows.view(&second.id).map(|v| v.state), Some("cancelled"));
    assert_eq!(s.flows.view(&third.id).map(|v| v.state), Some("waiting"));
    Ok(())
}

fn signed(fake: &Fake) -> spade_chatgpt::Tokens {
    serde_json::from_value(tokens(fake, 0)).unwrap_or_else(|_| unreachable!())
}

#[tokio::test]
async fn an_access_token_near_its_end_is_refreshed_once_and_the_new_tokens_are_kept() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    // Well before its end: no refresh.
    let first = accounts.bearer("chatgpt").await?;
    assert!(s.fake.refreshes.lock().unwrap_or_else(|p| p.into_inner()).is_empty());
    // Four minutes left: refreshed, and both calls at once share one refresh.
    s.now.store(10_000 - 240, Ordering::SeqCst);
    s.fake.exp.store(20_000, Ordering::SeqCst);
    let (a, b) = tokio::join!(accounts.bearer("chatgpt"), accounts.bearer("chatgpt"));
    let (a, b) = (a?, b?);
    assert_eq!(a, b);
    assert_ne!(a, first);
    assert_eq!(
        *s.fake.refreshes.lock().unwrap_or_else(|p| p.into_inner()),
        vec!["refresh-0".to_owned()]
    );
    assert_eq!(
        s.keys.sign_in_secret("chatgpt", "refresh")?.as_deref(),
        Some("refresh-2"),
        "a rotated refresh token is kept"
    );
    assert_eq!(s.keys.sign_in_secret("chatgpt", "access")?, Some(a));
    Ok(())
}

#[tokio::test]
async fn a_refused_refresh_signs_the_account_out_and_its_tokens_go() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    s.fake
        .dead
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .push("refresh-0".to_owned());
    s.now.store(10_000, Ordering::SeqCst);
    let error = accounts.bearer("chatgpt").await.err().ok_or("no error")?;
    assert!(matches!(error, BearerError::SignedOut(_)), "{error:?}");
    assert_eq!(s.keys.sign_in_secret("chatgpt", "refresh")?, None);
    assert_eq!(s.keys.sign_in_secret("chatgpt", "access")?, None);
    // Signed out stays signed out, with no call to the server.
    let again = accounts.bearer("chatgpt").await.err().ok_or("no error")?;
    assert!(matches!(again, BearerError::SignedOut(_)));
    Ok(())
}

#[tokio::test]
async fn signing_out_forgets_the_tokens_and_another_account_keeps_its_own() -> Result {
    let s = setup().await?;
    let accounts = s.flows.accounts().clone();
    accounts.keep("chatgpt", &signed(&s.fake)).await?;
    accounts.keep("chatgpt-2", &signed(&s.fake)).await?;
    assert!(accounts.forget("chatgpt").await?);
    assert!(matches!(
        accounts.bearer("chatgpt").await,
        Err(BearerError::SignedOut(_))
    ));
    assert!(accounts.bearer("chatgpt-2").await.is_ok());
    Ok(())
}
