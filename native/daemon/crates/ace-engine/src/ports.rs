// SPDX-License-Identifier: Apache-2.0
//! The engine's ports (E5.1 step 5): one method per `EngineOptions` port, all synchronous Rust
//! calls on the JS thread. An async port returns a `LocalBoxFuture` the binding completes from
//! the JS promise's `then`; a port called with no JavaScript environment in scope (only possible
//! from a tokio thread, a bug) returns [`PortError::NoEnv`], and no port panics.
//!
//! E5.1 calls the clock, the timers, the id service, `onError`, `providersActivated`,
//! `waitForProvider`, the facade's promise resolvers and the store seam. The rest are declared
//! here so the later items never edit this file: each carries the TypeScript port's payload as
//! JSON, and an object port (models, recovery, transitions, sessionContext, mcp, aceToolAction,
//! permissionSettings, worktreeGit, prepareInput, sessionCatalog) is held as an opaque
//! [`PortObject`] the owning item's binding module calls. Until an item binds its port, a call
//! returns [`PortError::Unbound`], naming it.

use futures::channel::oneshot;
use futures::future::LocalBoxFuture;

/// A port call that could not be made.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PortError {
    /// No JavaScript environment is in scope (a call from a tokio thread).
    #[error("engine port called with no JavaScript environment")]
    NoEnv,
    /// The JavaScript port threw; the message is the error's text.
    #[error("{0}")]
    Threw(String),
    /// The owning item has not bound this port yet.
    #[error("engine port {0} is not bound")]
    Unbound(&'static str),
}

/// One armed timer: its key (to cancel it) and the receiver that resolves when it fires.
pub struct Timer {
    pub key: u64,
    pub fired: oneshot::Receiver<()>,
}

/// An open transaction, as the shell opened it: the shell's frame handle, and whether it is the
/// top-level frame.
pub struct OpenFrame {
    pub token: u64,
    pub outermost: bool,
}

/// A JavaScript object held by reference: an `EngineOptions` port with methods. The owning
/// item's binding module calls into it; E5.1 only carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortObject(pub u32);

/// Every `EngineOptions` port. All synchronous on the JS thread; async ones return a future.
pub trait Ports {
    // ---- The clock and its timers (E5.1) ----
    fn now(&self) -> f64;
    /// `clock.setTimer`: one shot, cancelled by `cancel_timer`. A firing is a producer, so the
    /// waiting task resumes in the next pump, never inside the firing.
    fn set_timer(&self, ms: f64) -> Timer;
    fn cancel_timer(&self, key: u64);
    /// Close's terminal path: every remaining timer is cancelled and its waiting task released.
    fn cancel_all_timers(&self);
    /// `batchScheduler.setTimer`, the second timer service (E5.2's 1 ms batch latency).
    fn set_batch_timer(&self, ms: f64) -> Timer;

    // ---- The id service (E5.1) ----
    fn thread_id(&self) -> String;
    fn command_id(&self) -> String;
    /// `options.ids`, else the Rust UUIDv7 of `time-ordered-id.ts` (its clock and random bytes
    /// come from the binding).
    fn next_id(&self, kind: &str) -> String;

    // ---- Reporting and readiness (E5.1) ----
    fn report(&self, error: String);
    fn providers_activated(&self) -> LocalBoxFuture<'static, Result<(), PortError>>;
    fn wait_for_provider(&self, provider: &str) -> LocalBoxFuture<'static, Result<(), PortError>>;
    /// Settles the facade's cached `ready()` promise; `Some` rejects it.
    fn resolve_ready(&self, error: Option<String>);
    /// Settles the facade's cached `close()` promise; `Some` rejects it.
    fn resolve_close(&self, error: Option<String>);

    // ---- The store seam (E5.1 step 8) ----
    /// The shared stack's `is_open`.
    fn is_transaction_open(&self) -> bool;
    /// The shell's `open`: flush, context push, stack begin.
    fn open_transaction(&self) -> Result<OpenFrame, PortError>;
    /// The shell's `close`: finish the frame, publish, settle, release the frame's wakes.
    fn close_transaction(&self, frame: u64, threw: Option<String>) -> Result<(), PortError>;
    /// The shell's `append`: the batch joins the open context's event list exactly once.
    fn append_events(&self, json: &str) -> Result<(), PortError>;

