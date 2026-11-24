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
pub type AdmitFn =
    ThreadsafeFunction<AdmitRequestJs, Promise<AdmitAnswerJs>, AdmitRequestJs, Status, false>;
/// `release`: TypeScript drops one reservation.
pub type ReleaseFn = ThreadsafeFunction<f64, (), f64, Status, false>;
/// `opened`: TypeScript registers one socket.
pub type OpenedFn = ThreadsafeFunction<
    FnArgs<(NativeSocketHandle, f64, Option<String>)>,
    (),
    FnArgs<(NativeSocketHandle, f64, Option<String>)>,
    Status,
    false,
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

/// The connection's wait on its upgrade's decision. Dropping it never releases a
/// reservation: a pending upgrade is abandoned, which is no answer at all.
struct Pending {
    shared: Arc<Shared>,
    id: u64,
    outcome: oneshot::Receiver<AdmissionOutcome>,
}

impl Future for Pending {
    type Output = AdmissionOutcome;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.get_mut().outcome).poll(context) {
            // The decision task died without answering: nothing decided this
            // upgrade, so admission refuses it rather than opening anything.
            Poll::Ready(Err(_)) => Poll::Ready(AdmissionOutcome::TimedOut),
            Poll::Ready(Ok(outcome)) => Poll::Ready(outcome),
            Poll::Pending => Poll::Pending,
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.shared.admission.abandoned(self.id);
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
            outcome: answer,
        })
    }

    fn release(&self, reservation: u64) {
        if self.0.admission.released(reservation) {
            self.0.release_js(reservation);
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
            Decided::Accepted(reservation) => {
                if shared.admission.hand_over(id, reservation) {
                    let decision =
                        AdmissionOutcome::Decided(AdmissionDecision::Accept { reservation });
                    if outcome.send(decision).is_err() {
                        // The connection went away before it read the decision:
                        // its reservation is released, once.
                        if shared.admission.released(reservation) {
                            shared.release_js(reservation);
                        }
                    }
                } else if shared.admission.released_late(id) {
                    // Abandoned while the promise was settling.
                    shared.release_js(reservation);
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
        if !shared.admission.opened(reservation) {
            // Released, abandoned or timed out: the stream is dropped and no
            // socket is built, so a failed `101` can never arrive as one.
            drop(stream);
            return;
        }
        let socket = NativeSocketHandle::open(Arc::clone(shared), stream);
        let _ = shared.opened.call_with_return_value(
            FnArgs::from((socket, reservation as f64, user_agent)),
            ThreadsafeFunctionCallMode::NonBlocking,
            |_value, _env| Ok(()),
        );
    }
}
