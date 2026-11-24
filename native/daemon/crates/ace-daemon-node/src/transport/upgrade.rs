// SPDX-License-Identifier: Apache-2.0
//! The upgrade half of the binding (T1a.5): asking TypeScript, waiting for its
//! word until admission's deadline, and handing it the socket once the `101` is
//! on the wire. Every effect here is a transition the admission state machine
//! allowed: one `release` per reservation and one `opened` per flushed `101`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use ace_transport::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeIo, UpgradeRequest,
};
use napi::Status;
use napi::bindgen_prelude::{FnArgs, Promise};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::oneshot;

use super::Shared;
use super::socket::NativeSocketHandle;

/// One upgrade candidate, as TypeScript's admission sees it.
#[napi(object)]
pub struct AdmitRequestJs {
    /// This upgrade; it names nothing back but the decision.
    pub id: f64,
    /// The request-target exactly as received.
    pub target: String,
    pub origin: Option<String>,
    /// The client's address, as the accepted socket reports it.
    pub address: String,
}

/// Admission's answer. `reservation` is the capacity slot TypeScript took, and
/// is what `release` and `opened` name it by.
#[napi(object)]
pub struct AdmitAnswerJs {
    /// `accept`, `forbidden`, `unavailable` or `drop`.
    pub decision: String,
    pub reservation: Option<f64>,
}

/// `admit`: one decision, as a promise. Node's error-first callback shape is off
/// (`CalleeHandled = false`): the shell's callbacks take their values plainly.
/// Every threadsafe function here is weak, so a live listener, upgrade or socket
/// never keeps the process alive.
pub type AdmitFn =
    ThreadsafeFunction<AdmitRequestJs, Promise<AdmitAnswerJs>, AdmitRequestJs, Status, false, true>;
/// `release`: TypeScript drops one reservation.
pub type ReleaseFn = ThreadsafeFunction<f64, (), f64, Status, false, true>;
/// `opened`: TypeScript registers one socket.
pub type OpenedFn = ThreadsafeFunction<
    FnArgs<(NativeSocketHandle, f64, Option<String>)>,
    (),
    FnArgs<(NativeSocketHandle, f64, Option<String>)>,
    Status,
    false,
    true,
>;

/// What TypeScript decided, once its word and reservation are checked.
enum Decided {
    Accepted(u64),
    Refused(AdmissionDecision),
}

impl Decided {
    /// TypeScript's word, checked: an acceptance without a usable reservation
    /// holds nothing, so it is refused rather than left unreleasable.
    fn of(answer: &AdmitAnswerJs) -> Self {
        let reservation = answer
            .reservation
            .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 9_007_199_254_740_991.0)
            .map(|value| value as u64);
        match answer.decision.as_str() {
            "accept" => match reservation {
                Some(reservation) => Decided::Accepted(reservation),
                None => Decided::Refused(AdmissionDecision::Unavailable),
            },
            "forbidden" => Decided::Refused(AdmissionDecision::Forbidden),
            "drop" => Decided::Refused(AdmissionDecision::Drop),
            // `unavailable`, and any word outside the union: refuse, don't decide.
            _ => Decided::Refused(AdmissionDecision::Unavailable),
        }
    }
}

/// The connection's wait on its upgrade's decision. It owns whatever the
/// decision holds: a pending upgrade is abandoned, and an accepted reservation
/// is released — whether the sender never answered, the send went unread, or
/// the connection was dropped between the two. The machine's `settle` sees the
/// phase and the reservation in one step, so there is no window in which one is
/// visible without the other.
struct Pending {
    shared: Arc<Shared>,
    id: u64,
    /// The connection has the decision: releasing here would take the
    /// reservation from the task that writes the `101`.
    answered: bool,
    outcome: oneshot::Receiver<AdmissionOutcome>,
}

impl Future for Pending {
    type Output = AdmissionOutcome;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        match Pin::new(&mut this.outcome).poll(context) {
            // The decision task died without answering: nothing decided this
            // upgrade, so admission refuses it rather than opening anything.
            Poll::Ready(Err(_)) => Poll::Ready(AdmissionOutcome::TimedOut),
            Poll::Ready(Ok(outcome)) => {
                this.answered = true;
                Poll::Ready(outcome)
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if self.answered {
            return;
        }
        if let Some(held) = self.shared.admission.settle(self.id) {
            self.shared.release(held);
        }
    }
}

/// TypeScript decides and releases; both effects are the state machine's.
pub struct Admitting(pub Arc<Shared>);

impl UpgradeAdmission for Admitting {
    fn admit(
        &self,
        request: UpgradeRequest,
    ) -> Pin<Box<dyn Future<Output = AdmissionOutcome> + Send>> {
        let shared = Arc::clone(&self.0);
        let id = shared.admission.begin();
        let (outcome, answer) = oneshot::channel();
        shared
            .runtime
            .spawn(resolve(Arc::clone(&shared), id, request, outcome));
        Box::pin(Pending {
            shared,
            id,
            answered: false,
            outcome: answer,
        })
    }

