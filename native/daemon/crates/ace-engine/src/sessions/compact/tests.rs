// SPDX-License-Identifier: Apache-2.0
//! `thread.compact`'s moved cases: `thread-compact.process.test.ts` (ace/context-meter-compact)
//! and the context meter's compaction transitions it relies on.

use super::{THREAD_NOT_IDLE, UNSUPPORTED_COMPACT, admit, compact};
use ace_adapter_api::session::{InterruptTarget, SendInput};
use ace_adapter_api::{AdapterApiError, CloseReason, Reopen, Session};
use ace_core::Key;
use ace_protocol::generated::{ExecutionSelection, GoalChange, InteractionResolution};
use futures::future::LocalBoxFuture;
use std::cell::Cell;

#[test]
fn a_compacting_idle_provider_is_admitted_and_a_working_thread_is_refused() {
    // thread-compact.process.test.ts: an idle thread of a provider with native compaction takes
    // the command; a provider without one is `unsupported_compact` and a working one is
    // `thread_not_idle`.
    assert_eq!(admit(Some(true), "done"), Ok(()));
    assert_eq!(admit(None, "done"), Err(UNSUPPORTED_COMPACT));
    assert_eq!(admit(Some(false), "done"), Err(UNSUPPORTED_COMPACT));
    for status in ["working", "starting", "blocked", "unresponsive"] {
        assert_eq!(admit(Some(true), status), Err(THREAD_NOT_IDLE));
    }
}

struct CompactSession {
    asked: Cell<u32>,
}

impl Session for CompactSession {
    fn native_session_id(&self) -> &str {
        "native"
    }
    fn configure(
        &self,
        _selection: ExecutionSelection,
    ) -> LocalBoxFuture<'_, Result<Option<Reopen>, AdapterApiError>> {
        Box::pin(async { Ok(None) })
    }
    fn set_model(&self, _model: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn set_mode(&self, _mode: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn set_goal(&self, _change: GoalChange) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn clear_goal(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn send(&self, _input: SendInput<'_>) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn interrupt(
        &self,
        _target: InterruptTarget,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn resolve(
        &self,
        _interaction: Key,
        _resolution: InteractionResolution,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn stop_task(&self, _task: Key) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn compact(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        self.asked.set(self.asked.get() + 1);
        Box::pin(async { Ok(()) })
    }
    fn close(&self, _reason: CloseReason) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
}

#[test]
fn the_engine_asks_the_sessions_own_compaction() {
    let session = CompactSession {
        asked: Cell::new(0),
    };
    crate::futures::executor::block_on(compact(&session)).expect("compaction");
    assert_eq!(session.asked.get(), 1);
}

struct PlainSession;

impl Session for PlainSession {
    fn native_session_id(&self) -> &str {
        "native"
    }
    fn configure(
        &self,
        _selection: ExecutionSelection,
    ) -> LocalBoxFuture<'_, Result<Option<Reopen>, AdapterApiError>> {
        Box::pin(async { Ok(None) })
    }
    fn set_model(&self, _model: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn set_mode(&self, _mode: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn set_goal(&self, _change: GoalChange) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn clear_goal(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn send(&self, _input: SendInput<'_>) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn interrupt(
        &self,
        _target: InterruptTarget,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn resolve(
        &self,
        _interaction: Key,
        _resolution: InteractionResolution,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn stop_task(&self, _task: Key) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
    fn close(&self, _reason: CloseReason) -> LocalBoxFuture<'_, Result<(), AdapterApiError>> {
        Box::pin(async { Ok(()) })
    }
}

#[test]
fn a_provider_without_compaction_refuses_at_the_session_too() {
    let error = crate::futures::executor::block_on(compact(&PlainSession)).expect_err("refused");
    assert!(error.to_string().contains("no native compaction"));
}
