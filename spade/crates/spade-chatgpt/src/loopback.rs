//! The loopback address a browser sign-in comes back to: `http://127.0.0.1:<port>/auth/callback`
//! on the machine Spade runs on. It answers the one request that carries this sign-in's `state`,
//! and nothing else: any other path, or a code with another state, is turned away and waited past.

use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Semaphore;

/// The path OpenAI sends the browser back to.
pub const PATH: &str = "/auth/callback";

/// The most of a request read.
const MOST_REQUEST: usize = 16 * 1024;

/// The address the sign-in is sent back to, for a listener on `port`.
pub fn redirect(port: u16) -> String {
    format!("http://127.0.0.1:{port}{PATH}")
}

/// Listens on `127.0.0.1:port`. Fails when the port is taken (another sign-in, or Codex's own).
pub async fn bind(port: u16) -> Result<TcpListener, String> {
    TcpListener::bind(("127.0.0.1", port)).await.map_err(|_| {
        format!(
            "port {port} on this computer is in use (another sign-in may be open); close it, or \
             sign in with a code instead"
        )
    })
}

/// How many connections are read at once; more wait to be accepted.
const AT_ONCE: usize = 8;

/// How long one connection may take to send its request line.
const READ_WAIT: Duration = Duration::from_secs(5);

/// Waits for the browser to come back with this sign-in's `state`: the code, or why the person
/// or the server stopped it. Each connection is read on its own, so one that stalls never holds
/// up the real callback; the listener closes once one answers.
pub async fn wait(listener: TcpListener, state: &str) -> Result<String, String> {
    let (tx, mut rx) = tokio::sync::mpsc::channel(1);
    let slots = Arc::new(Semaphore::new(AT_ONCE));
    let state: Arc<str> = Arc::from(state);
    loop {
        tokio::select! {
            outcome = rx.recv() => {
                return outcome.unwrap_or_else(|| Err("the sign-in stopped".to_owned()));
            }
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                // Too many open at once: this one is turned away; the browser tries again.
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let (tx, state) = (tx.clone(), state.clone());
                tokio::spawn(async move {
                    let _slot = slot;
                    if let Some(outcome) = answer(stream, &state).await {
                        let _ = tx.send(outcome).await;
                    }
                });
            }
        }
    }
}

/// Reads one request and answers it. `None` when it was not this sign-in's callback.
async fn answer(mut stream: TcpStream, state: &str) -> Option<Result<String, String>> {
    let target = tokio::time::timeout(READ_WAIT, request_target(&mut stream))
        .await
        .ok()
        .flatten()?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != PATH {
        respond(&mut stream, "404 Not Found", "Not here.").await;
        return None;
    }
    let query = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if query("state").as_deref() != Some(state) {
        respond(
            &mut stream,
            "400 Bad Request",
            "This is not the sign-in Spade started.",
        )
        .await;
        return None;
    }
    if let Some(error) = query("error") {
        respond(
            &mut stream,
            "200 OK",
            "Sign-in stopped. You can close this tab.",
        )
        .await;
        let error: String = error
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(60)
            .collect();
        return Some(Err(format!("OpenAI's sign-in stopped ({error})")));
    }
    let code = query("code").filter(|c| !c.is_empty())?;
    respond(
        &mut stream,
        "200 OK",
        "Signed in to Spade. You can close this tab.",
    )
    .await;
    Some(Ok(code))
}

/// The request line's target (`/auth/callback?…`).
async fn request_target(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buffer.windows(2).any(|w| w == b"\r\n") {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 || buffer.len() > MOST_REQUEST {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    let line = String::from_utf8_lossy(&buffer);
    let mut parts = line.lines().next()?.split(' ');
    (parts.next()? == "GET").then_some(())?;
    let target = parts.next()?;
    target.starts_with('/').then(|| target.to_owned())
}

async fn respond(stream: &mut TcpStream, status: &str, words: &str) {
    let body = format!(
        "<!doctype html><meta charset=utf-8><title>Spade</title>\
         <body style=\"font:16px system-ui;margin:4rem\"><p>{words}</p></body>"
    );
    let reply = format!(
        "HTTP/1.1 {status}\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: {}\r\n\
         cache-control: no-store\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    // The browser may have gone; the sign-in goes on regardless.
    let _ = stream.write_all(reply.as_bytes()).await;
    let _ = stream.shutdown().await;
}
