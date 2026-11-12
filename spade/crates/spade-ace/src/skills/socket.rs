//! One authenticated daemon WebSocket: hello, then requests matched to answers by `requestId`.
//!
//! The socket is owned by one task. It writes queued frames, routes answers and answers every
//! waiter when the socket ends. Writes have a deadline, the queue and the waiters are bounded,
//! and dropping the last handle stops the task even in the middle of a stuck write.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use super::wire::{self, Incoming, Operation};
use super::{SkillErrorCode, SkillsConfig, SkillsError};
use spade_mcp::Secret;

/// The daemon closes a socket whose credential it refused with these (`apps/daemon/src/server.ts`).
const REFUSED_CLOSE_CODES: [u16; 2] = [4001, 4003];
/// Frames waiting to be written. A full queue means the daemon stopped reading.
const MOST_QUEUED: usize = 32;
/// Requests waiting for an answer at once.
const MOST_PENDING: usize = 256;
/// How long a closing socket waits for its close frame to go out.
const CLOSE_GRACE: Duration = Duration::from_secs(1);

type Waiter = oneshot::Sender<Result<Value, SkillsError>>;
/// `None` once the socket closed: every waiter has been answered and no new one is taken.
type Pending = Option<HashMap<String, Waiter>>;
type Waiters = Arc<Mutex<Pending>>;

#[derive(Clone)]
pub(super) struct Socket {
    outgoing: mpsc::Sender<Message>,
    waiters: Waiters,
    token: Secret,
    /// Shared by every handle; the last one dropped stops the task.
    _owner: Arc<Owner>,
}

struct Owner {
    stop: Arc<Notify>,
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.stop.notify_one();
    }
}

impl Socket {
    pub(super) async fn open(config: &SkillsConfig) -> Result<Self, SkillsError> {
        tokio::time::timeout(config.timeout(), Self::handshake(config))
            .await
            .map_err(|_| SkillsError::Timeout)?
    }

    async fn handshake(config: &SkillsConfig) -> Result<Self, SkillsError> {
        let token = config.token().clone();
        let unreachable = |error: &dyn std::fmt::Display| {
            SkillsError::Unreachable(token.scrub(error.to_string()))
        };
        let (mut stream, _) = tokio_tungstenite::connect_async(config.url().as_str())
            .await
            .map_err(|error| unreachable(&error))?;
        let hello = serde_json::to_string(&wire::Hello::new(config.device_id(), &token))
            .map_err(|error| unreachable(&error))?;
        stream
            .send(Message::text(hello))
            .await
            .map_err(|error| unreachable(&error))?;
        // Before `welcome` the daemon may send `starting`; a refusal is an `error`, then a close.
        loop {
            match stream.next().await {
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
                Some(Err(error)) => return Err(unreachable(&error)),
                None => return Err(closed(None, &token)),
            }
        }
        let (outgoing, rx) = mpsc::channel(MOST_QUEUED);
        let waiters: Waiters = Arc::new(Mutex::new(Some(HashMap::new())));
        let stop = Arc::new(Notify::new());
        tokio::spawn(run(
            stream,
            rx,
            waiters.clone(),
            Task {
                token: token.clone(),
                stop: stop.clone(),
                timeout: config.timeout(),
            },
        ));
        Ok(Self {
            outgoing,
            waiters,
            token,
            _owner: Arc::new(Owner { stop }),
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
        .map_err(|error| SkillsError::Unreachable(error.to_string()))?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = lock(&self.waiters);
            let Some(waiters) = pending.as_mut() else {
                return Err(SkillsError::Unreachable("the socket closed".into()));
            };
            if waiters.len() >= MOST_PENDING {
                return Err(SkillsError::Backlogged);
            }
            waiters.insert(request_id.to_owned(), tx);
        }
        // From here on, however this future ends (answer, error, timeout or being dropped),
        // the waiter is removed.
        let _forget = Forget {
            waiters: &self.waiters,
            request_id,
        };
        match self.outgoing.try_send(Message::text(frame)) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => return Err(SkillsError::Backlogged),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                return Err(SkillsError::Unreachable("the socket closed".into()));
            }
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err(SkillsError::Unreachable(
                self.token.scrub("the socket closed before the answer"),
            )),
            Err(_) => Err(SkillsError::Timeout),
        }
    }
}

/// Removes a request's waiter when the request ends, including when its future is dropped.
struct Forget<'a> {
    waiters: &'a Waiters,
    request_id: &'a str,
}

impl Drop for Forget<'_> {
    fn drop(&mut self) {
        if let Some(waiters) = lock(self.waiters).as_mut() {
            waiters.remove(self.request_id);
        }
    }
}

struct Task {
    token: Secret,
    stop: Arc<Notify>,
    timeout: Duration,
}

/// Owns the socket until the daemon closes it, a write misses its deadline, or Spade drops the
/// last handle; then answers every waiter left.
async fn run<S>(
    mut stream: tokio_tungstenite::WebSocketStream<S>,
    mut rx: mpsc::Receiver<Message>,
    waiters: Waiters,
    task: Task,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let Task {
        token,
        stop,
        timeout,
    } = task;
    let grace = timeout.min(CLOSE_GRACE);
    let ending = loop {
        tokio::select! {
            outgoing = rx.recv() => match outgoing {
                Some(message) => {
                    tokio::select! {
                        sent = tokio::time::timeout(timeout, stream.send(message)) => match sent {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                break SkillsError::Unreachable(token.scrub(error.to_string()));
                            }
                            Err(_) => {
                                break SkillsError::Unreachable("the daemon stopped reading".into());
                            }
                        },
                        // Dropped mid-write: the socket can't be closed cleanly, only let go.
                        () = stop.notified() => break SkillsError::Unreachable("closed".into()),
                    }
                }
                None => {
                    let _ = tokio::time::timeout(grace, stream.close(None)).await;
                    break SkillsError::Unreachable("closed".into());
                }
            },
            () = stop.notified() => {
                let _ = tokio::time::timeout(grace, stream.close(None)).await;
                break SkillsError::Unreachable("closed".into());
            }
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
    drop(stream);
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
