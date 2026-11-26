// SPDX-License-Identifier: Apache-2.0
//! Closing: the one sequence that stops every task, ends every session and settles the facade.

use crate::actor;
use crate::core::Core;
use crate::error::EngineError;
use crate::futures::FutureExt;
use crate::recovery;
use std::rc::Rc;

#[derive(Default)]
pub(crate) struct CloseOutcome {
    pub(crate) readiness: Option<EngineError>,
    pub(crate) module: Option<EngineError>,
}

impl Core {
    pub(crate) fn ready_error(&self) -> Option<EngineError> {
        let ready = self.ready.borrow().clone()?;
        match ready.now_or_never() {
            Some(Ok(Err(message))) => Some(EngineError::Registry(message)),
            Some(Err(_)) => Some(EngineError::Closed),
            _ => None,
        }
    }
}

pub(crate) async fn close_sequence(core: Rc<Core>) -> CloseOutcome {
    let mut outcome = CloseOutcome::default();
    core.phase.set("readiness");
    if let Some(ready) = core.ready_future() {
        match ready.await {
            Ok(Ok(())) => {}
            Ok(Err(message)) => outcome.readiness = Some(EngineError::Registry(message)),
            Err(_) => outcome.readiness = Some(EngineError::Closed),
        }
    }
    core.phase.set("actor flush");
    if let Some(rc) = core.self_rc()
        && let Err(error) = actor::close_flush(&rc).await
    {
        outcome.module = Some(error);
    }
    core.phase.set("recovery close");
    core.with_state(recovery::close).ok();
    // Every actor's work is captured before any session closes: closing a provider expires its
    // open requests, so after the close nothing would show the agent was waiting (E5.8).
    if let Err(error) = recovery::capture::capture_all_restarts(&core) {
        outcome.module = Some(error);
    }
    let stall = core.probe_close_stall.borrow_mut().take();
    if let Some(stall) = stall {
        core.phase.set("probe close");
        stall.await;
    }
    core.phase.set("actor stop");
    actor::close_stop(&core);
    core.phase.set("join");
    if !core.admission_closed.replace(true) {
        let drained = core.executor.close_admission();
        let _ = drained.await;
    }
    outcome
}

#[cfg(test)]
mod tests {
    use crate::core::{WAKE_LOG_CAPACITY, Wakes};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Wake, Waker};

    /// Counts the wakes it receives.
    struct Counter(Arc<AtomicUsize>);

    impl Wake for Counter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[test]
    fn the_wake_log_keeps_only_the_newest_labels() {
        let mut wakes = Wakes::default();
        for index in 0..WAKE_LOG_CAPACITY + 7 {
            wakes.record(&format!("t{index}"));
        }
        let log = wakes.log();
        assert_eq!(log.len(), WAKE_LOG_CAPACITY);
        assert_eq!(log.first().map(String::as_str), Some("t7"));
        let newest = format!("t{}", WAKE_LOG_CAPACITY + 6);
        assert_eq!(log.last().map(String::as_str), Some(newest.as_str()));
    }

    #[test]
    fn an_unregistered_thread_keeps_its_log_entries_but_loses_its_waker() {
        let counted = Arc::new(AtomicUsize::new(0));
        let mut wakes = Wakes::default();
        wakes.register(
            "t1".to_string(),
            Waker::from(Arc::new(Counter(Arc::clone(&counted)))),
        );
        if let Some(waker) = wakes.record("t1") {
            waker.wake();
        }
        assert_eq!(counted.load(Ordering::SeqCst), 1);
        wakes.unregister("t1");
        assert_eq!(wakes.registered(), 0);
        assert!(wakes.record("t1").is_none(), "the actor's waker is gone");
        assert_eq!(counted.load(Ordering::SeqCst), 1, "it is not woken again");
        assert_eq!(wakes.log(), vec!["t1", "t1"]);
    }
}