    // ---- The terminal cleanup (E5.1 step 4) ----
    /// Settles one facade promise the binding made for a call: `Some` rejects it.
    fn settle_call(&self, call: u64, error: Option<String>);
    /// Rejects every pending facade promise except close's with `ACE_ENGINE_CLOSED`.
    fn reject_pending(&self);
    /// Zero the holder count and release the threadsafe function.
    fn finish_close(&self);

    // ---- Declared for later items ----
    /// `options.transitions` (E5.9).
    fn transitions(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("transitions"))
    }
    /// `options.recovery`, the recovery ports (E5.8).
    fn recovery(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("recovery"))
    }
    /// `options.preferences`, as `RecoveryPreferences` JSON (E5.8).
    fn preferences(&self) -> Result<String, PortError> {
        Err(PortError::Unbound("preferences"))
    }
    /// `options.previousProcessesUnverified` (E5.8).
    fn previous_processes_unverified(&self) -> bool {
        false
    }
    /// `options.cursorPreviousProcessesGone` (E5.8).
    fn cursor_previous_processes_gone(&self) -> LocalBoxFuture<'static, Result<bool, PortError>> {
        Box::pin(async { Err(PortError::Unbound("cursorPreviousProcessesGone")) })
    }
    /// `options.cursorReconcileRetryMs` (E5.8).
    fn cursor_reconcile_retry_ms(&self) -> Result<String, PortError> {
        Err(PortError::Unbound("cursorReconcileRetryMs"))
    }
    /// `options.cursorFailureTimer` (E5.8).
    fn cursor_failure_timer(&self, _json: &str) -> Result<u64, PortError> {
        Err(PortError::Unbound("cursorFailureTimer"))
    }
    /// `options.prepareInput` (E5.5).
    fn prepare_input(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("prepareInput"))
    }
    /// `options.beforeSend` (E5.5).
    fn before_send(
        &self,
        _thread: &str,
        _command: &str,
    ) -> LocalBoxFuture<'static, Result<(), PortError>> {
        Box::pin(async { Err(PortError::Unbound("beforeSend")) })
    }
    /// `options.worktreeGit` (E5.5).
    fn worktree_git(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("worktreeGit"))
    }
    /// `options.prepareWorkspace` (E5.6).
    fn prepare_workspace(
        &self,
        _thread: &str,
        _json: &str,
    ) -> LocalBoxFuture<'static, Result<String, PortError>> {
        Box::pin(async { Err(PortError::Unbound("prepareWorkspace")) })
    }
    /// `options.assertWorkspaceAvailable` (E5.6).
    fn assert_workspace_available(
        &self,
        _cwd: &str,
        _thread: &str,
    ) -> LocalBoxFuture<'static, Result<(), PortError>> {
        Box::pin(async { Err(PortError::Unbound("assertWorkspaceAvailable")) })
    }
    /// `options.models` (E5.6).
    fn models(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("models"))
    }
    /// `options.mcp` (E5.6).
    fn mcp(&self, _thread: &str, _agent: &str, _json: &str) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("mcp"))
    }
    /// `options.sessionContext` (E5.6).
    fn session_context(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("sessionContext"))
    }
    /// `options.sessionCatalog` (E5.6).
    fn session_catalog(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("sessionCatalog"))
    }
    /// `options.agentHome` (E5.6).
    fn agent_home(&self) -> Result<String, PortError> {
        Err(PortError::Unbound("agentHome"))
    }
    /// `options.permissionSettings` (E5.6).
    fn permission_settings(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("permissionSettings"))
    }
    /// `options.resolveSilenceMs` (E5.6).
    fn resolve_silence_ms(
        &self,
        _json: &str,
    ) -> LocalBoxFuture<'static, Result<String, PortError>> {
        Box::pin(async { Err(PortError::Unbound("resolveSilenceMs")) })
    }
    /// `options.onCommandEvent` (E5.6).
    fn on_command_event(&self, _json: &str) {}
    /// `options.onSessionOpenFailure` (E5.6).
    fn on_session_open_failure(&self, _thread: &str, _json: &str) {}
    /// `options.onProviderDiagnostic` (E5.6).
    fn on_provider_diagnostic(&self, _thread: &str, _json: &str) {}
    /// `options.onModelUnavailable` (E5.6).
    fn on_model_unavailable(&self, _provider: &str, _model: &str, _instance: Option<&str>) {}
    /// `options.selectInstance` (E5.4).
    fn select_instance(&self, _provider: &str, _backend: Option<&str>) -> Option<String> {
        None
    }
    /// `options.providerEnabled` (E5.4).
    fn provider_enabled(&self, _provider: &str, _instance: Option<&str>) -> bool {
        true
    }
    /// `options.machine` (E5.4).
    fn machine(&self) -> Result<String, PortError> {
        Err(PortError::Unbound("machine"))
    }
    /// `options.onNamingPrompt` (E5.4).
    fn on_naming_prompt(&self, _thread: &str, _json: &str) {}
    // ---- The engine's persistence seams (E5.3) ----
    /// `store.appendEvents(threadId, payloads, at)`: the store's one event writer, run inside
    /// the open transaction. The engine never writes event rows itself (Decision 1).
    fn write_events(&self, _thread: &str, _payloads_json: &str, _at: f64) -> Result<(), PortError> {
        Err(PortError::Unbound("writeEvents"))
    }
    /// `store.headSeq()`: one number, no JSON.
    fn head_seq(&self) -> Result<f64, PortError> {
        Err(PortError::Unbound("headSeq"))
    }
    /// `store.hasLiveWrite(threadId)`: whether a buffered live write is pending.
    fn has_live_write(&self, _thread: &str) -> Result<bool, PortError> {
        Err(PortError::Unbound("hasLiveWrite"))
    }
    /// `store.rollbackGeneration()`: one number, no JSON. Bumped by every rollback.
    fn rollback_generation(&self) -> Result<f64, PortError> {
        Err(PortError::Unbound("rollbackGeneration"))
    }
    /// `store.getThread(id)`: the thread row as JSON (`provider-facts.ts:59`).
    fn get_thread(&self, _thread: &str) -> Result<Option<String>, PortError> {
        Err(PortError::Unbound("getThread"))
    }
    /// `store.capRaw(raw, threadId)` (E5.2).
    fn cap_raw(&self, _thread: &str, _raw: &str) -> Result<String, PortError> {
        Err(PortError::Unbound("capRaw"))
    }
    /// `store.bufferLiveWrite(id, events, now, {persist, committed})` (E5.2 owns the buffer).
    /// E5.3 owns only the callbacks, which run as binding entries keyed by the returned token.
    fn buffer_live_write(
        &self,
        _thread: &str,
        _events_json: &str,
        _at: f64,
        _token: u64,
    ) -> Result<(), PortError> {
        Err(PortError::Unbound("bufferLiveWrite"))
    }
    /// `store.prepareLiveWrite(bytes)` (E5.2).
    fn prepare_live_write(&self, _bytes: f64) -> Result<(), PortError> {
        Err(PortError::Unbound("prepareLiveWrite"))
    }
    /// The engine's listener on the store's quarantine notification (E5.2's discard path).
    /// The shell calls back into [`crate::Core::quarantined`].
    fn subscribe_quarantine(&self, _token: u64) -> Result<(), PortError> {
        Err(PortError::Unbound("subscribeQuarantine"))
    }

    /// `options.aceToolAction` (E5.3).
    fn ace_tool_action(&self) -> Result<PortObject, PortError> {
        Err(PortError::Unbound("aceToolAction"))
    }
    /// `options.onSettleCleanupFailure` (E5.10).
    fn on_settle_cleanup_failure(&self, _thread: &str, _error: String) {}
}
