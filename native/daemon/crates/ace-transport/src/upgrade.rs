// SPDX-License-Identifier: Apache-2.0
//! The WebSocket upgrade handshake (T1a.3): admission on the raw request target,
//! then `ws` 8.22's checks in `handleUpgrade`'s order, each refusal written
//! exactly as `abortHandshake` writes it, and the `101` exactly as
//! `completeUpgrade` writes it. The same decision answers through hyper for an
//! upgrade that arrives later on a keep-alive connection.
//!
//! Nothing here times out a `101`: on the raw path the handler's own write and
//! flush are bounded by [`crate::prefixed::TimedIo`]'s write timeout (5 s), and
//! on the hyper path by hyper's write of the reply. The listener-closing `503`
//! is `ws`'s own `abortHandshake(socket, 503)` answer, distinct from
//! admission's empty-body `503`.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use http::StatusCode;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

use self::handshake::{Refusal, empty_response, handshake, latin1, node_header};
use crate::driver::{UpgradeHandler, UpgradeIo, UpgradeReply};
use crate::head::RequestHead;
use crate::peer::Peer;
use crate::prefixed::Prefixed;

mod handshake;
mod number;

#[cfg(test)]
mod tests;

/// What admission writes for a refuted upgrade, with an empty body:
/// `refuseUpgrade` (`socket-upgrade.ts:6`–`:9`).
pub const FORBIDDEN: &[u8] =
    b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// Admission's refusal over capacity, its pre-authentication budget, or its own
/// timeout. This is not `ws`'s closing-state `503` (the handshake's `CLOSING`).
pub const UNAVAILABLE: &[u8] =
    b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

/// One upgrade candidate, as admission sees it today: the raw target, the
/// Origin and User-Agent header values (Node's joined form), and the socket's
/// two ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeRequest {
    /// The request-target exactly as received, never a parsed path.
    pub target: String,
    pub origin: Option<String>,
    pub user_agent: Option<String>,
    pub peer: Peer,
}

impl UpgradeRequest {
    pub fn from_head(head: &RequestHead, peer: Peer) -> Self {
        Self {
            target: head.target.clone(),
            origin: node_header(&head.headers, "origin").map(|value| latin1(&value)),
            user_agent: node_header(&head.headers, "user-agent").map(|value| latin1(&value)),
            peer,
        }
    }
}

/// What admission decided for one upgrade.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionDecision {
    Accept { reservation: u64 },
    Forbidden,
    Unavailable,
    Drop,
}

/// Admission's answer: a decision, or its own timeout (today `503` with an
/// empty body).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionOutcome {
    Decided(AdmissionDecision),
    TimedOut,
}

/// Who decides an upgrade. Resolves once; the admission state machine (T1a.5)
/// owns every release.
pub trait UpgradeAdmission: Send + Sync + 'static {
    fn admit(
        &self,
        request: UpgradeRequest,
    ) -> Pin<Box<dyn Future<Output = AdmissionOutcome> + Send>>;
    fn release(&self, reservation: u64);
}

/// Who receives a socket once its `101` is on the wire.
pub trait SocketSink: Send + Sync + 'static {
    fn opened(&self, reservation: u64, stream: Box<dyn UpgradeIo>, user_agent: Option<String>);
}

/// The handshake `UpgradeHandler`: admission, `ws`'s checks, then the socket.
pub struct WebSocketUpgrades {
    admission: Arc<dyn UpgradeAdmission>,
    sink: Arc<dyn SocketSink>,
    /// The User-Agent each `Switch` reply still owes its `opened`: hyper
    /// resolves the upgrade after the reply is written, on another task.
    switching: Arc<Mutex<HashMap<u64, Option<String>>>>,
}

