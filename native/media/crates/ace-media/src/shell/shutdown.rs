// SPDX-License-Identifier: Apache-2.0
//! Shutdown's last phases inside one budget (docs/media/plan.md, "Supervision"): relay closes
//! finish (what they owe the relay, then their sockets), then both lanes drain, together. Every
//! phase gets only what is left of one deadline, so a pending relay close and blocked lanes
//! still end before the supervisor's kill.
use super::relay_sockets::RelaySockets;
use super::writer::Writer;
use std::time::Duration;
use tokio::time::Instant;

pub(super) async fn shutdown_within(
    budget: Duration,
    relays: &mut RelaySockets,
    priority: Option<Writer>,
    stdout: Writer,
) {
    let deadline = Instant::now() + budget;
    let _ = tokio::time::timeout_at(deadline, relays.settled()).await;
    let left = deadline.saturating_duration_since(Instant::now());
    // Nothing left: no lane waits even one timer tick (about 16 ms on Windows) past the budget.
    if left.is_zero() {
        return;
    }
    let priority = async {
        if let Some(priority) = priority {
            priority.close(left).await;
        }
    };
    tokio::join!(priority, stdout.close(left));
}
