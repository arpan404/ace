//! Turning accessibility on for the session, as a screen reader does, and waiting for the apps
//! that only join the AT-SPI bus once it is on (Qt's, so all of KDE).
use std::time::Duration;
use zbus::Connection;
use zbus::zvariant::{OwnedValue, Value};

const STATUS_CALL: Duration = Duration::from_secs(2);
pub const SETTLE_POLL: Duration = Duration::from_millis(50);

/// Sets `org.a11y.Status.IsEnabled` on the session bus. True when it was already on, so no app
/// is about to register; false when this call turned it on (or it could not be read).
pub async fn enable(session: &Connection) -> bool {
    let was_enabled = tokio::time::timeout(
        STATUS_CALL,
        session.call_method(
            Some("org.a11y.Bus"),
            "/org/a11y/bus",
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &("org.a11y.Status", "IsEnabled"),
        ),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .and_then(|reply| reply.body().deserialize::<OwnedValue>().ok())
    .and_then(|value| bool::try_from(value).ok())
    .unwrap_or(false);
    if was_enabled {
        return true;
    }
    let body = ("org.a11y.Status", "IsEnabled", Value::from(true));
    let set = session.call_method(
        Some("org.a11y.Bus"),
        "/org/a11y/bus",
        Some("org.freedesktop.DBus.Properties"),
        "Set",
        &body,
    );
    if let Ok(Err(e)) = tokio::time::timeout(STATUS_CALL, set).await {
        eprintln!("could not set org.a11y.Status.IsEnabled: {e}");
    }
    false
}

/// Polls `count` (the registry's app count) until the apps that register once accessibility
/// turns on have arrived; see [`registry_settled`].
pub async fn await_registrations<F, Fut>(count: F)
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = usize>,
{
    let initial = count().await;
    let mut reads = Vec::new();
    while !registry_settled(initial, &reads) {
        tokio::time::sleep(SETTLE_POLL).await;
        reads.push(count().await);
    }
}

/// Whether the registry has taken in the apps that register once accessibility turns on, given
/// its app count before and at each 50 ms poll since: steady for 150 ms after growing, or
/// 500 ms without growth (nothing was waiting), and never longer than 1.5 s.
pub fn registry_settled(initial: usize, reads: &[usize]) -> bool {
    if reads.len() >= 30 {
        return true;
    }
    let Some(&last) = reads.last() else {
        return false;
    };
    let steady = reads.iter().rev().take_while(|&&count| count == last).count();
    if last > initial { steady >= 3 } else { steady >= 10 }
}

#[cfg(test)]
mod tests {
    use super::registry_settled;

    #[test]
    fn waits_for_apps_that_register_after_accessibility_turns_on() {
        assert!(!registry_settled(1, &[]));
        assert!(!registry_settled(1, &[5, 5]));
        assert!(registry_settled(1, &[5, 5, 5]));
        // A second app still arriving restarts the wait.
        assert!(!registry_settled(1, &[3, 3, 5, 5]));
        assert!(registry_settled(1, &[3, 3, 5, 5, 5]));
    }

    #[test]
    fn gives_up_quickly_when_no_app_was_waiting_and_never_waits_forever() {
        assert!(!registry_settled(4, &[4; 9]));
        assert!(registry_settled(4, &[4; 10]));
        let churning: Vec<usize> = (0..30).map(|i| 2 + i % 2).collect();
        assert!(registry_settled(1, &churning));
    }
}
