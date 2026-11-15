//! Sending a model step again when it failed before anything streamed (docs/harness.md, Model
//! calls). A request the endpoint never answered was never billed, so trying it again costs
//! nothing; once output has started, a cut stream is handled by the turn as before. When the
//! quick tries are used up on an outage, the turn waits for the endpoint (`turn_parked`, ADR
//! 0158), minutes and then hours apart, until it answers or the person presses Stop.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use spade_core::event::{Event, Known};
use spade_core::maintenance::{Pause, Point};
use spade_core::park;
use spade_models::{Delta, ModelError, Prompt};
use tokio::sync::watch;

use super::Engine;
use super::roster::{RETRYING, THINKING};

/// How often, and for how long in all, a step is sent again.
#[derive(Debug, Clone, Copy)]
pub struct Retry {
    /// Tries in all, the first included.
    pub tries: u32,
    /// The wait before the first retry; each later one waits three times longer.
    pub first_wait: Duration,
    /// The most the waits may add up to. An endpoint asking for longer waits only this long.
    pub longest: Duration,
}

impl Default for Retry {
    fn default() -> Self {
        Self {
            tries: 3,
            first_wait: Duration::from_secs(2),
            longest: Duration::from_secs(20),
        }
    }
}

/// How long to wait before try number `next` (2 is the first retry), after `waited` in earlier
/// waits: the endpoint's `hint`, else the backoff, never past what is left of the budget.
/// `None`: no try or no time is left.
pub(super) fn wait(
    policy: &Retry,
    next: u32,
    waited: Duration,
    hint: Option<Duration>,
) -> Option<Duration> {
    if next < 2 || next > policy.tries {
        return None;
    }
    let backoff = policy
        .first_wait
        .saturating_mul(3u32.saturating_pow(next - 2));
    let left = policy.longest.saturating_sub(waited);
    (!left.is_zero()).then(|| hint.unwrap_or(backoff).min(left))
}

pub(super) type Deltas = Pin<Box<dyn Stream<Item = Result<Delta, ModelError>> + Send>>;

/// How opening a step's stream ended.
pub(super) enum Opened {
    /// The endpoint answered: every item, the first one included.
    Answering(Deltas),
    /// Every try failed (or the failure was not worth another): the last error.
    Failed(ModelError),
    Stopped,
    Paused,
}

