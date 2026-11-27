// SPDX-License-Identifier: Apache-2.0
//! Waiting for a flag without losing the wakeup that sets it (G2a).
//!
//! `Notify::notify_waiters` stores no permit, and a `notified()` future only
//! registers when it is first polled. A waiter that checks a flag and then
//! awaits a fresh future loses a notification fired between the check and the
//! registration, and waits forever. Every waiter here enables its future
//! first, so the check runs with the waiter already registered.

use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

/// Waits until `check` says so, allowing for a wakeup that lands between the
/// check and the wait.
pub async fn wait_until(check: impl Fn() -> bool, notify: &Notify) {
    loop {
        let notified = notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if check() {
            return;
        }
        notified.await;
    }
}

/// [`wait_until`] for the common flag-and-notify pair.
pub async fn wait_for_flag(flag: &AtomicBool, notify: &Notify) {
    wait_until(|| flag.load(Ordering::Acquire), notify).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_wakeup_fired_between_the_check_and_the_old_registration_is_not_lost() {
        // The notifier fires only after the first check asked it to, and the
        // check waits until the notification was sent: with the old order
        // (check, then register) that wakeup lands before registration and is
        // lost; with the enabled future first it is always seen.
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let notify = std::sync::Arc::new(Notify::new());
        let (ask, asked) = std::sync::mpsc::channel::<()>();
        let (sent, was_sent) = std::sync::mpsc::channel::<()>();
        let notifier = {
            let (flag, notify) = (std::sync::Arc::clone(&flag), std::sync::Arc::clone(&notify));
            std::thread::spawn(move || {
                if asked.recv().is_err() {
                    return;
                }
                flag.store(true, Ordering::Release);
                notify.notify_waiters();
                let _ = sent.send(());
            })
        };
        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            wait_until(
                || {
                    if flag.load(Ordering::Acquire) {
                        return true;
                    }
                    let _ = ask.send(());
                    let _ = was_sent.recv();
                    false
                },
                &notify,
            ),
        )
        .await;
        notifier.join().expect("notifier");
        assert!(
            outcome.is_ok(),
            "a wakeup sent between the check and the wait resumed the waiter"
        );
    }

    #[tokio::test]
    async fn a_wakeup_fired_after_the_wait_began_resumes_it() {
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let notify = std::sync::Arc::new(Notify::new());
        let waiter = {
            let (flag, notify) = (std::sync::Arc::clone(&flag), std::sync::Arc::clone(&notify));
            tokio::spawn(async move { wait_for_flag(&flag, &notify).await })
        };
        tokio::task::yield_now().await;
        flag.store(true, Ordering::Release);
        notify.notify_waiters();
        tokio::time::timeout(Duration::from_millis(500), waiter)
            .await
            .expect("woken")
            .expect("waiter");
    }
}
