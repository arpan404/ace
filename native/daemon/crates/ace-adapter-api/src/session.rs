// SPDX-License-Identifier: Apache-2.0
//! Sessions: the bridge between the engine and one provider process. The fence
//! is checked where the write is admitted, in one synchronous step, with no
//! await between them; a Stop decided after admission is queued behind the
//! write. E3 ports each provider's session onto this trait.

use ace_core::Key;
use ace_protocol::generated::{ContentPart, ExecutionSelection, GoalChange, InteractionResolution};
use futures::future::LocalBoxFuture;

use crate::error::AdapterApiError;

/// How a send joins the provider: `"queue"` waits for the run to end,
/// `"steer"` joins the running turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Steer,
    Queue,
}

/// Whose input a send carries when it is not the person's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputSource {
    /// ace's own input (child results, notices).
    Ace,
    /// Anything else the person didn't send.
    Agent,
}

/// A person's steer aimed at one turn. Checked synchronously right before the
/// write; a steer with no fence behaves as it always has.
pub trait SteerFence {
    /// The provider's own id for the turn the steer is aimed at, when it has one.
    fn turn(&self) -> Option<&str>;
    /// Whether that turn is still the one running, read now.
    fn current(&self) -> bool;
}

/// Throws `SteerTargetLost` when a fenced steer's turn is no longer current.
/// Call synchronously right before the write.
pub fn assert_steer_target(
    delivery: Delivery,
    fence: Option<&dyn SteerFence>,
) -> Result<(), AdapterApiError> {
    let fenced = match fence {
        Some(fence) => fence,
        None => return Ok(()),
    };
    if delivery == Delivery::Steer && !fenced.current() {
        return Err(AdapterApiError::SteerTargetLost(
            "The turn this message was meant to join has ended".to_owned(),
        ));
    }
    Ok(())
}

/// Which agents an interrupt reaches.
pub struct InterruptTarget {
    pub agent: Option<Key>,
    pub cascade: bool,
}

/// Why a session closes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    Idle,
    User,
    Shutdown,
}

/// What `send` carries. Borrowed: admission encodes and redacts before the
/// write is queued, in the same step as the fence check.
pub struct SendInput<'a> {
    pub input: &'a [ContentPart],
    pub delivery: Delivery,
    pub command_id: Option<&'a str>,
    pub origin: Option<InputSource>,
    pub fence: Option<&'a dyn SteerFence>,
}

/// The daemon-owned data a session opens with. The live callbacks (`onFrame`,
/// `onExit`, identity and capability reports) travel on the session's ordered
/// event queue in E3, never as fields here.
pub struct SessionContext {
    pub thread_id: String,
    pub cwd: String,
    /// Instance-specific environment for every owned provider process.
    pub env: Vec<(String, String)>,
    /// Persist this assignment with the native session ID; resume reuses it.
    pub instance_id: Option<String>,
    pub model: Option<String>,
    /// Daemon-owned executable override; never from wire session data.
    pub executable: Option<String>,
    /// Host-local selected account home, never a client credential selector.
    pub instance_home_dir: Option<String>,
    /// Which generation of the thread's provider-private session store to use.
    pub store_generation: Option<u64>,
    /// Resume a saved native session, exclusive with fork.
    pub resume_native_session_id: Option<String>,
}

impl SessionContext {
    /// The least a session needs: whose thread, and where it runs.
    pub fn new(thread_id: String, cwd: String) -> Self {
        SessionContext {
            thread_id,
            cwd,
            env: Vec::new(),
            instance_id: None,
            model: None,
            executable: None,
            instance_home_dir: None,
            store_generation: None,
            resume_native_session_id: None,
        }
    }
}

/// One open provider session. Session methods return `LocalBoxFuture`: the
/// engine's executor is single-threaded, and backpressure never crosses
/// threads except through the ordered event queue.
pub trait Session {
    /// A person's steer requires cancelling the active prompt first.
    fn steer_via_cancel(&self) -> bool {
        false
    }

    fn native_session_id(&self) -> &str;
    fn session_confirmed(&self) -> bool {
        false
    }

    fn configure(
        &self,
        selection: ExecutionSelection,
    ) -> LocalBoxFuture<'_, Result<Option<Reopen>, AdapterApiError>>;
    fn set_model(&self, model: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn set_mode(&self, mode: String) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn set_goal(&self, change: GoalChange) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn clear_goal(&self) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn send(&self, input: SendInput<'_>) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn interrupt(&self, target: InterruptTarget)
    -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn resolve(
        &self,
        interaction: Key,
        resolution: InteractionResolution,
    ) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn stop_task(&self, task: Key) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
    fn close(&self, reason: CloseReason) -> LocalBoxFuture<'_, Result<(), AdapterApiError>>;
}

/// `configure` answers `reopen` before changing anything when the selection
/// needs a fresh native connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reopen {
    Reopen,
}
