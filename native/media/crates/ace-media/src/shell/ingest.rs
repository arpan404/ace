// SPDX-License-Identifier: Apache-2.0
//! Producers' connections: the ingest socket and the loopback WebSocket. Each connection is a
//! task that reads whole `MediaFrame`s and hands them to the engine; the engine decides, from
//! the hello, whether it stays open.
use crate::engine::sources::IngestId;
use crate::framing::{MEDIA_HEADER_MAX, MEDIA_PAYLOAD_MAX, read_media};
use futures_util::StreamExt;
use media_wire::frame::MediaFrame;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

/// The video extension's id (`packages/browser/src/video-extension.ts`) and the desktop app's
/// encoder page: the only pages that may stream into the WebSocket.
pub const ALLOWED_ORIGINS: [&str; 2] = [
    "chrome-extension://ldgefbphhfgphnecebnomhhopapknllk",
    "app://video-encoder",
];

pub enum IngestEvent {
    /// A connection opened; dropping or firing the sender closes it.
    Opened(IngestId, oneshot::Sender<()>),
    Frame(IngestId, MediaFrame),
    Closed(IngestId),
}

pub type Ids = Arc<AtomicU64>;

async fn open(
    ids: &Ids,
    events: &mpsc::Sender<IngestEvent>,
) -> Option<(IngestId, oneshot::Receiver<()>)> {
    let id = ids.fetch_add(1, Ordering::Relaxed);
    let (close, closed) = oneshot::channel();
    events.send(IngestEvent::Opened(id, close)).await.ok()?;
    Some((id, closed))
}

pub fn serve_socket(listener: UnixListener, ids: Ids, events: mpsc::Sender<IngestEvent>) {
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let Some((id, mut closed)) = open(&ids, &events).await else {
                return;
            };
            let events = events.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        _ = &mut closed => return,
                        frame = read_media(&mut stream) => match frame {
                            Ok(Some(frame)) => {
                                if events.send(IngestEvent::Frame(id, frame)).await.is_err() {
                                    return;
                                }
                            }
                            _ => {
                                let _ = events.send(IngestEvent::Closed(id)).await;
                                return;
                            }
                        },
                    }
                }
            });
        }
    });
}

/// The WebSocket handshake: only `/ingest`, only from an allowed origin.
#[allow(clippy::result_large_err)]
fn admit(request: &Request, response: Response) -> Result<Response, ErrorResponse> {
    let origin = request
        .headers()
        .get("origin")
        .and_then(|o| o.to_str().ok());
    if request.uri().path() == "/ingest" && origin.is_some_and(|o| ALLOWED_ORIGINS.contains(&o)) {
        return Ok(response);
    }
    let mut refusal = ErrorResponse::new(None);
    *refusal.status_mut() = StatusCode::FORBIDDEN;
    Err(refusal)
}

pub fn serve_websocket(listener: TcpListener, ids: Ids, events: mpsc::Sender<IngestEvent>) {
    let limit = MEDIA_HEADER_MAX + MEDIA_PAYLOAD_MAX;
    let config = WebSocketConfig::default()
        .max_message_size(Some(limit))
        .max_frame_size(Some(limit));
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let ids = ids.clone();
            let events = events.clone();
            tokio::spawn(async move {
                let handshake =
                    tokio_tungstenite::accept_hdr_async_with_config(stream, admit, Some(config));
                let Ok(mut socket) = handshake.await else {
                    return;
                };
                let Some((id, mut closed)) = open(&ids, &events).await else {
                    return;
                };
                loop {
                    let message = tokio::select! {
                        _ = &mut closed => return,
                        message = socket.next() => message,
                    };
                    let frame = match message {
                        Some(Ok(Message::Binary(bytes))) => MediaFrame::decode(&bytes).ok(),
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                        _ => None,
                    };
                    let Some(frame) = frame else {
                        let _ = events.send(IngestEvent::Closed(id)).await;
                        return;
                    };
                    if events.send(IngestEvent::Frame(id, frame)).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
}
