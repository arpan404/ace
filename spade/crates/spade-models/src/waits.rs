//! How long a signed-in account's stream may take (ADR 0214). The backend's first frame (its
//! answer's headers and first event, sent at once) must come within `headers`: until then the
//! account's dispatch gate is held, so a backend that never answers can't hold off a sign-out for
//! longer. After it, the stream lives as long as frames keep coming, heartbeats and comments
//! included, within `idle` of each other and `total` in all: a model that reasons quietly for
//! minutes behind heartbeats is never cut off. Every end by a wait counts as possibly billed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use tokio::sync::Notify;
use tokio::time::Instant;

use crate::client::Deltas;
use crate::error::ModelError;
use crate::prompt::Delta;
use crate::signed::DispatchGuard;

/// The waits on a signed-in account's stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamWaits {
    /// From sending to the first frame.
    pub headers: Duration,
    /// Between frames, once the first came.
    pub idle: Duration,
    /// For the whole answer.
    pub total: Duration,
}

impl Default for StreamWaits {
    fn default() -> Self {
        Self {
            headers: Duration::from_secs(2 * 60),
            idle: Duration::from_secs(10 * 60),
            total: Duration::from_secs(60 * 60),
        }
    }
}

/// When the stream's frames came: the first, and the latest.
pub(crate) struct Activity {
    opened: AtomicBool,
    first: Notify,
    last: Mutex<Instant>,
}

impl Activity {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            opened: AtomicBool::new(false),
            first: Notify::new(),
            last: Mutex::new(Instant::now()),
        })
    }

    /// A frame came (an event, a heartbeat or a comment).
    pub(crate) fn touch(&self) {
        *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        if !self.opened.swap(true, Ordering::SeqCst) {
            self.first.notify_waiters();
        }
    }

    /// Resolves once the first frame came.
    pub(crate) async fn opened(&self) {
        loop {
            let notified = self.first.notified();
            if self.opened.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
        }
    }

    /// Resolves once no frame came for `idle`.
    pub(crate) async fn quiet_for(&self, idle: Duration) {
        loop {
            let last = *self.last.lock().unwrap_or_else(|p| p.into_inner());
            tokio::time::sleep_until(last + idle).await;
            if *self.last.lock().unwrap_or_else(|p| p.into_inner()) == last {
                return;
            }
        }
    }
}

const NO_START: &str = "the ChatGPT backend did not start answering in time";
const QUIET: &str = "the ChatGPT backend went quiet in the middle of its answer";
const TOO_LONG: &str = "the ChatGPT backend's answer took too long";

/// A stream ended by a wait: it may have run and been billed, so it is never sent again.
fn stalled(model: &str, message: &str) -> ModelError {
    ModelError::Provider {
        model: model.to_owned(),
        message: message.to_owned(),
    }
}

/// A signed-in account's stream, its first item read under `waits`. `held` (leave to send) goes
/// at the first frame, once the request is surely on the wire.
pub(crate) async fn timed(
    mut stream: Deltas,
    held: DispatchGuard,
    activity: Arc<Activity>,
    waits: StreamWaits,
    model: String,
) -> Result<Deltas, ModelError> {
    let started = Instant::now();
    let (headers_by, total_by) = (started + waits.headers, started + waits.total);
    let mut held = Some(held);
    let first = loop {
        tokio::select! {
            item = stream.next() => break item,
            () = activity.opened(), if held.is_some() => held = None,
            () = tokio::time::sleep_until(headers_by), if held.is_some() => {
                return Err(stalled(&model, NO_START));
            }
            () = activity.quiet_for(waits.idle), if held.is_none() => {
                return Err(stalled(&model, QUIET));
            }
            () = tokio::time::sleep_until(total_by) => return Err(stalled(&model, TOO_LONG)),
        }
    };
    drop(held);
    match first {
        Some(Err(error)) => Err(error),
        None => Ok(Box::pin(futures_util::stream::empty())),
        Some(Ok(delta)) => {
            let rest = Watched {
                stream,
                activity,
                idle: waits.idle,
                total_by,
                model,
            };
            Ok(Box::pin(
                futures_util::stream::once(std::future::ready(Ok(delta))).chain(rest.into_stream()),
            ))
        }
    }
}

/// The rest of a signed-in stream, ended by silence or the total wait.
struct Watched {
    stream: Deltas,
    activity: Arc<Activity>,
    idle: Duration,
    total_by: Instant,
    model: String,
}

impl Watched {
    fn into_stream(self) -> impl Stream<Item = Result<Delta, ModelError>> + Send {
        futures_util::stream::unfold(Some(self), |state| async move {
            let mut state = state?;
            tokio::select! {
                item = state.stream.next() => item.map(|item| (item, Some(state))),
                () = state.activity.quiet_for(state.idle) => {
                    Some((Err(stalled(&state.model, QUIET)), None))
                }
                () = tokio::time::sleep_until(state.total_by) => {
                    Some((Err(stalled(&state.model, TOO_LONG)), None))
                }
            }
        })
    }
}
