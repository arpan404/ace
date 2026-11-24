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
//!
//! Two rules make the decision safe around a close: a raw upgrade watches its
//! client's read side while admission is pending (a client that goes away is
//! abandoned, not answered), and the reservation moves to `Writing` only after
//! every check passed and the connection armed its [`Grace`] — so a deadline
//! never splits the `101` from the socket it registers. Whatever a dropped
//! connection leaves behind is released by its [`Settle`] guard.

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
use crate::driver::{Grace, UpgradeHandler, UpgradeIo, UpgradeReply};
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
    /// Every `ws` check has passed and the `101` is about to be written: the
    /// reservation is beyond a deadline now, and only `opened` or `release` may
    /// move it. False when it was released already, and nothing may be written.
    fn writing(&self, reservation: u64) -> bool;
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
        grace: Grace,
    ) -> Pin<Box<dyn Future<Output = ()> + Send>> {
        let admission = Arc::clone(&self.admission);
        let sink = Arc::clone(&self.sink);
        Box::pin(async move {
            let request = UpgradeRequest::from_head(&head, peer);
            let user_agent = request.user_agent.clone();
            // Admission may outlive the client. A client that goes away while
            // its decision is pending is abandoned, never answered: dropping
            // the decision future is what abandons it.
            let outcome = {
                let deciding = admission.admit(request);
                tokio::pin!(deciding);
                let closed = stream.peer_closed();
                tokio::pin!(closed);
                tokio::select! {
                    biased;
                    outcome = &mut deciding => outcome,
                    _ = &mut closed => return,
                }
            };
            let reservation = match decided(outcome) {
                Decided::Drop => return,
                Decided::Forbidden => return refuse(&mut stream, FORBIDDEN).await,
                Decided::Unavailable => return refuse(&mut stream, UNAVAILABLE).await,
                Decided::Reservation(reservation) => reservation,
            };
            // Every exit below that does not open or release explicitly drops
            // this guard, which releases the reservation exactly once.
            let mut settle = Settle::new(&admission, reservation);
            let acceptance = match handshake(&head) {
                Ok(acceptance) => acceptance,
                Err(refusal) => return refuse(&mut stream, &refusal.bytes()).await,
            };
            // As `completeUpgrade`: every check has passed, then the server is
            // found closing.
            if shutdown.is_cancelled() {
                return refuse(&mut stream, &Refusal::CLOSING.bytes()).await;
            }
            // Past this point the close deadline may not cancel the connection:
            // the `101` and the socket's registration are one step.
            if !grace.arm() {
                return;
            }
            if !admission.writing(reservation) {
                return;
            }
            if answer(&mut stream, &acceptance.bytes()).await.is_err() {
                return;
            }
            sink.opened(reservation, Box::new(stream), user_agent);
            settle.disarm();
        })
    }

    fn upgrade_hyper(
        &self,
        head: RequestHead,
        peer: Peer,
        shutdown: CancellationToken,
        grace: Grace,
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
            let mut settle = Settle::new(&admission, reservation);
            let acceptance = match handshake(&head) {
                Ok(acceptance) => acceptance,
                Err(refusal) => return UpgradeReply::Refuse(refusal.response()),
            };
            if shutdown.is_cancelled() {
                return UpgradeReply::Refuse(Refusal::CLOSING.response());
            }
            // hyper writes the `101` after this returns, so the deadline must
            // not cancel the connection from here on.
            if !grace.arm() {
                return UpgradeReply::Drop;
            }
            if !admission.writing(reservation) {
                return UpgradeReply::Drop;
            }
            switching
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .insert(reservation, user_agent);
            settle.disarm();
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

/// Releases a reservation if the upgrade ends without opening or releasing it:
/// a connection dropped while deciding was answered, a cancelled deadline, a
/// failed `101`. `release` is idempotent, so the paths that release themselves
/// stay in charge.
struct Settle {
    admission: Arc<dyn UpgradeAdmission>,
    reservation: Option<u64>,
}

impl Settle {
    fn new(admission: &Arc<dyn UpgradeAdmission>, reservation: u64) -> Self {
        Self {
            admission: Arc::clone(admission),
            reservation: Some(reservation),
        }
    }

    /// The upgrade opened or released itself: nothing is owed.
    fn disarm(&mut self) {
        self.reservation = None;
    }
}

impl Drop for Settle {
    fn drop(&mut self) {
        if let Some(reservation) = self.reservation {
            self.admission.release(reservation);
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
    decided(admission.admit(request).await)
}

/// Admission's answer as the handler acts on it; its own timeout is a refusal
/// with an empty body, never a reservation.
fn decided(outcome: AdmissionOutcome) -> Decided {
    match outcome {
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
