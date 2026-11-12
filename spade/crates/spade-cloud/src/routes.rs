//! The HTTP API (`spade/docs/cloud.md`). Logs name the account, the app and the outcome, never a
//! token, code, verifier, state or secret.

// A refusal is the response itself, returned once per request; boxing it buys nothing.
#![allow(clippy::result_large_err)]

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use spade_cloud_wire::{
    CALLBACK_PATH, Context, ErrorAnswer, FinishAnswer, FinishRequest, Purpose, RefreshAnswer,
    RefreshRequest, SIGN_IN_SECONDS, StartAnswer, StartRequest, is_public_key, refusal, seal,
};

use crate::apps::{App, Client};
use crate::keys::CheckError;
use crate::maker::MakerError;
use crate::page::Page;
use crate::sign_ins::{Callback, Finish, SignIn};
use crate::{Service, lock};

const MOST_BODY_BYTES: usize = 16 * 1024;

pub fn router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/oauth/{app}/start", post(start))
        .route("/v1/oauth/{app}/finish", post(finish))
        .route("/v1/oauth/{app}/refresh", post(refresh))
        .route(&format!("{CALLBACK_PATH}/{{app}}"), get(callback))
        .layer(DefaultBodyLimit::max(MOST_BODY_BYTES))
        .with_state(service)
}

async fn health() -> Response {
    let body = serde_json::json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") });
    (StatusCode::OK, axum::Json(body)).into_response()
}

fn refuse(status: StatusCode, code: &str) -> Response {
    (
        status,
        axum::Json(ErrorAnswer {
            error: code.to_owned(),
        }),
    )
        .into_response()
}

fn limited(seconds: u64) -> Response {
    let mut response = refuse(StatusCode::TOO_MANY_REQUESTS, refusal::RATE_LIMITED);
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

/// Who is asking: the account a valid machine grant names, within its budget, and the app with
/// its client.
struct Caller<'a> {
    account: String,
    app: &'a App,
    client: &'a Client,
}

impl Service {
    fn address(&self, headers: &HeaderMap, peer: SocketAddr) -> String {
        self.address_header
            .as_ref()
            .and_then(|name| headers.get(name))
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.rsplit(',').next())
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| peer.ip().to_string())
    }

    fn take_address(&self, headers: &HeaderMap, peer: SocketAddr) -> Result<(), Response> {
        let address = self.address(headers, peer);
        lock(&self.addresses)
            .take(&address, self.now())
            .map_err(limited)
    }

    async fn caller(
        &self,
        headers: &HeaderMap,
        peer: SocketAddr,
        app: &str,
    ) -> Result<Caller<'_>, Response> {
        self.take_address(headers, peer)?;
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| refuse(StatusCode::UNAUTHORIZED, refusal::UNAUTHORIZED))?;
        let claims = match self.keys.machine(bearer).await {
            Ok(claims) => claims,
            Err(CheckError::Grant(why)) => {
                tracing::info!(outcome = "unauthorized", reason = %why, "refused a grant");
                return Err(refuse(StatusCode::UNAUTHORIZED, refusal::UNAUTHORIZED));
            }
            Err(CheckError::NoKeys(why)) => {
                tracing::error!(reason = %why, "no account keys to check grants with");
                return Err(refuse(
                    StatusCode::SERVICE_UNAVAILABLE,
                    refusal::ACCOUNT_UNAVAILABLE,
                ));
            }
        };
        lock(&self.accounts)
            .take(&claims.account, self.now())
            .map_err(|seconds| {
                tracing::info!(account = %claims.account, app, outcome = "rate_limited", "refused");
                limited(seconds)
            })?;
        let configured = self
            .apps
            .iter()
            .find(|c| c.app.id == app)
            .ok_or_else(|| refuse(StatusCode::NOT_FOUND, refusal::UNKNOWN_APP))?;
        let client = configured.client.as_ref().ok_or_else(|| {
            tracing::warn!(account = %claims.account, app, outcome = "app_unavailable", "no client set for this app");
            refuse(StatusCode::SERVICE_UNAVAILABLE, refusal::APP_UNAVAILABLE)
        })?;
        Ok(Caller {
            account: claims.account,
            app: &configured.app,
            client,
        })
    }

    fn random_value(&self) -> Result<String, Response> {
        let mut bytes = [0u8; 32];
        self.random
            .fill(&mut bytes)
            .map_err(|_| refuse(StatusCode::INTERNAL_SERVER_ERROR, refusal::UPSTREAM))?;
        Ok(URL_SAFE_NO_PAD.encode(bytes))
    }

    fn authorization_url(
        &self,
        app: &App,
        client: &Client,
        state: &str,
        challenge: &str,
    ) -> String {
        let Ok(mut url) = url::Url::parse(&app.authorization_endpoint) else {
            return app.authorization_endpoint.clone();
        };
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &client.id)
                .append_pair("redirect_uri", &format!("{}/{}", self.redirect, app.id))
                .append_pair("state", state)
                .append_pair("code_challenge", challenge)
                .append_pair("code_challenge_method", "S256")
                .append_pair("resource", &app.resource);
            if !app.scopes.is_empty() {
                query.append_pair("scope", &app.scopes.join(" "));
            }
        }
        url.to_string()
    }
}

