// SPDX-License-Identifier: Apache-2.0
//! Producers' connections: the ingest socket and the loopback WebSocket. Until its hello is
//! accepted a connection holds one of a few pending slots, has [`HELLO_WITHIN`] to present it,
//! and may send only the bytes a hello needs. The token is read into wiped buffers and handed
//! to the engine, which decides whether the connection stays; after that each connection is a
//! task that reads whole `MediaFrame`s.
use super::budget::{Budget, Cap, Slot};
use crate::engine::sources::IngestId;
use crate::framing::{
    HELLO_MAX, MEDIA_HEADER_MAX, MEDIA_PAYLOAD_MAX, TOKEN_LEN, hello_token, read_hello, read_media,
};
use futures_util::StreamExt;
use media_wire::frame::MediaFrame;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::net::{TcpListener, UnixListener};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Bytes, Message};
use zeroize::{Zeroize, Zeroizing};

/// The video extension's id (`packages/browser/src/video-extension.ts`) and the desktop app's
/// encoder page: the only pages that may stream into the WebSocket. A native client can send
/// any `Origin`, so this only keeps web pages out; the token is what admits a producer.
pub const ALLOWED_ORIGINS: [&str; 2] = [
    "chrome-extension://ldgefbphhfgphnecebnomhhopapknllk",
    "app://video-encoder",
];
/// From accept to an accepted hello (the WebSocket handshake included).
pub const HELLO_WITHIN: Duration = Duration::from_secs(2);
/// Producer connections at once, and how many of them may still be unauthenticated.
pub const MAX_CONNECTIONS: usize = 64;
pub const MAX_PENDING: usize = 16;
/// What a WebSocket client may send before its hello is accepted: the upgrade request and one
/// masked message carrying the largest hello.
const WEBSOCKET_BUDGET: usize = 8 * 1024 + 14 + HELLO_MAX;

pub type Token = Zeroizing<[u8; TOKEN_LEN]>;

pub enum IngestEvent {
    /// A hello to check. Answer on `admit`; once admitted, firing or dropping `close` closes
    /// the connection.
    Hello {
        id: IngestId,
        token: Token,
        admit: oneshot::Sender<bool>,
        close: oneshot::Sender<()>,
    },
    Frame(IngestId, MediaFrame),
    /// Sent once for every admitted connection when it ends.
    Closed(IngestId),
}

#[derive(Clone)]
pub struct Ingest {
    ids: Arc<AtomicU64>,
    events: mpsc::Sender<IngestEvent>,
    connections: Cap,
    pending: Cap,
}

impl Ingest {
    pub fn new(events: mpsc::Sender<IngestEvent>) -> Self {
        Self {
            ids: Arc::new(AtomicU64::new(1)),
            events,
            connections: Cap::new(MAX_CONNECTIONS),
            pending: Cap::new(MAX_PENDING),
        }
    }

    /// Slots for a new connection, taken before anything is spawned for it.
    fn admit_slots(&self) -> Option<(Slot, Slot)> {
        let pending = self.pending.take()?;
        Some((self.connections.take()?, pending))
    }

    /// Presents a hello to the engine. The receiver that closes the connection, if admitted.
    async fn present(&self, id: IngestId, token: Token) -> Option<oneshot::Receiver<()>> {
        let (admit, admitted) = oneshot::channel();
        let (close, closed) = oneshot::channel();
        let hello = IngestEvent::Hello {
            id,
            token,
            admit,
            close,
        };
        self.events.send(hello).await.ok()?;
        matches!(admitted.await, Ok(true)).then_some(closed)
    }

    async fn closed(&self, id: IngestId) {
        let _ = self.events.send(IngestEvent::Closed(id)).await;
    }
}

pub fn serve_socket(listener: UnixListener, ingest: Ingest) {
    tokio::spawn(async move {
        loop {
            let Ok((mut stream, _)) = listener.accept().await else {
                continue;
            };
            let Some((slot, pending)) = ingest.admit_slots() else {
                continue;
            };
            let ingest = ingest.clone();
            tokio::spawn(async move {
                let _slot = slot;
                let id = ingest.ids.fetch_add(1, Ordering::Relaxed);
                // The engine answers a hello at once, so only reading it has a deadline.
                let hello = tokio::time::timeout(HELLO_WITHIN, read_hello(&mut stream)).await;
                let Ok(Ok(token)) = hello else {
                    return;
                };
                let Some(mut close) = ingest.present(id, token).await else {
                    return;
                };
                drop(pending);
                loop {
                    tokio::select! {
                        _ = &mut close => break,
                        frame = read_media(&mut stream) => match frame {
                            Ok(Some(frame)) => {
                                if ingest.events.send(IngestEvent::Frame(id, frame)).await.is_err() {
                                    return;
                                }
                            }
                            _ => break,
                        },
                    }
                }
                ingest.closed(id).await;
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

/// The token of a WebSocket hello message, wiping the message's bytes. When the library
/// still shares the buffer it can't be wiped here; its read buffer is reused for the next
/// message.
fn websocket_token(bytes: Bytes) -> Option<Token> {
    match bytes.try_into_mut() {
        Ok(mut owned) => {
            let token = hello_token(&owned);
            owned.as_mut().zeroize();
            token
        }
        Err(shared) => hello_token(&shared),
    }
}

pub fn serve_websocket(listener: TcpListener, ingest: Ingest) {
    let limit = MEDIA_HEADER_MAX + MEDIA_PAYLOAD_MAX;
    let config = WebSocketConfig::default()
        .max_message_size(Some(limit))
        .max_frame_size(Some(limit));
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let Some((slot, pending)) = ingest.admit_slots() else {
                continue;
            };
            let ingest = ingest.clone();
            tokio::spawn(async move {
                let _slot = slot;
                let id = ingest.ids.fetch_add(1, Ordering::Relaxed);
                let hello = tokio::time::timeout(HELLO_WITHIN, async {
                    let stream = Budget::new(stream, WEBSOCKET_BUDGET);
                    let handshake = tokio_tungstenite::accept_hdr_async_with_config(
                        stream,
                        admit,
                        Some(config),
                    );
                    let mut socket = handshake.await.ok()?;
                    let Some(Ok(Message::Binary(bytes))) = socket.next().await else {
                        return None;
                    };
                    Some((socket, websocket_token(bytes)?))
                });
                let Ok(Some((mut socket, token))) = hello.await else {
                    return;
                };
                let Some(mut close) = ingest.present(id, token).await else {
                    return;
                };
                socket.get_mut().lift();
                drop(pending);
                loop {
                    let message = tokio::select! {
                        _ = &mut close => break,
                        message = socket.next() => message,
                    };
                    let frame = match message {
                        Some(Ok(Message::Binary(bytes))) => MediaFrame::decode(&bytes).ok(),
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                        _ => None,
                    };
                    let Some(frame) = frame else { break };
                    if ingest
                        .events
                        .send(IngestEvent::Frame(id, frame))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                ingest.closed(id).await;
            });
        }
    });
}
