// SPDX-License-Identifier: Apache-2.0
//! `settled-trees.ts` (E5.10): how a settle leaves a thread's queue, which inputs a settled tree
//! retires, and the fence that stops a settle the person has already undone. Settling says the
//! person is done, so nothing the tree started keeps running; a part that fails to stop is the
//! daemon's to report, never the person's.

use crate::{Core, EngineError, State};

/// How a settle leaves a thread's queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueHold {
    pub paused: bool,
    pub reason: Option<String>,
}

/// A send that failed, or may have gone, keeps its own hold and reason: it is not retried now,
/// and it still says why it waits.
const KEPT_REASONS: [&str; 3] = ["not_sent", "model_unavailable", "uncertain"];

/// `settledHold`: with nothing to send the queue is released; anything else still to send, the
/// person's messages and child results alike, is held as stopped.
pub fn settled_hold(paused: bool, reason: Option<&str>, waiting_sends: i64) -> QueueHold {
    if waiting_sends == 0 {
        return QueueHold {
            paused: false,
            reason: None,
        };
    }
    if paused
        && let Some(reason) = reason
        && KEPT_REASONS.contains(&reason)
    {
        return QueueHold {
            paused: true,
            reason: Some(reason.to_owned()),
        };
    }
    QueueHold {
        paused: true,
        reason: Some("stopped".to_owned()),
    }
}

/// `latestIntent`: the newest command the thread took, by intent id.
pub fn latest_intent(core: &Core, id: &str) -> Result<i64, EngineError> {
    Ok(
        crate::intents::header::headers(core.store.conn(), Some(id), None)?
            .iter()
            .map(|intent| intent.id)
            .max()
            .unwrap_or(0),
    )
}

/// `newDelivery`: the person sent to the thread (or switched, merged, resumed it) after it was
/// settled, so the settle is theirs to undo no longer.
pub fn new_delivery(core: &Core, id: &str, mark: i64) -> Result<bool, EngineError> {
    Ok(
        crate::intents::header::headers(core.store.conn(), Some(id), None)?
            .iter()
            .any(|intent| {
                intent.id > mark
                    && crate::liveness::resumable(&intent.kind)
                    && intent.kind != "thread.limit"
            }),
    )
}

/// `retireLiveIntents`: inputs that need a live session end with it; queued sends wait for the
/// thread's next run.
pub fn retire_live_intents(core: &Core, state: &mut State, id: &str) -> Result<(), EngineError> {
    for intent in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
        if crate::liveness::resumable(&intent.kind) {
            continue;
        }
        crate::intents::lifecycle::mark(
            &core.store,
            &intent,
            "failed",
            Some("The thread was settled"),
        )?;
        state.transition_release_guards(&core.store, &intent.command_id)?;
    }
    Ok(())
}

/// The settle's own hold as the queue patch a write takes.
pub fn hold_patch(hold: &QueueHold) -> String {
    format!(
        r#"{{"paused":{},"reason":{},"resumeAt":null,"timerAction":null}}"#,
        hold.paused,
        hold.reason
            .as_deref()
            .map_or("null".to_owned(), |reason| format!("\"{reason}\""))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_settle_holds_what_is_still_to_send_as_stopped_and_keeps_a_failed_holds_reason() {
        let released = settled_hold(false, None, 0);
        assert_eq!(
            released,
            QueueHold {
                paused: false,
                reason: None
            }
        );
        let stopped = settled_hold(false, None, 2);
        assert_eq!(stopped.reason.as_deref(), Some("stopped"));
        assert!(stopped.paused);
        // A send that failed, or may have gone, keeps its own reason.
        for reason in KEPT_REASONS {
            let kept = settled_hold(true, Some(reason), 1);
            assert_eq!(kept.reason.as_deref(), Some(reason), "{reason}");
            assert!(kept.paused);
        }
        // Any other reason becomes stopped: a paused manual hold with nothing to say is not kept.
        assert_eq!(
            settled_hold(true, Some("manual"), 1).reason.as_deref(),
            Some("stopped")
        );
    }

    #[test]
    fn only_a_new_resumable_delivery_undoes_a_settle() {
        let conn = home("t", &header("t"));
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(Pump),
            &conn,
            std::rc::Rc::new(crate::actor::ActorDeps::production(
                std::rc::Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .expect("engine");
        let core = engine.core();
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('a','t','thread.send','{}','pending','queue',1)",
        )
        .unwrap();
        let mark = latest_intent(core, "t").unwrap();
        assert!(!new_delivery(core, "t", mark).unwrap());
        // A control the settle itself retired does not undo it.
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('b','t','thread.interrupt','{}','pending','queue',2)",
        )
        .unwrap();
        assert!(!new_delivery(core, "t", mark).unwrap());
        // A send does; a limit does not.
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('c','t','thread.limit','{}','pending','queue',3)",
        )
        .unwrap();
        assert!(!new_delivery(core, "t", mark).unwrap());
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('d','t','thread.send','{}','pending','queue',4)",
        )
        .unwrap();
        assert!(new_delivery(core, "t", mark).unwrap());
    }

    struct Pump;

    impl crate::executor::Notifier for Pump {
        fn notify(&self) -> crate::executor::Notified {
            crate::executor::Notified::Posted
        }
    }
}
