//! OAuth client ID metadata documents (draft-ietf-oauth-client-id-metadata-document) for the
//! fake app: [`ClientDocument`] hosts one on 127.0.0.1, standing in for acehq.dev, and
//! [`fetch_and_check`] is what the fake authorization server does with a URL client ID: fetch
//! it without following redirects, insist on 200 and JSON, the document's `client_id` equal to
//! its address, no shared secret, and the redirect among `redirect_uris` (loopback with any
//! port, RFC 8252 section 7.3).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::http::{StatusCode, header};
use axum::response::IntoResponse;
use axum::routing::get;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

/// The path the document is served at, as on acehq.dev.
pub const DOCUMENT_PATH: &str = "/oauth/spade.json";

/// A document host on 127.0.0.1.
pub struct ClientDocument {
    body: Arc<Mutex<String>>,
    addr: SocketAddr,
    stop: CancellationToken,
}

impl ClientDocument {
    /// Serves nothing (404) until [`ClientDocument::serve`].
    pub async fn start() -> Self {
        let body = Arc::new(Mutex::new(String::new()));
        let served = body.clone();
        let app = axum::Router::new().route(
            DOCUMENT_PATH,
            get(move || {
                let body = lock(&served).clone();
                async move {
                    if body.is_empty() {
                        return StatusCode::NOT_FOUND.into_response();
                    }
                    ([(header::CONTENT_TYPE, "application/json")], body).into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|e| panic!("bind: {e}"));
        let addr = listener
            .local_addr()
            .unwrap_or_else(|e| panic!("addr: {e}"));
        let stop = CancellationToken::new();
        let stopping = stop.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move { stopping.cancelled().await })
                .await;
        });
        Self { body, addr, stop }
    }

    /// The document's address: the client ID.
    pub fn url(&self) -> String {
        format!("http://{}{DOCUMENT_PATH}", self.addr)
    }

    pub fn serve(&self, document: &Value) {
        *lock(&self.body) = document.to_string();
    }
}

impl Drop for ClientDocument {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Fetches the document at `client_id` and checks it allows `redirect`. `Err` says why not.
pub async fn fetch_and_check(client_id: &str, redirect: &str) -> Result<(), String> {
    let (status, body) = get_once(client_id).await?;
    if status != 200 {
        return Err(format!("the document answered {status}"));
    }
    let document: Value = serde_json::from_str(&body).map_err(|_| "not JSON".to_owned())?;
    if document["client_id"].as_str() != Some(client_id) {
        return Err("client_id is not the document's address".into());
    }
    if document["client_name"].as_str().is_none_or(str::is_empty) {
        return Err("no client_name".into());
    }
    if document.get("client_secret").is_some()
        || document["token_endpoint_auth_method"].as_str() != Some("none")
    {
        return Err("a metadata document client must be public".into());
    }
    let allowed = document["redirect_uris"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|listed| redirect_matches(listed, redirect));
    if !allowed {
        return Err(format!("{redirect} is not a listed redirect"));
    }
    Ok(())
}

/// Exact string match, except that a loopback IP address may carry any port.
pub fn redirect_matches(listed: &str, asked: &str) -> bool {
    match (without_loopback_port(listed), without_loopback_port(asked)) {
        (Some(listed), Some(asked)) => listed == asked,
        _ => listed == asked,
    }
}

/// `http://127.0.0.1:4555/x` → `http://127.0.0.1/x`; `None` when not an http loopback IP.
fn without_loopback_port(uri: &str) -> Option<String> {
    for host in ["http://127.0.0.1", "http://[::1]"] {
        if let Some(rest) = uri.strip_prefix(host) {
            let rest = match rest.strip_prefix(':') {
                Some(after) => {
                    let digits = after.bytes().take_while(u8::is_ascii_digit).count();
                    if digits == 0 {
                        return None;
                    }
                    &after[digits..]
                }
                None => rest,
            };
            if rest.is_empty() || rest.starts_with('/') {
                return Some(format!("{host}{rest}"));
            }
        }
    }
    None
}

/// One GET, never following a redirect: the status and body.
async fn get_once(address: &str) -> Result<(u16, String), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = address.strip_prefix("http://").ok_or("not http")?;
    let (host, path) = rest.split_once('/').ok_or("no path")?;
    let mut stream = tokio::net::TcpStream::connect(host)
        .await
        .map_err(|e| e.to_string())?;
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut answer = String::new();
    stream
        .read_to_string(&mut answer)
        .await
        .map_err(|e| e.to_string())?;
    let (head, body) = answer.split_once("\r\n\r\n").ok_or("no body")?;
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no status")?;
    Ok((status, body.to_owned()))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
