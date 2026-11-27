// SPDX-License-Identifier: Apache-2.0
//! The process's lifetime: the signals `runDaemonProcess` installs before startup,
//! and the wait that ends it.

use tokio::sync::mpsc;

/// Why the daemon is stopping, as the run marker and the log record it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StopReason {
    pub source: &'static str,
    pub signal: Option<&'static str>,
}

impl StopReason {
    pub(super) fn signal(name: &'static str) -> Self {
        Self {
            source: "signal",
            signal: Some(name),
        }
    }
}

/// The process's signals, installed before the endpoint is advertised.
#[cfg(unix)]
pub(super) struct Signals {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

#[cfg(unix)]
impl Signals {
    pub(super) fn install() -> Option<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Some(Self {
            interrupt: signal(SignalKind::interrupt()).ok()?,
            terminate: signal(SignalKind::terminate()).ok()?,
        })
    }
}

#[cfg(not(unix))]
struct Signals;

#[cfg(not(unix))]
impl Signals {
    pub(super) fn install() -> Option<Self> {
        Some(Self)
    }
}

/// `waitForStop`: a signal, or a stop request answered by `POST /v1/stop`.
pub(super) async fn wait_for_stop(
    stopped: &mut mpsc::UnboundedReceiver<StopReason>,
    signals: Option<Signals>,
) -> StopReason {
    #[cfg(unix)]
    {
        let Some(mut signals) = signals else {
            return wait_for_request(stopped).await;
        };
        tokio::select! {
            _ = signals.interrupt.recv() => StopReason::signal("SIGINT"),
            _ = signals.terminate.recv() => StopReason::signal("SIGTERM"),
            reason = wait_for_request(stopped) => reason,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = signals;
        tokio::select! {
            _ = tokio::signal::ctrl_c() => StopReason::signal("SIGINT"),
            reason = wait_for_request(stopped) => reason,
        }
    }
}

async fn wait_for_request(stopped: &mut mpsc::UnboundedReceiver<StopReason>) -> StopReason {
    stopped.recv().await.unwrap_or(StopReason {
        source: "close",
        signal: None,
    })
}
