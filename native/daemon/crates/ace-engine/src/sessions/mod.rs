// SPDX-License-Identifier: Apache-2.0
//! E5.6: the engine's provider sessions. This unit holds the decisions a session's open makes
//! (provider errors, failure copy, the environment, the open route and its startup skips) and the
//! stored bindings the session reads; the open flow itself lands with the provider-session trait.
//!
//! Moved cases: `agent-env.test.ts`, and the pure halves of `open-failure.process.test.ts`.

use ace_json::Value;

use crate::executor::TaskId;
use crate::repository::collaborators::{SessionFacts, SessionInfo};
use crate::{EngineError, EngineStore, State};

/// The engine's session interface, in the shape E5.6 consumes (declared by E3-pi.3): a session
/// hands its frames, identity, failure and terminal exit to one `SessionObserver`, in order.
pub use ace_adapter_api::{SessionExit, SessionFrame, SessionObserver};

/// The open sessions (E5.6).
#[derive(Debug, Default)]
pub struct Sessions;

pub mod background_ports;
pub mod compact;
pub mod env;
pub mod errors;
pub mod failure_copy;
pub mod metadata;
pub mod observer;
pub mod open;
pub mod provider_sessions;

pub use provider_sessions::{LeftSession, ProviderSessions};

/// `silence.prepareGlobal()`: the resolver's global setting, when the engine has one. The async
/// ready step that awaits it lands with the session open flow.
pub fn prepare_silence(_state: &mut State) -> Result<(), EngineError> {
    Ok(())
}

/// Whether sessions hold no work E5.1 must wait for.
pub fn quiescent(_state: &State, _exclude: Option<TaskId>) -> bool {
    true
}

impl SessionFacts for State {
    /// `session(id)`: the stored binding a fold, a queue read and a capability read share.
    fn session(&mut self, store: &EngineStore, thread: &str) -> Result<SessionInfo, EngineError> {
        let metadata = metadata::session(store, thread)?;
        Ok(SessionInfo {
            model: metadata.model,
            native_session_id: metadata.native_session_id,
            backend: metadata.backend,
        })
    }

    fn shape_provider_error(
        &mut self,
        fact: Value,
        provider: &str,
        model: Option<&str>,
    ) -> Result<Value, EngineError> {
        Ok(errors::shape_provider_error(fact, provider, model))
    }

    fn structured_error(&mut self, error: Value, provider: &str) -> Result<Value, EngineError> {
        Ok(errors::structured_error(error, provider, None))
    }

    fn observe_context(
        &mut self,
        store: &EngineStore,
        thread: &str,
        process_started: bool,
        events: &[Value],
        at: f64,
        instance: Option<&str>,
    ) -> Result<(), EngineError> {
        self.observe_context_batch(store, thread, process_started, events, at, instance)
    }
}

#[cfg(test)]
mod tests;
