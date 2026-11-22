//! A stand-in for OpenAI's sign-in server (ADR 0213): the token endpoint (codes by form,
//! refreshes by JSON) and the device-code routes. Its tokens are unsigned JSON Web Tokens naming
//! one ChatGPT account. It records what it was asked, and can refuse a refresh token.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use tokio::net::TcpListener;

const AUTH: &str = "https://api.openai.com/auth";

/// An unsigned token whose payload is `claims`.
pub fn unsigned(claims: &Value) -> String {
    let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
    format!(
        "{}.{}.unsigned",
        encode(&json!({"alg": "none"})),
        encode(claims)
    )
}

#[derive(Default)]
struct Seen {
    refreshes: Mutex<Vec<String>>,
    dead: Mutex<Vec<String>>,
    polls: AtomicUsize,
    traded: Mutex<Vec<(String, String)>>,
    exp: AtomicI64,
    account: Mutex<(String, String)>,
}

/// The fake sign-in server.
#[derive(Clone)]
pub struct FakeSignIn {
    /// Its address, as a `Config::issuer`.
    pub issuer: String,
    /// The client id it accepts.
    pub client_id: String,
    seen: Arc<Seen>,
}

impl FakeSignIn {
    /// Signs in `sam@example.com`, ChatGPT account `acct-1` on the plus plan; access tokens end
    /// at Unix second 10,000 until [`FakeSignIn::expires_at`] says otherwise.
    pub async fn start() -> std::io::Result<Self> {
        let seen = Arc::new(Seen::default());
        seen.exp.store(10_000, Ordering::SeqCst);
        *seen.account.lock().unwrap_or_else(|p| p.into_inner()) =
            ("acct-1".to_owned(), "sam@example.com".to_owned());
        let app = Router::new()
            .route("/oauth/token", post(token))
            .route("/api/accounts/deviceauth/usercode", post(usercode))
            .route("/api/accounts/deviceauth/token", post(device_token))
            .with_state(seen.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let issuer = format!("http://{}", listener.local_addr()?);
        tokio::spawn(async move { axum::serve(listener, app).await });
        Ok(Self {
            issuer,
            client_id: "client-1".to_owned(),
            seen,
        })
    }

    /// Later sign-ins are for this ChatGPT account and email.
    pub fn signs_in(&self, account_id: &str, email: &str) {
        *self.seen.account.lock().unwrap_or_else(|p| p.into_inner()) =
            (account_id.to_owned(), email.to_owned());
    }

    /// Access tokens given from now on end at Unix second `at`.
    pub fn expires_at(&self, at: i64) {
        self.seen.exp.store(at, Ordering::SeqCst);
    }

    /// The server refuses `refresh` from now on, as one used or revoked.
    pub fn kill(&self, refresh: &str) {
        self.seen
            .dead
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(refresh.to_owned());
    }

    /// Refresh tokens a refresh was asked with, in order.
    pub fn refreshes(&self) -> Vec<String> {
        self.seen
            .refreshes
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Codes traded for tokens, each with its verifier.
    pub fn traded(&self) -> Vec<(String, String)> {
        self.seen
            .traded
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    /// Polls of the device code so far.
    pub fn polls(&self) -> usize {
        self.seen.polls.load(Ordering::SeqCst)
    }

    /// The tokens it would give as sign-in number `n` (`refresh-<n>`).
    pub fn tokens(&self, n: usize) -> Value {
        tokens(&self.seen, n)
    }
}

fn tokens(seen: &Seen, n: usize) -> Value {
    let (account, email) = seen
        .account
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    json!({
        "id_token": unsigned(&json!({
            "email": email,
            AUTH: { "chatgpt_account_id": account, "chatgpt_plan_type": "plus" }
        })),
        "access_token": unsigned(&json!({ "n": n, "exp": seen.exp.load(Ordering::SeqCst) })),
        "refresh_token": format!("refresh-{n}"),
    })
}

async fn token(State(seen): State<Arc<Seen>>, headers: HeaderMap, body: String) -> Response {
    let form = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("application/x-www-form-urlencoded"));
    if form {
        let fields: HashMap<String, String> = body
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (decode(k), decode(v)))
            .collect();
        let field = |k: &str| fields.get(k).cloned().unwrap_or_default();
        if field("grant_type") != "authorization_code" || field("client_id") != "client-1" {
            return StatusCode::BAD_REQUEST.into_response();
        }
        let mut traded = seen.traded.lock().unwrap_or_else(|p| p.into_inner());
        traded.push((field("code"), field("code_verifier")));
        let n = traded.len();
        drop(traded);
        return Json(tokens(&seen, n)).into_response();
    }
    let Ok(asked) = serde_json::from_str::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let refresh = asked["refresh_token"].as_str().unwrap_or("").to_owned();
    if seen
        .dead
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(&refresh)
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": { "code": "refresh_token_reused" } })),
        )
            .into_response();
    }
    let mut refreshes = seen.refreshes.lock().unwrap_or_else(|p| p.into_inner());
    refreshes.push(refresh);
    let n = 100 + refreshes.len();
    drop(refreshes);
    Json(tokens(&seen, n)).into_response()
}

/// Percent-decoding of a form field (`+` is a space).
fn decode(text: &str) -> String {
    let bytes = text.replace('+', " ").into_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && let (Some(Some(a)), Some(Some(b))) = (
                bytes.get(i + 1).map(|b| hex(*b)),
                bytes.get(i + 2).map(|b| hex(*b)),
            )
        {
            out.push(u8::try_from(a * 16 + b).unwrap_or(b'?'));
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn usercode() -> Json<Value> {
    Json(json!({ "device_auth_id": "dev-1", "user_code": "ABCD-1234", "interval": "1" }))
}

async fn device_token(State(seen): State<Arc<Seen>>, Json(asked): Json<Value>) -> Response {
    if asked["device_auth_id"] != "dev-1" || asked["user_code"] != "ABCD-1234" {
        return StatusCode::BAD_REQUEST.into_response();
    }
    // The first poll finds the person not done yet.
    if seen.polls.fetch_add(1, Ordering::SeqCst) == 0 {
        return StatusCode::FORBIDDEN.into_response();
    }
    Json(json!({
        "authorization_code": "device-code",
        "code_challenge": "c",
        "code_verifier": "device-verifier"
    }))
    .into_response()
}
