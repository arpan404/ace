//! What Spade does once it is listening. Nothing before bind may touch the keychain or the
//! network: a keychain prompt for a re-signed binary, or ace being away, must never keep Spade
//! from answering `/health` (#1802). So the setup that reads keys runs here, in the background,
//! while admission stays closed; messages sent meanwhile are stored and answered once it opens.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::engine::Engine;
use crate::tools::AceLink;

/// Settles the engine off the async workers (keychain reads block), moves an adopted old
/// `models.json` aside, waits briefly for ace's tools, then opens for work.
pub fn finish(
    engine: Arc<Engine>,
    ace: Option<Arc<AceLink>>,
    set_aside: Option<PathBuf>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let started = Instant::now();
        let settling = engine.clone();
        match tokio::task::spawn_blocking(move || settling.settle()).await {
            Ok(Ok(())) => {
                if let Some(path) = set_aside
                    && let Err(error) = crate::presets::set_aside(&path)
                {
                    tracing::warn!(%error, "could not move the old models.json aside; it is ignored");
                }
            }
            // The old file stays where it is, so the next start tries again.
            Ok(Err(error)) => {
                tracing::error!(%error, "setting up endpoints failed; Spade carries on")
            }
            Err(error) => tracing::error!(%error, "setting up endpoints stopped"),
        }
        tracing::info!(
            ms = started.elapsed().as_millis() as u64,
            "endpoints set up"
        );
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