/// Opens the step's stream and waits for its first item, sending the request again while it
/// fails before anything streamed and the failure may pass. The status reads "Retrying"
/// meanwhile; Stop and a pause end the wait. Once the quick tries are used up the turn waits for
/// the endpoint and tries again, as long as it takes.
pub(super) async fn open(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    model: &str,
    prompt: &Prompt,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Opened {
    let policy = engine.limits.retry;
    let mut waited = Duration::ZERO;
    let mut tries = 1;
    // A turn resumed after a restart (or an update) keeps waiting until its stored time.
    let resumed = engine
        .load(id)
        .ok()
        .and_then(|events| park::turn_wait(events.iter(), reply));
    if let Some((until_ms, _)) = resumed
        && let Some(end) = wait_for_endpoint(engine, id, model, until_ms, stop, pause).await
    {
        return end;
    }
    loop {
        let first = tokio::select! {
            first = first_item(engine, model, prompt) => first,
            _ = super::turn::stopped(stop) => return Opened::Stopped,
            _ = super::turn::pausing(pause, Point::Streaming) => return Opened::Paused,
        };
        let error = match first {
            Ok(stream) => return Opened::Answering(stream),
            Err(error) => error,
        };
        let pause_for = error
            .transient()
            .then(|| wait(&policy, tries + 1, waited, error.retry_after()))
            .flatten();
        let Some(pause_for) = pause_for else {
            if !error.transient() {
                // A refused key, a used-up quota or a bad request: the person has to act.
                return Opened::Failed(error);
            }
            // An outage: wait for the endpoint, then start the quick tries again.
            let round = engine
                .load(id)
                .map_or(0, |events| park::turn_rounds(events.iter(), reply))
                + 1;
            let wait = park::wait(&engine.limits.outage, round, error.retry_after());
            let until_ms = engine
                .now_ms()
                .saturating_add(i64::try_from(wait.as_millis()).unwrap_or(i64::MAX));
            tracing::warn!(%error, round, ?wait, "the endpoint is down; the turn waits for it");
            let parked = Event::Known(Known::TurnParked {
                reply: reply.to_owned(),
                until_ms,
                round,
                why: error.to_string(),
            });
            if let Err(stored) = engine.record(id, &parked) {
                tracing::error!(error = %stored, "could not store that a turn waits");
                return Opened::Failed(error);
            }
            if let Some(end) = wait_for_endpoint(engine, id, model, until_ms, stop, pause).await {
                return end;
            }
            waited = Duration::ZERO;
            tries = 1;
            continue;
        };
        tracing::info!(%error, try_next = tries + 1, ?pause_for, "sending a model step again");
        engine.set_status(id, Some(RETRYING.to_owned()));
        tokio::select! {
            () = tokio::time::sleep(pause_for) => {}
            _ = super::turn::stopped(stop) => return Opened::Stopped,
            _ = super::turn::pausing(pause, Point::Streaming) => return Opened::Paused,
        }
        engine.set_status(id, Some(THINKING.to_owned()));
        waited += pause_for;
        tries += 1;
    }
}

/// Waits on the engine's clock until `until_ms`, the status saying what for. `None` once it is
/// time to try again; Stop and a pause end the wait.
async fn wait_for_endpoint(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    until_ms: i64,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Option<Opened> {
    let endpoint = model.split('/').next().unwrap_or(model);
    loop {
        let left = until_ms - engine.now_ms();
        if left <= 0 {
            break;
        }
        let minutes = (left + 59_999) / 60_000;
        engine.set_status(id, Some(park::turn_words(endpoint, minutes)));
        let left = Duration::from_millis(u64::try_from(left).unwrap_or(0));
        // The engine's clock is looked at every second, so a test moves time instead of waiting.
        tokio::select! {
            () = tokio::time::sleep(left.min(Duration::from_secs(1))) => {}
            _ = super::turn::stopped(stop) => return Some(Opened::Stopped),
            _ = super::turn::pausing(pause, Point::Streaming) => return Some(Opened::Paused),
        }
    }
    engine.set_status(id, Some(THINKING.to_owned()));
    None
}

/// The stream with its first item read, or the error that came before anything else.
async fn first_item(engine: &Engine, model: &str, prompt: &Prompt) -> Result<Deltas, ModelError> {
    let mut stream = Box::pin(engine.models.stream(model, prompt).await?);
    match stream.next().await {
        Some(Err(error)) => Err(error),
        first => Ok(Box::pin(futures_util::stream::iter(first).chain(stream))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn three_tries_wait_two_then_six_seconds_and_no_fourth_is_made() {
        let policy = Retry::default();
        assert_eq!(wait(&policy, 2, Duration::ZERO, None), Some(2 * SECOND));
        assert_eq!(wait(&policy, 3, 2 * SECOND, None), Some(6 * SECOND));
        assert_eq!(wait(&policy, 4, 8 * SECOND, None), None);
    }

    #[test]
    fn the_endpoints_wait_is_honoured_up_to_what_is_left_of_the_budget() {
        let policy = Retry::default();
        assert_eq!(
            wait(&policy, 2, Duration::ZERO, Some(5 * SECOND)),
            Some(5 * SECOND)
        );
        assert_eq!(
            wait(&policy, 2, Duration::ZERO, Some(60 * SECOND)),
            Some(20 * SECOND)
        );
        assert_eq!(
            wait(&policy, 3, 15 * SECOND, Some(6 * SECOND)),
            Some(5 * SECOND)
        );
        assert_eq!(wait(&policy, 3, 20 * SECOND, None), None);
    }
}
