//! One authenticated daemon WebSocket: hello, then requests matched to answers by `requestId`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::wire::{self, Incoming, Operation};
use super::{SkillErrorCode, SkillsConfig, SkillsError};
use crate::secret::Secret;

/// The daemon closes a socket whose credential it refused with these (`apps/daemon/src/server.ts`).
const REFUSED_CLOSE_CODES: [u16; 2] = [4001, 4003];

type Waiter = oneshot::Sender<Result<Value, SkillsError>>;
/// `None` once the socket closed.
type Pending = Option<HashMap<String, Waiter>>;
type Waiters = Arc<Mutex<Pending>>;

#[derive(Clone)]
pub(super) struct Socket {
    outgoing: mpsc::UnboundedSender<Message>,
    /// `None` once the socket closed: every waiter has been answered and no new one is taken.
    waiters: Waiters,
    token: Secret,
}

impl Socket {
    pub(super) async fn open(config: &SkillsConfig) -> Result<Self, SkillsError> {
        tokio::time::timeout(config.timeout, Self::handshake(config))
            .await
            .map_err(|_| SkillsError::Timeout)?
    }

    async fn handshake(config: &SkillsConfig) -> Result<Self, SkillsError> {
        let token = config.token.clone();
        let (mut stream, _) = tokio_tungstenite::connect_async(config.url.as_str())
            .await
            .map_err(|error| SkillsError::Unreachable(token.scrub(error.to_string())))?;
        let hello = serde_json::to_string(&wire::Hello {
            kind: "hello",
            protocol_version: 1,
            device_id: &config.device_id,
            token: token.expose(),
        })
        .map_err(|error| SkillsError::Protocol(error.to_string()))?;
        stream
            .send(Message::text(hello))
            .await
            .map_err(|error| SkillsError::Unreachable(token.scrub(error.to_string())))?;
        // Before `welcome` the daemon may send `starting`; a refusal is an `error`, then a close.
        loop {
            let frame = stream.next().await;
            match frame {
                Some(Ok(Message::Text(text))) => match serde_json::from_str::<Incoming>(&text) {
                    Ok(Incoming::Welcome) => break,
                    Ok(Incoming::Error(error)) if error.code == "unauthorized" => {
                        return Err(SkillsError::Refused);
                    }
                    Ok(Incoming::Error(error)) => {
                        return Err(SkillsError::Unreachable(
                            token.scrub(format!("{}: {}", error.code, error.message)),
                        ));
                    }
                    _ => {}
                },
                Some(Ok(Message::Close(frame))) => {
                    return Err(closed(frame.map(|f| u16::from(f.code)), &token));
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    return Err(SkillsError::Unreachable(token.scrub(error.to_string())));
                }
                None => return Err(closed(None, &token)),
            }
        }
        let (outgoing, rx) = mpsc::unbounded_channel();
        let waiters: Waiters = Arc::new(Mutex::new(Some(HashMap::new())));
        tokio::spawn(run(stream, rx, waiters.clone(), token.clone()));
        Ok(Self {
            outgoing,
            waiters,
            token,
        })
    }

    pub(super) fn is_open(&self) -> bool {
        !self.outgoing.is_closed() && lock(&self.waiters).is_some()
    }

    pub(super) fn same(&self, other: &Socket) -> bool {
        Arc::ptr_eq(&self.waiters, &other.waiters)
    }

    pub(super) async fn request(
        &self,
        request_id: &str,
        operation: &Operation<'_>,
        timeout: Duration,
    ) -> Result<Value, SkillsError> {
        let frame = serde_json::to_string(&wire::SkillsRequest {
            kind: "skills.request",
            request_id,
            operation: *operation,
        })
        .map_err(|error| SkillsError::Protocol(error.to_string()))?;
        let (tx, rx) = oneshot::channel();
        match lock(&self.waiters).as_mut() {
            Some(waiters) => waiters.insert(request_id.to_owned(), tx),
            None => return Err(SkillsError::Unreachable("the socket closed".into())),
        };
        if self.outgoing.send(Message::text(frame)).is_err() {
            self.forget(request_id);
            return Err(SkillsError::Unreachable("the socket closed".into()));
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(SkillsError::Unreachable(
                self.token.scrub("the socket closed before the answer"),
            )),
            Err(_) => {
                self.forget(request_id);
                Err(SkillsError::Timeout)
            }
        }
    }

    fn forget(&self, request_id: &str) {
        if let Some(waiters) = lock(&self.waiters).as_mut() {
            waiters.remove(request_id);
        }
    }
}

/// Owns the socket: writes queued frames, routes answers to their waiters, and on close answers
/// every waiter left.
async fn run<S>(
    mut stream: tokio_tungstenite::WebSocketStream<S>,
    mut rx: mpsc::UnboundedReceiver<Message>,
    waiters: Waiters,
    token: Secret,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let ending = loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(message) => {
                    if let Err(error) = stream.send(message).await {
                        break SkillsError::Unreachable(token.scrub(error.to_string()));
                    }
                }
                // Every `AceSkills` handle to this socket is gone.
                None => {
                    let _ = stream.close(None).await;
                    break SkillsError::Unreachable("the socket closed".into());
                }
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => route(&text, &waiters, &token),
                Some(Ok(Message::Close(frame))) => {
                    break closed(frame.map(|f| u16::from(f.code)), &token);
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => break SkillsError::Unreachable(token.scrub(error.to_string())),
                None => break closed(None, &token),
            },
        }
    };
    let left = lock(&waiters).take().unwrap_or_default();
    for (_, waiter) in left {
        let _ = waiter.send(Err(ending.clone()));
    }
}

fn route(text: &str, waiters: &Waiters, token: &Secret) {
    let (request_id, answer) = match serde_json::from_str::<Incoming>(text) {
        Ok(Incoming::SkillsResult(result)) => (result.request_id, Ok(result.result)),
        // The daemon rejects a malformed request with a plain `error` naming its request.
        Ok(Incoming::Error(error)) => match error.request_id {
            Some(id) => (
                id,
                Err(SkillsError::Daemon {
                    code: SkillErrorCode::parse(&error.code),
                    message: token.scrub(error.message),
                }),
            ),
            None => return,
        },
        _ => return,
    };
    let waiter = lock(waiters)
        .as_mut()
        .and_then(|waiters| waiters.remove(&request_id));
    if let Some(waiter) = waiter {
        let _ = waiter.send(answer);
    }
}

fn closed(code: Option<u16>, token: &Secret) -> SkillsError {
    match code {
        Some(code) if REFUSED_CLOSE_CODES.contains(&code) => SkillsError::Refused,
        Some(code) => {
            SkillsError::Unreachable(token.scrub(format!("the daemon closed the socket ({code})")))
        }
        None => SkillsError::Unreachable("the daemon closed the socket".into()),
    }
}

fn lock(waiters: &Waiters) -> std::sync::MutexGuard<'_, Pending> {
    waiters
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
