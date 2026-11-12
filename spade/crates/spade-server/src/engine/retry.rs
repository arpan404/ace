//! Sending a model step again when it failed before anything streamed (docs/harness.md, Model
//! calls). A request the endpoint never answered was never billed, so trying it again costs
//! nothing; once output has started, a cut stream is handled by the turn as before.

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{Stream, StreamExt};
use spade_core::maintenance::{Pause, Point};
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
/// meanwhile; Stop and a pause end the wait.
pub(super) async fn open(
    engine: &Arc<Engine>,
    id: &str,
    model: &str,
    prompt: &Prompt,
    stop: &mut watch::Receiver<bool>,
    pause: &mut watch::Receiver<Pause>,
) -> Opened {
    let policy = engine.limits.retry;
    let mut waited = Duration::ZERO;
    let mut tries = 1;
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
            return Opened::Failed(error);
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
