//! The thin shell that drives routines (ADR 0129): one timer armed for the earliest slot, which
//! also wakes at least once a minute so slots a sleeping machine missed catch up when it wakes;
//! and a watcher of ace's thread events, connected while ace is.

use std::sync::Arc;
use std::time::Duration;

use spade_ace::SkillsConfig;
use spade_ace::events::{ThreadWatch, WatchError, watch_threads};

use crate::engine::Engine;

/// The longest the timer sleeps between checks of the clock.
const LONGEST_SLEEP: Duration = Duration::from_secs(60);
const FIRST_RETRY: Duration = Duration::from_secs(1);
const LONGEST_RETRY: Duration = Duration::from_secs(30);

/// Runs routines as their slots come, until the engine is gone. A change to any routine wakes it
/// to re-arm.
pub fn start(engine: &Arc<Engine>) -> tokio::task::JoinHandle<()> {
    let weak = Arc::downgrade(engine);
    tokio::spawn(async move {
        loop {
            let Some(engine) = weak.upgrade() else { return };
            let next = super::tick(&engine).await.unwrap_or_else(|error| {
                tracing::warn!(%error, "routines could not be checked");
                None
            });
            let wait = next.map_or(LONGEST_SLEEP, |at| {
                let ms = u64::try_from(at.saturating_sub(engine.now_ms())).unwrap_or(0);
                Duration::from_millis(ms).min(LONGEST_SLEEP)
            });
            let wake = engine.routines_shared();
            tokio::select! {
                () = tokio::time::sleep(wait) => {}
                () = wake.wake.notified() => {}
            }
        }
    })
}

/// Follows ace's thread events and runs the routines waiting for them. `socket` says where the
/// daemon's WebSocket is now (`None` while ace is away); it is asked again after every drop.
pub fn watch_ace(
    engine: &Arc<Engine>,
    socket: impl Fn() -> Option<SkillsConfig> + Send + Sync + 'static,
) -> tokio::task::JoinHandle<()> {
    let weak = Arc::downgrade(engine);
    tokio::spawn(async move {
        let mut watch = ThreadWatch::new();
        let mut retry = FIRST_RETRY;
        loop {
            if weak.strong_count() == 0 {
                return;
            }
            if let Some(config) = socket() {
                let (changes, mut arrived) = tokio::sync::mpsc::unbounded_channel();
                let follow = watch_threads(&config, &mut watch, |change| {
                    let _ = changes.send(change);
                });
                let deliver = async {
                    while let Some(change) = arrived.recv().await {
                        let Some(engine) = weak.upgrade() else { return };
                        super::fire::thread_changed(&engine, &change).await;
                    }
                };
                let ended = tokio::select! {
                    ended = follow => ended,
                    () = deliver => return,
                };
                // Changes already reported are delivered before reconnecting.
                while let Ok(change) = arrived.try_recv() {
                    let Some(engine) = weak.upgrade() else { return };
                    super::fire::thread_changed(&engine, &change).await;
                }
                match ended {
                    Err(WatchError::Refused) => tracing::info!("ace refused the event stream"),
                    Err(error) => tracing::debug!(%error, "ace's event stream ended"),
                    Ok(()) => {}
                }
            }
            tokio::time::sleep(retry).await;
            retry = (retry * 2).min(LONGEST_RETRY);
        }
    })
}
