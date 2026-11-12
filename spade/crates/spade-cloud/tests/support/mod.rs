//! A Spade Cloud on 127.0.0.1 with fake account keys and a fake app maker, driven over HTTP the
//! way Spade drives it.

#![allow(dead_code)]

use std::io::Write;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::digest::{SHA256, digest};
use ring::signature::{Ed25519KeyPair, KeyPair};
use spade_cloud::apps::{App, Client, ClientAuth, Configured};
use spade_cloud::grant::{KeySet, PublishedKey};
use spade_cloud::keys::{Fetched, KeySource};
use spade_cloud::limits::Budget;
use spade_cloud::{Service, Setup};
use spade_cloud_wire::OneTimeKey;

pub const NOW: i64 = 1_800_000_000_000;
pub const SECRET: &str = "the-cloud-client-secret";
pub const VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
pub const ISSUER: &str = "https://auth.maker.example";

pub type Result<T = ()> = std::result::Result<T, String>;

pub fn fail<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

struct FixedKeys(KeySet);

impl KeySource for FixedKeys {
    fn fetch(&self) -> Fetched<'_> {
        let set = self.0.clone();
        Box::pin(async move { Ok(set) })
    }
}

/// What the fake maker's token endpoint was sent, for checking how the cloud authenticated.
#[derive(Default, Clone)]
pub struct Sent {
    pub forms: Vec<Vec<(String, String)>>,
    pub authorizations: Vec<Option<String>>,
}

/// The fake maker: `code-1` exchanges for `access-1`/`refresh-1` when the verifier and the
/// client's secret are right; `refresh-1` refreshes to `access-2`; anything else is refused.
async fn token(
    State(sent): State<Arc<Mutex<Sent>>>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    let form: Vec<(String, String)> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    let field = |name: &str| {
        form.iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    let authorization = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    {
        let mut sent = sent.lock().unwrap_or_else(|p| p.into_inner());
        sent.forms.push(form.clone());
        sent.authorizations.push(authorization.clone());
    }
    let basic = format!(
        "Basic {}",
        STANDARD.encode(format!("cloud-client:{SECRET}"))
    );
    let authenticated =
        field("client_secret") == SECRET || authorization.as_deref() == Some(&basic);
    let refused = (
        StatusCode::BAD_REQUEST,
        axum::Json(serde_json::json!({"error": "invalid_grant"})),
    )
        .into_response();
    if !authenticated {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "invalid_client"})),
        )
            .into_response();
    }
    match field("grant_type").as_str() {
        "authorization_code"
            if field("code") == "code-1"
                && URL_SAFE_NO_PAD.encode(digest(&SHA256, field("code_verifier").as_bytes()))
                    == URL_SAFE_NO_PAD.encode(digest(&SHA256, VERIFIER.as_bytes())) =>
        {
            axum::Json(serde_json::json!({
                "access_token": "access-1", "refresh_token": "refresh-1", "expires_in": 3600,
                "token_type": "Bearer", "user": {"email": "person@example.com"}
            }))
            .into_response()
        }
        "refresh_token" if field("refresh_token") == "refresh-1" => axum::Json(
            serde_json::json!({"access_token": "access-2", "expires_in": 3600, "token_type": "Bearer"}),
        )
        .into_response(),
        _ => refused,
    }
}

pub struct Cloud {
    pub url: String,
    pub service: Arc<Service>,
    pub clock: Arc<AtomicI64>,
    pub sent: Arc<Mutex<Sent>>,
    key: Arc<Ed25519KeyPair>,
    pub http: reqwest::Client,
}

pub struct Options {
    pub budget: Budget,
    /// `asana` signs in with `client_secret_post`, `box` with Basic; `canva` has no client set.
    pub apps: Vec<&'static str>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            budget: Setup::ACCOUNT_BUDGET,
            apps: vec!["asana", "box", "canva"],
        }
    }
}

async fn listen(router: Router) -> Result<SocketAddr> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(fail)?;
    let address = listener.local_addr().map_err(fail)?;
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(address)
}