    fn writing(&self, reservation: u64) -> bool {
        if !self.0.admission.writing(reservation) {
            return false;
        }
        // On the wire now: close() waits for it until it opens or releases,
        // because a hyper upgrade registers its socket from a task of its own.
        self.0.live.enter_writing();
        true
    }

    fn release(&self, reservation: u64) {
        if let Some(held) = self.0.admission.released(reservation) {
            self.0.release(held);
        }
    }
}

/// One upgrade's decision: ask, wait until the deadline, and keep watching a
/// promise that outlives it, so a late acceptance is released, never opened.
async fn resolve(
    shared: Arc<Shared>,
    id: u64,
    request: UpgradeRequest,
    outcome: oneshot::Sender<AdmissionOutcome>,
) {
    let asked = AdmitRequestJs {
        id: id as f64,
        target: request.target,
        origin: request.origin,
        address: request.peer.remote.ip().to_string(),
    };
    let asking = shared.ask(asked);
    let deadline = tokio::time::sleep(shared.timeout);
    tokio::pin!(asking);
    tokio::pin!(deadline);
    let mut stop = shared.stop.subscribe();
    let answer = tokio::select! {
        biased;
        // The listener closed: TypeScript drops what it holds, and this task
        // ends rather than waiting out a promise nobody will act on.
        _ = stop.wait_for(|closed| *closed) => {
            shared.admission.settled(id);
            return;
        }
        answer = &mut asking => Some(answer),
        () = &mut deadline => None,
    };
    let Some(answer) = answer else {
        // Admission's own deadline: a 503, and the promise is still watched.
        if shared.admission.timed_out(id) {
            let _ = outcome.send(AdmissionOutcome::TimedOut);
        }
        let late = tokio::select! {
            biased;
            _ = stop.wait_for(|closed| *closed) => None,
            answer = &mut asking => Some(answer),
        };
        if let Some(Ok(answer)) = late
            && let Decided::Accepted(reservation) = Decided::of(&answer)
            && shared.admission.released_late(id)
        {
            shared.release_js(reservation);
        }
        shared.admission.settled(id);
        return;
    };
    match answer {
        Ok(answer) => match Decided::of(&answer) {
            Decided::Accepted(held) => {
                // The phase and the reservation are recorded together, so the
                // connection's own drop can always release what it holds.
                if shared.admission.accepted(id, held) {
                    let decision =
                        AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation: held });
                    if outcome.send(decision).is_err() {
                        // The connection was dropped before it read the answer
                        // (its guard may have released already).
                        if let Some(released) = shared.admission.released(held) {
                            shared.release(released);
                        }
                    }
                } else if shared.admission.released_late(id) {
                    // Abandoned while the promise was settling.
                    shared.release_js(held);
                }
            }
            Decided::Refused(decision) => {
                shared.admission.settled(id);
                let _ = outcome.send(AdmissionOutcome::Decided(decision));
            }
        },
        // `admit` threw or rejected: no decision, so admission refuses the
        // upgrade with its own 503 rather than guessing one.
        Err(_) => {
            shared.admission.settled(id);
            let _ = outcome.send(AdmissionOutcome::TimedOut);
        }
    }
}

/// The sockets `opened` hands to JavaScript: the only place the transport's
/// `opened` reaches TypeScript, and only for a reservation still `Writing`.
pub struct Sinking(pub Arc<Shared>);

impl SocketSink for Sinking {
    fn opened(&self, reservation: u64, stream: Box<dyn UpgradeIo>, user_agent: Option<String>) {
        let shared = &self.0;
        if shared.admission.opened(reservation).is_none() {
            // Released, abandoned or timed out: the stream is dropped and no
            // socket is built, so a failed `101` can never arrive as one.
            drop(stream);
            return;
        }
        // The socket joins the close wait before the wire count lets it go, so
        // the close never sees neither.
        let socket = NativeSocketHandle::open(Arc::clone(shared), stream);
        shared.live.leave_writing();
        let _ = shared.opened.call_with_return_value(
            FnArgs::from((socket, reservation as f64, user_agent)),
            ThreadsafeFunctionCallMode::NonBlocking,
            |_value, _env| Ok(()),
        );
    }
}