fn body<T: serde::de::DeserializeOwned>(bytes: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(bytes).map_err(|_| refuse(StatusCode::BAD_REQUEST, refusal::INVALID))
}

fn is_challenge(text: &str) -> bool {
    text.len() == 43
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

async fn start(
    State(service): State<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(app): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let caller = match service.caller(&headers, peer, &app).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let request: StartRequest = match body(&bytes) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if !is_challenge(&request.code_challenge) || !is_public_key(&request.public_key) {
        return refuse(StatusCode::BAD_REQUEST, refusal::INVALID);
    }
    let (handle, state) = match (service.random_value(), service.random_value()) {
        (Ok(handle), Ok(state)) => (handle, state),
        (Err(response), _) | (_, Err(response)) => return response,
    };
    let url = service.authorization_url(caller.app, caller.client, &state, &request.code_challenge);
    let sign_in = SignIn::new(
        handle.clone(),
        state,
        caller.account.clone(),
        caller.app.id.clone(),
        request.code_challenge,
        request.public_key,
        service.now(),
    );
    if !lock(&service.sign_ins).begin(sign_in, service.now()) {
        tracing::warn!(account = %caller.account, app, outcome = "full", "too many sign-ins in progress");
        return limited(30);
    }
    tracing::info!(account = %caller.account, app, outcome = "started", "sign-in started");
    let answer = StartAnswer {
        sign_in: handle,
        authorization_url: url,
        expires_in: SIGN_IN_SECONDS,
        issuer: caller.app.issuer.clone(),
        client_id: caller.client.id.clone(),
    };
    (StatusCode::OK, axum::Json(answer)).into_response()
}

#[derive(Default)]
struct CallbackQuery {
    state: Option<String>,
    code: Option<String>,
    iss: Option<String>,
    error: Option<String>,
}

impl CallbackQuery {
    /// The first of each parameter; a repeated one is ignored.
    fn parse(query: Option<&str>) -> Self {
        let mut parsed = Self::default();
        for (key, value) in url::form_urlencoded::parse(query.unwrap_or("").as_bytes()) {
            let slot = match key.as_ref() {
                "state" => &mut parsed.state,
                "code" => &mut parsed.code,
                "iss" => &mut parsed.iss,
                "error" => &mut parsed.error,
                _ => continue,
            };
            if slot.is_none() {
                *slot = Some(value.into_owned());
            }
        }
        parsed
    }
}

async fn callback(
    State(service): State<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
    Path(callback_app): Path<String>,
) -> Response {
    if let Err(response) = service.take_address(&headers, peer) {
        return response;
    }
    let query = CallbackQuery::parse(query.as_deref());
    let Some(state) = query.state.as_deref().filter(|s| !s.is_empty()) else {
        return Page::Invalid.into_response();
    };
    let now = service.now();
    let mut sign_ins = lock(&service.sign_ins);
    let Some(app) = sign_ins.app_of(state) else {
        drop(sign_ins);
        tracing::info!(
            outcome = "unknown_state",
            "a callback named no sign-in in progress"
        );
        return Page::Invalid.into_response();
    };
    if app != callback_app {
        return Page::Invalid.into_response();
    }
    // RFC 9207: an `iss` naming another server is an answer mixed up between servers.
    let issuer_ok = match (&query.iss, service.apps.iter().find(|c| c.app.id == app)) {
        (Some(iss), Some(configured)) => configured.app.is_issuer(iss),
        (None, Some(configured)) => {
            !configured
                .app
                .authorization_response_iss_parameter_supported
        }
        (_, None) => false,
    };
    let verdict = sign_ins.callback(
        state,
        query.code.as_deref(),
        query.error.is_some(),
        issuer_ok,
        now,
    );
    drop(sign_ins);
    match verdict {
        Callback::Accepted { account, app } => {
            tracing::info!(%account, app, outcome = "returned", "the person signed in at the app");
            Page::SignedIn.into_response()
        }
        Callback::Declined { account, app } => {
            let outcome = if issuer_ok {
                "declined"
            } else {
                "wrong_issuer"
            };
            tracing::info!(%account, app, outcome, "the sign-in came back without a code");
            Page::Declined.into_response()
        }
        Callback::Unknown | Callback::Expired => {
            tracing::info!(
                app,
                outcome = "replayed_or_expired",
                "a callback was refused"
            );
            Page::Invalid.into_response()
        }
    }
}

async fn finish(
    State(service): State<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(app): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let caller = match service.caller(&headers, peer, &app).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let request: FinishRequest = match body(&bytes) {
        Ok(request) => request,
        Err(response) => return response,
    };
    let verdict = lock(&service.sign_ins).finish(
        &request.sign_in,
        &caller.account,
        &caller.app.id,
        &request.code_verifier,
        service.now(),
    );
    let account = caller.account.as_str();
    let (code, public_key) = match verdict {
        Finish::Ready { code, public_key } => (code, public_key),
        Finish::Waiting => {
            return (StatusCode::ACCEPTED, axum::Json(FinishAnswer::Waiting)).into_response();
        }
        refused => {
            let (status, code) = match refused {
                Finish::Expired => (StatusCode::GONE, refusal::EXPIRED),
                Finish::WrongVerifier => (StatusCode::BAD_REQUEST, refusal::WRONG_VERIFIER),
                Finish::Declined => (StatusCode::CONFLICT, refusal::DECLINED),
                _ => (StatusCode::NOT_FOUND, refusal::UNKNOWN_SIGN_IN),
            };
            tracing::info!(account, app, outcome = code, "finish refused");
            return refuse(status, code);
        }
    };
    let tokens = service
        .maker
        .exchange(
            caller.app,
            caller.client,
            &code,
            &request.code_verifier,
            &format!("{}/{}", service.redirect, caller.app.id),
        )
        .await;
    sealed_answer(
        &service,
        caller.app,
        account,
        &public_key,
        tokens,
        Purpose::Finish,
    )
}

async fn refresh(
    State(service): State<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(app): Path<String>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Response {
    let caller = match service.caller(&headers, peer, &app).await {
        Ok(caller) => caller,
        Err(response) => return response,
    };
    let request: RefreshRequest = match body(&bytes) {
        Ok(request) => request,
        Err(response) => return response,
    };
    if request.refresh_token.is_empty() || !is_public_key(&request.public_key) {
        return refuse(StatusCode::BAD_REQUEST, refusal::INVALID);
    }
    let tokens = service
        .maker
        .refresh(caller.app, caller.client, &request.refresh_token)
        .await;
    sealed_answer(
        &service,
        caller.app,
        &caller.account,
        &request.public_key,
        tokens,
        Purpose::Refresh,
    )
}

/// The maker's token response sealed to Spade's key, or why there is none. The tokens leave
/// memory with the answer.
fn sealed_answer(
    service: &Service,
    app: &App,
    account: &str,
    public_key: &str,
    tokens: Result<Vec<u8>, MakerError>,
    purpose: Purpose,
) -> Response {
    let step = match purpose {
        Purpose::Finish => "exchange",
        Purpose::Refresh => "refresh",
    };
    let app_id = app.id.as_str();
    let tokens = match tokens {
        Ok(tokens) => tokens,
        Err(MakerError::Refused) => {
            tracing::info!(
                account,
                app = app_id,
                step,
                outcome = "refused",
                "the app refused"
            );
            return refuse(StatusCode::BAD_REQUEST, refusal::REFUSED);
        }
        Err(MakerError::Upstream) => {
            tracing::warn!(
                account,
                app = app_id,
                step,
                outcome = "upstream",
                "the app didn't answer usably"
            );
            return refuse(StatusCode::BAD_GATEWAY, refusal::UPSTREAM);
        }
    };
    let context = Context {
        app: app_id,
        purpose,
    };
    match seal(service.random.as_ref(), public_key, &tokens, context) {
        Ok(sealed) => {
            tracing::info!(
                account,
                app = app_id,
                step,
                outcome = "ok",
                "tokens sealed to Spade"
            );
            match purpose {
                Purpose::Finish => {
                    (StatusCode::OK, axum::Json(FinishAnswer::Done { sealed })).into_response()
                }
                Purpose::Refresh => {
                    (StatusCode::OK, axum::Json(RefreshAnswer { sealed })).into_response()
                }
            }
        }
        Err(_) => {
            tracing::warn!(
                account,
                app = app_id,
                step,
                outcome = "unsealable",
                "Spade's key was refused"
            );
            refuse(StatusCode::BAD_REQUEST, refusal::INVALID)
        }
    }
}