impl WebSocketUpgrades {
    pub fn new(admission: Arc<dyn UpgradeAdmission>, sink: Arc<dyn SocketSink>) -> Self {
        Self {
            admission,
            sink,
            switching: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

impl UpgradeHandler for WebSocketUpgrades {
    fn upgrade_raw(
        &self,
        head: RequestHead,
        mut stream: Prefixed<TcpStream>,
        peer: Peer,
        shutdown: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let admission = Arc::clone(&self.admission);
        let sink = Arc::clone(&self.sink);
        Box::pin(async move {
            let request = UpgradeRequest::from_head(&head, peer);
            let user_agent = request.user_agent.clone();
            let reservation = match decide(admission.as_ref(), request).await {
                Decided::Drop => return,
                Decided::Forbidden => return refuse(&mut stream, FORBIDDEN).await,
                Decided::Unavailable => return refuse(&mut stream, UNAVAILABLE).await,
                Decided::Reservation(reservation) => reservation,
            };
            let acceptance = match handshake(&head) {
                Ok(acceptance) => acceptance,
                Err(refusal) => {
                    refuse(&mut stream, &refusal.bytes()).await;
                    admission.release(reservation);
                    return;
                }
            };
            // As `completeUpgrade`: every check has passed, then the server is
            // found closing.
            if shutdown.is_cancelled() {
                refuse(&mut stream, &Refusal::CLOSING.bytes()).await;
                admission.release(reservation);
                return;
            }
            if answer(&mut stream, &acceptance.bytes()).await.is_err() {
                admission.release(reservation);
                return;
            }
            // No await between the flush and the opening: the reservation can
            // never be cancelled out from under an accepted socket.
            sink.opened(reservation, Box::new(stream), user_agent);
        })
    }

    fn upgrade_hyper(
        &self,
        head: RequestHead,
        peer: Peer,
        shutdown: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = UpgradeReply> + Send>> {
        let admission = Arc::clone(&self.admission);
        let switching = Arc::clone(&self.switching);
        Box::pin(async move {
            let request = UpgradeRequest::from_head(&head, peer);
            let user_agent = request.user_agent.clone();
            let reservation = match decide(admission.as_ref(), request).await {
                Decided::Drop => return UpgradeReply::Drop,
                Decided::Forbidden => {
                    return UpgradeReply::Refuse(empty_response(StatusCode::FORBIDDEN));
                }
                Decided::Unavailable => {
                    return UpgradeReply::Refuse(empty_response(StatusCode::SERVICE_UNAVAILABLE));
                }
                Decided::Reservation(reservation) => reservation,
            };
            let acceptance = match handshake(&head) {
                Ok(acceptance) => acceptance,
                Err(refusal) => {
                    admission.release(reservation);
                    return UpgradeReply::Refuse(refusal.response());
                }
            };
            if shutdown.is_cancelled() {
                admission.release(reservation);
                return UpgradeReply::Refuse(Refusal::CLOSING.response());
            }
            switching
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(reservation, user_agent);
            UpgradeReply::Switch(acceptance.response(), reservation)
        })
    }

    fn switched(&self, reservation: u64, stream: Option<Box<dyn UpgradeIo>>) {
        let user_agent = self
            .switching
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .remove(&reservation)
            .flatten();
        match stream {
            Some(stream) => self.sink.opened(reservation, stream, user_agent),
            // hyper never flushed the `101`: nothing was opened.
            None => self.admission.release(reservation),
        }
    }
}

/// Admission's part of the decision, before any `ws` check.
enum Decided {
    Drop,
    Forbidden,
    Unavailable,
    Reservation(u64),
}

async fn decide(admission: &dyn UpgradeAdmission, request: UpgradeRequest) -> Decided {
    match admission.admit(request).await {
        AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation }) => {
            Decided::Reservation(reservation)
        }
        AdmissionOutcome::Decided(AdmissionDecision::Forbidden) => Decided::Forbidden,
        AdmissionOutcome::Decided(AdmissionDecision::Unavailable) | AdmissionOutcome::TimedOut => {
            Decided::Unavailable
        }
        AdmissionOutcome::Decided(AdmissionDecision::Drop) => Decided::Drop,
    }
}

async fn answer(stream: &mut Prefixed<TcpStream>, bytes: &[u8]) -> io::Result<()> {
    stream.write_all(bytes).await?;
    stream.flush().await
}

/// `ws` ends a refused connection after writing its answer.
async fn refuse(stream: &mut Prefixed<TcpStream>, bytes: &[u8]) {
    if answer(stream, bytes).await.is_ok() {
        let _ = stream.shutdown().await;
    }
}
