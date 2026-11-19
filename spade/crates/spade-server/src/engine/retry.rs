//! Sending a model step again when it failed before anything streamed (docs/harness.md, Model
//! calls). A request the endpoint never answered was never billed, so trying it again costs
//! nothing; once output has started, a cut stream is handled by the turn as before. When the
//! quick tries are used up on an outage, the turn waits out the endpoint on an outage wake
//! (ADR 0158, ADR 0160): 1, 2, 4 … minutes apart, at most an hour, longer when the endpoint asks,
//! for as long as it takes. The reply stays open; Stop, the person cancelling the wake and a
//! pause end the wait, the person waking it or writing ends it early, and a restart resumes it.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use spade_core::maintenance::{Pause, Point};
use spade_core::wake::{self, CancelledBy, Cause, Ended, Purpose};
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
/// meanwhile; Stop and a pause end the wait. Once the quick tries are used up the turn waits out
/// the endpoint on an outage wake and tries again, as long as it takes.
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
    // A turn resumed after a restart (or an update) keeps waiting out its outage.
    match resume(engine, id, reply, stop, pause).await {
        Waited::Again => {}
        Waited::Stopped => return Opened::Stopped,
        Waited::Paused => return Opened::Paused,
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
            // An outage: wait it out, then start the quick tries again.
            tracing::warn!(%error, "the endpoint is down; the turn waits for it");
            match wait_out(
                engine,
                id,
                reply,
                &error.to_string(),
                error.retry_after(),
                stop,
                pause,
            )
            .await
            {
                Waited::Again => {}
                Waited::Stopped => return Opened::Stopped,
                Waited::Paused => return Opened::Paused,
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

/// How waiting out an outage ended.
pub(super) enum Waited {
    /// Time to send the step again.
    Again,
    /// Stop, or the person called the wait off: the reply ends stopped.
    Stopped,
    Paused,
}

/// Parks the open turn of `reply` on an outage wake and waits until it fires. `asked` is the
/// endpoint's `retry-after`.
pub(super) async fn wait_out(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    error: &str,
    asked: Option<Duration>,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Waited {
    let attempt = engine
        .load(id)
        .map_or(1, |events| wake::next_outage_attempt(&events, reply));
    let asked_ms = asked.map(|d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX));
    let due_ms = engine
        .now_ms()
        .saturating_add(wake::retry_after_ms(attempt, asked_ms));
    let purpose = Purpose::Outage {
        attempt,
        error: super::wakes::short(error),
    };
    match engine.set_wake(id, purpose, Some(due_ms), None, "") {
        Ok(_) => resume(engine, id, reply, stop, pause).await,
        Err(stored) => {
            // Not stored, so not shown or kept across a restart; the turn still waits.
            tracing::error!(error = %stored, "could not store that a turn waits out an outage");
            until(engine, due_ms, stop, pause).await
        }
    }
}

/// Waits on the open outage wake of `reply`, if there is one (and on a `turn_parked` an earlier
/// build stored). [`Waited::Again`] at once when there is none.
async fn resume(
    engine: &Arc<Engine>,
    id: &str,
    reply: &str,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Waited {
    let Ok(events) = engine.load(id) else {
        return Waited::Again;
    };
    if let Some((from, open)) = wake::open_outage(&events, reply) {
        let (wake, due_ms) = (open.wake.clone(), open.due_ms.unwrap_or(0));
        // Armed here too, so a turn resumed before the wakes are restored still sees it fire.
        engine.arm(id, open);
        drop(events);
        return on_wake(engine, id, &wake, from, due_ms, stop, pause).await;
    }
    match wake::legacy_turn_wait(&events, reply) {
        Some(until_ms) => until(engine, until_ms, stop, pause).await,
        None => Waited::Again,
    }
}

/// Waits until `wake` (stored at `from`) fires or is cancelled, firing it itself once it is due,
/// so the wait never hangs on the timer. Looks at the clock and the turn's new events each
/// second; while a turn runs a read takes only what was stored since.
async fn on_wake(
    engine: &Arc<Engine>,
    id: &str,
    wake: &str,
    from: usize,
    due_ms: i64,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Waited {
    loop {
        if let Ok(events) = engine.load(id) {
            let since = events.get(from..).unwrap_or_default();
            match wake::ended(since, wake) {
                Some(Ended::Fired) => {
                    engine.set_status(id, Some(THINKING.to_owned()));
                    return Waited::Again;
                }
                // Stop, or the person called the wait off: the reply ends stopped.
                Some(Ended::Cancelled(_)) => {
                    return Waited::Stopped;
                }
                None => {}
            }
        }
        let left = due_ms - engine.now_ms();
        if left <= 0 {
            engine.fire_wake(id, wake, Cause::Time, None, Vec::new());
            continue;
        }
        let left = Duration::from_millis(u64::try_from(left).unwrap_or(0));
        // The engine's clock, so a test moves time instead of waiting.
        tokio::select! {
            () = tokio::time::sleep(left.min(Duration::from_secs(1))) => {}
            _ = super::turn::stopped(stop) => {
                // A bot's Stop cancelled it already; a helper's ends with its job.
                if let Err(error) = engine.cancel_wake(id, wake, CancelledBy::Stop) {
                    tracing::warn!(%error, "could not cancel a stopped turn's outage wait");
                }
                return Waited::Stopped;
            }
            _ = super::turn::pausing(pause, Point::Streaming) => return Waited::Paused,
        }
    }
}

/// Waits on the engine's clock until `until_ms`, with no wake to show for it.
async fn until(
    engine: &Arc<Engine>,
    until_ms: i64,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Waited {
    loop {
        let left = until_ms - engine.now_ms();
        if left <= 0 {
            return Waited::Again;
        }
        let left = Duration::from_millis(u64::try_from(left).unwrap_or(0));
        tokio::select! {
            () = tokio::time::sleep(left.min(Duration::from_secs(1))) => {}
            _ = super::turn::stopped(stop) => return Waited::Stopped,
            _ = super::turn::pausing(pause, Point::Streaming) => return Waited::Paused,
        }
    }
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