impl Cloud {
    pub async fn start(options: Options) -> Result<Self> {
        let sent = Arc::new(Mutex::new(Sent::default()));
        let maker = listen(
            Router::new()
                .route("/token", post(token))
                .with_state(sent.clone()),
        )
        .await?;
        let seed = [7u8; 32];
        let key = Arc::new(Ed25519KeyPair::from_seed_unchecked(&seed).map_err(fail)?);
        let keys = KeySet {
            keys: vec![PublishedKey {
                id: "k1".into(),
                public_key: URL_SAFE_NO_PAD.encode(key.public_key().as_ref()),
            }],
        };
        let app = |id: &str, auth: ClientAuth| App {
            id: id.into(),
            name: id.into(),
            issuer: ISSUER.into(),
            authorization_endpoint: "https://auth.maker.example/authorize?prompt=consent".into(),
            token_endpoint: format!("http://{maker}/token"),
            client_auth: auth,
            scopes: vec!["default".into(), "write".into()],
            resource: format!("https://mcp.maker.example/{id}"),
            client_id_env: "ID".into(),
            client_secret_env: "SECRET".into(),
        };
        let client = || {
            Some(Client {
                id: "cloud-client".into(),
                secret: SECRET.into(),
            })
        };
        let apps = options
            .apps
            .iter()
            .map(|id| match *id {
                "box" => Configured {
                    app: app(id, ClientAuth::ClientSecretBasic),
                    client: client(),
                },
                "canva" => Configured {
                    app: app(id, ClientAuth::ClientSecretBasic),
                    client: None,
                },
                _ => Configured {
                    app: app(id, ClientAuth::ClientSecretPost),
                    client: client(),
                },
            })
            .collect();
        let clock = Arc::new(AtomicI64::new(NOW));
        let read = clock.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(fail)?;
        let address = listener.local_addr().map_err(fail)?;
        let url = format!("http://{address}");
        let service = Service::new(Setup {
            apps,
            public_url: url.clone(),
            keys: Arc::new(FixedKeys(keys)),
            clock: Arc::new(move || read.load(Ordering::SeqCst)),
            random: Arc::new(ring::rand::SystemRandom::new()),
            address_header: None,
            maker_timeout: Duration::from_secs(5),
            account_budget: options.budget,
            address_budget: Setup::ADDRESS_BUDGET,
        });
        let serving = service.clone();
        tokio::spawn(async move {
            let _ = spade_cloud::serve(listener, serving, std::future::pending()).await;
        });
        Ok(Self {
            url,
            service,
            clock,
            sent,
            key,
            http: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(fail)?,
        })
    }

    pub fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    /// A grant signed by the account backend's key.
    pub fn grant(&self, account: &str, kind: &str) -> String {
        let now = self.clock.load(Ordering::SeqCst);
        self.grant_with(account, kind, now, now + 300_000)
    }

    pub fn grant_with(&self, account: &str, kind: &str, iat: i64, exp: i64) -> String {
        let claims = serde_json::json!({
            "v": 1, "kid": "k1", "kind": kind, "account": account,
            "subject": "h".repeat(43), "iat": iat, "exp": exp,
        })
        .to_string();
        let signature = self.key.sign(claims.as_bytes());
        format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(claims.as_bytes()),
            URL_SAFE_NO_PAD.encode(signature.as_ref())
        )
    }

    pub async fn post(
        &self,
        path: &str,
        grant: Option<&str>,
        body: serde_json::Value,
    ) -> Result<(u16, serde_json::Value)> {
        let mut request = self.http.post(format!("{}{path}", self.url)).json(&body);
        if let Some(grant) = grant {
            request = request.bearer_auth(grant);
        }
        let response = request.send().await.map_err(fail)?;
        let status = response.status().as_u16();
        let body = response.json().await.unwrap_or(serde_json::Value::Null);
        Ok((status, body))
    }

    /// Starts a sign-in for `account`; returns the answer and Spade's key.
    pub async fn begin(&self, app: &str, account: &str) -> Result<(Started, OneTimeKey)> {
        let key = OneTimeKey::generate(&ring::rand::SystemRandom::new()).map_err(fail)?;
        let (status, body) = self
            .post(
                &format!("/v1/oauth/{app}/start"),
                Some(&self.grant(account, "machine")),
                serde_json::json!({
                    "code_challenge": URL_SAFE_NO_PAD.encode(digest(&SHA256, VERIFIER.as_bytes())),
                    "public_key": key.public_key(),
                }),
            )
            .await?;
        if status != 200 {
            return Err(format!("start answered {status}: {body}"));
        }
        let url =
            url::Url::parse(body["authorization_url"].as_str().unwrap_or("")).map_err(fail)?;
        let query = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
                .unwrap_or_default()
        };
        Ok((
            Started {
                sign_in: body["sign_in"].as_str().unwrap_or("").to_owned(),
                state: query("state"),
                url: url.clone(),
            },
            key,
        ))
    }

    /// The person's browser coming back from the maker.
    pub async fn callback(&self, query: &[(&str, &str)]) -> Result<(u16, String)> {
        let response = self
            .http
            .get(format!("{}/v1/oauth/callback", self.url))
            .query(query)
            .send()
            .await
            .map_err(fail)?;
        Ok((
            response.status().as_u16(),
            response.text().await.map_err(fail)?,
        ))
    }

    pub async fn finish(
        &self,
        app: &str,
        account: &str,
        sign_in: &str,
        verifier: &str,
    ) -> Result<(u16, serde_json::Value)> {
        self.post(
            &format!("/v1/oauth/{app}/finish"),
            Some(&self.grant(account, "machine")),
            serde_json::json!({"sign_in": sign_in, "code_verifier": verifier}),
        )
        .await
    }
}

pub struct Started {
    pub sign_in: String,
    pub state: String,
    pub url: url::Url,
}

/// Everything the service logs while it lives, as JSON lines.
#[derive(Clone, Default)]
pub struct Logs(Arc<Mutex<Vec<u8>>>);

impl Logs {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap_or_else(|p| p.into_inner())).into_owned()
    }
}

impl Write for Logs {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Captures the logs of everything on this thread (tests run on a current-thread runtime).
pub fn capture_logs() -> (Logs, tracing::subscriber::DefaultGuard) {
    let logs = Logs::default();
    let writer = logs.clone();
    let subscriber = tracing_subscriber::fmt()
        .json()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    (logs, tracing::subscriber::set_default(subscriber))
}
