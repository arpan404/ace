//! A fake Spade Cloud (ADR 0140) on 127.0.0.1: the broker's start, finish and refresh, sealing
//! its tokens to Spade's one-time key exactly as the real one does. The person "signs in" when a
//! test calls [`FakeCloud::approve`].

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_cloud_wire::{Context, FinishAnswer, Purpose, RefreshAnswer, StartAnswer, seal};

/// The grant the fake accepts as the person's ace account credential.
pub const GRANT: &str = "fake-ace-machine-grant";

#[derive(Default)]
struct Cloud {
    approved: bool,
    challenge: String,
    public_key: String,
    /// Seconds the access tokens it gives last.
    expires_in: u64,
    /// Refreshes answer as a proxy does when the cloud behind it is down.
    refresh_down: bool,
    refreshes: Vec<String>,
    starts: usize,
    start_gate: Option<Arc<tokio::sync::Notify>>,
}

#[derive(Clone)]
pub struct FakeCloud {
    addr: SocketAddr,
    state: Arc<Mutex<Cloud>>,
    server: Arc<tokio::task::JoinHandle<()>>,
}

fn lock(state: &Mutex<Cloud>) -> std::sync::MutexGuard<'_, Cloud> {
    state.lock().unwrap_or_else(|p| p.into_inner())
}

fn refuse(status: StatusCode, code: &str) -> Response {
    (status, axum::Json(json!({ "error": code }))).into_response()
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v == format!("Bearer {GRANT}"))
}

fn sealed_tokens(public_key: &str, app: &str, purpose: Purpose, tokens: &Value) -> Response {
    let random = ring::rand::SystemRandom::new();
    let bytes = tokens.to_string().into_bytes();
    match seal(&random, public_key, &bytes, Context { app, purpose }) {
        Ok(sealed) => match purpose {
            Purpose::Finish => axum::Json(FinishAnswer::Done { sealed }).into_response(),
            Purpose::Refresh => axum::Json(RefreshAnswer { sealed }).into_response(),
        },
        Err(_) => refuse(StatusCode::BAD_REQUEST, "invalid_request"),
    }
}

async fn start(
    State(state): State<Arc<Mutex<Cloud>>>,
    Path(_app): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authorized(&headers) {
        return refuse(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let request: Value = serde_json::from_str(&body).unwrap_or_default();
    let gate = {
        let mut cloud = lock(&state);
        cloud.starts += 1;
        cloud.start_gate.clone()
    };
    if let Some(gate) = gate {
        gate.notified().await;
    }
    let mut cloud = lock(&state);
    cloud.approved = false;
    cloud.challenge = request["code_challenge"].as_str().unwrap_or("").to_owned();
    cloud.public_key = request["public_key"].as_str().unwrap_or("").to_owned();
    axum::Json(StartAnswer {
        sign_in: format!("sign-in-{}", cloud.starts),
        authorization_url: "https://auth.maker.example/authorize?client_id=cloud-client".into(),
        expires_in: 600,
        issuer: "https://auth.maker.example".into(),
        client_id: "cloud-client".into(),
    })
    .into_response()
}

async fn finish(
    State(state): State<Arc<Mutex<Cloud>>>,
    Path(app): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authorized(&headers) {
        return refuse(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let request: Value = serde_json::from_str(&body).unwrap_or_default();
    let verifier = request["code_verifier"].as_str().unwrap_or("");
    let (approved, challenge, public_key, expires_in) = {
        let cloud = lock(&state);
        (
            cloud.approved,
            cloud.challenge.clone(),
            cloud.public_key.clone(),
            cloud.expires_in,
        )
    };
    if URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())) != challenge {
        return refuse(StatusCode::BAD_REQUEST, "wrong_verifier");
    }
    if !approved {
        return (StatusCode::ACCEPTED, axum::Json(FinishAnswer::Waiting)).into_response();
    }
    let tokens = json!({
        "access_token": "access-1", "refresh_token": "refresh-1",
        "expires_in": expires_in, "token_type": "Bearer",
    });
    sealed_tokens(&public_key, &app, Purpose::Finish, &tokens)
}

async fn refresh(
    State(state): State<Arc<Mutex<Cloud>>>,
    Path(app): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if !authorized(&headers) {
        return refuse(StatusCode::UNAUTHORIZED, "unauthorized");
    }
    let request: Value = serde_json::from_str(&body).unwrap_or_default();
    let refresh_token = request["refresh_token"].as_str().unwrap_or("").to_owned();
    let expires_in = {
        let mut cloud = lock(&state);
        if cloud.refresh_down {
            return (StatusCode::BAD_GATEWAY, "<html>bad gateway</html>").into_response();
        }
        cloud.refreshes.push(refresh_token.clone());
        cloud.expires_in
    };
    if refresh_token != "refresh-1" && refresh_token != "refresh-2" {
        return refuse(StatusCode::BAD_REQUEST, "refused");
    }
    let tokens = json!({
        "access_token": "access-2", "refresh_token": "refresh-2",
        "expires_in": expires_in.max(3600), "token_type": "Bearer",
    });
    let public_key = request["public_key"].as_str().unwrap_or("");
    sealed_tokens(public_key, &app, Purpose::Refresh, &tokens)
}

impl FakeCloud {
    /// Hold start answers until the test releases the request.
    pub fn hold_starts(&self) -> Arc<tokio::sync::Notify> {
        let gate = Arc::new(tokio::sync::Notify::new());
        lock(&self.state).start_gate = Some(gate.clone());
        gate
    }
    /// A cloud whose access tokens last `expires_in` seconds.
    pub async fn start(expires_in: u64) -> Self {
        let state = Arc::new(Mutex::new(Cloud {
            expires_in,
            ..Cloud::default()
        }));
        let router = Router::new()
            .route("/v1/oauth/{app}/start", post(start))
            .route("/v1/oauth/{app}/finish", post(finish))
            .route("/v1/oauth/{app}/refresh", post(refresh))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|e| panic!("{e}"));
        let addr = listener.local_addr().unwrap_or_else(|e| panic!("{e}"));
        let server = tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        Self {
            addr,
            state,
            server: Arc::new(server),
        }
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// The person signs in at the maker and is redirected back to the cloud.
    pub fn approve(&self) {
        lock(&self.state).approved = true;
    }

    /// Refreshes fail as when the cloud is down behind its proxy.
    pub fn refresh_down(&self) {
        lock(&self.state).refresh_down = true;
    }

    /// Stops answering at all.
    pub fn stop(&self) {
        self.server.abort();
    }

    /// The refresh tokens Spade sent, in order.
    pub fn refreshes(&self) -> Vec<String> {
        lock(&self.state).refreshes.clone()
    }

    pub fn starts(&self) -> usize {
        lock(&self.state).starts
    }
}
