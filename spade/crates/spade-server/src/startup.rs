//! What Spade does once it is listening. Nothing before bind may touch the keychain or the
//! network: a keychain prompt for a re-signed binary, or ace being away, must never keep Spade
//! from answering `/health` (#1802). So the setup that reads keys runs here, in the background.
//! Admission stays closed while it runs (messages are stored and answered once it opens), but
//! never longer than a deadline: a prompt nobody answers must not stop Spade working. Setup then
//! carries on and finishes by itself whenever the keychain answers.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::Engine;
use crate::tools::AceLink;

/// How long admission waits for setup before opening anyway.
pub const SETTLE_DEADLINE: Duration = Duration::from_secs(15);

/// Runs setup (retrying until it works), opens for work once it is done or `deadline` passes,
/// after a short wait for ace's tools, and moves an adopted old `models.json` aside once adopted.
/// The returned task ends when Spade is open for work; setup may still be running.
pub fn finish(
    engine: Arc<Engine>,
    ace: Option<Arc<AceLink>>,
    set_aside: Option<PathBuf>,
    deadline: Duration,
) -> tokio::task::JoinHandle<()> {
    let started = Instant::now();
    tokio::spawn(settle_until_done(engine.clone(), set_aside, started));
    tokio::spawn(async move {
        if tokio::time::timeout(deadline, engine.settled())
            .await
            .is_err()
        {
            engine.set_starting("waiting for the keychain");
            tracing::warn!(
                ms = started.elapsed().as_millis() as u64,
                "endpoint setup is still waiting, likely for the keychain; opening anyway"
            );
        }
        // Resume once ace's tools are back, so a paused turn about to use one finds it; never
        // wait long, since Spade works without ace.
        if let Some(link) = ace
            && link.holds_grant(Duration::from_secs(3)).await
        {
            link.ready_within(Duration::from_secs(10)).await;
        }
        engine.open_for_work();
        tracing::info!(ms = started.elapsed().as_millis() as u64, "open for work");
    })
}

/// Settles the engine off the async workers (keychain reads block), again after a failure with
/// waits up to a minute, until it works.
async fn settle_until_done(engine: Arc<Engine>, set_aside: Option<PathBuf>, started: Instant) {
    let mut wait = Duration::from_secs(1);
    loop {
        let settling = engine.clone();
        let outcome = match tokio::task::spawn_blocking(move || settling.settle()).await {
            Ok(outcome) => outcome,
            Err(error) => Err(error.to_string()),
        };
        match outcome {
            Ok(()) => break,
            Err(error) => {
                engine.set_starting("setting up endpoints failed; trying again");
                tracing::error!(%error, "setting up endpoints failed; trying again");
                tokio::time::sleep(wait).await;
                wait = (wait * 2).min(Duration::from_secs(60));
            }
        }
    }
    tracing::info!(
        ms = started.elapsed().as_millis() as u64,
        "endpoints set up"
    );
    if let Some(path) = set_aside
        && let Err(error) = crate::presets::set_aside(&path)
    {
        tracing::warn!(%error, "could not move the old models.json aside; it is ignored");
    }
}
