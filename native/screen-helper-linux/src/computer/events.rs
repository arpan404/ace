//! AT-SPI events, per app: when each app last changed. The settler waits for an app's events
//! to go quiet instead of sleeping a fixed time.
use crate::computer::bus::Bus;
use crate::computer::cancel::Checkpoint;
use crate::computer::error::CuResult;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::{MatchRule, MessageStream, message::Type};

#[derive(Clone, Default)]
pub struct Activity {
    last: Arc<Mutex<HashMap<String, Instant>>>,
}

impl Activity {
    fn with<R>(&self, f: impl FnOnce(&mut HashMap<String, Instant>) -> R) -> R {
        let mut map = match self.last.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        f(&mut map)
    }

    pub fn record(&self, sender: &str, at: Instant) {
        self.with(|map| {
            if map.len() > 512 {
                map.clear();
            }
            map.insert(sender.to_owned(), at);
        });
    }

    /// When the app last reported a change; marks the app changed now when it acted for us.
    pub fn last(&self, sender: &str) -> Option<Instant> {
        self.with(|map| map.get(sender).copied())
    }

    pub fn mark(&self, sender: &str) {
        self.record(sender, Instant::now());
    }

    /// Listens for object, window and focus events on the accessibility bus.
    pub async fn listen(&self, bus: &Bus) {
        for interface in [
            "org.a11y.atspi.Event.Object",
            "org.a11y.atspi.Event.Window",
            "org.a11y.atspi.Event.Focus",
        ] {
            let Ok(builder) = MatchRule::builder().msg_type(Type::Signal).interface(interface) else {
                continue;
            };
            let stream = match MessageStream::for_match_rule(builder.build(), &bus.conn, Some(1024)).await {
                Ok(stream) => stream,
                Err(e) => {
                    eprintln!("computer: no {interface} events: {e}");
                    continue;
                }
            };
            let activity = self.clone();
            tokio::spawn(async move {
                let mut stream = stream;
                while let Some(Ok(message)) = stream.next().await {
                    if let Some(sender) = message.header().sender() {
                        activity.record(sender.as_str(), Instant::now());
                    }
                }
            });
        }
        bus.register_events().await;
    }

    /// Waits at least `min`, then until the app has been quiet for `quiet`, at most `max`.
    pub async fn settle(
        &self,
        sender: &str,
        min: Duration,
        quiet: Duration,
        max: Duration,
        check: &Checkpoint,
    ) -> CuResult<()> {
        let started = Instant::now();
        loop {
            check.check()?;
            let now = Instant::now();
            let waited = now - started;
            if waited >= max {
                return Ok(());
            }
            let calm = self
                .last(sender)
                .is_none_or(|last| now.saturating_duration_since(last) >= quiet);
            if waited >= min && calm {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// Sleeps in slices of at most 50 ms, checking between them whether to stop.
pub async fn pause(ms: u64, check: &Checkpoint) -> CuResult<()> {
    let mut left = ms;
    check.check()?;
    while left > 0 {
        let slice = left.min(50);
        tokio::time::sleep(Duration::from_millis(slice)).await;
        left -= slice;
        check.check()?;
    }
    Ok(())
}
