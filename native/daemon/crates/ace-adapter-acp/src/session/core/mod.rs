// SPDX-License-Identifier: Apache-2.0
//! The sans-IO ACP session core (`packages/adapter-acp/src/session.ts:118`-`:940`, E3-acp.1):
//! its state, its construction and the effects it hands its shell.
//!
//! The work is split by what each input is: `streams` takes the child's bytes, write
//! acknowledgements and the terminal `finish`; `peers` applies one peer effect, publishing
//! the frame then settling it in frame order; `dispatch` acts on a frame's content
//! (notifications, the agent's own requests, questions and deadlines).

mod dispatch;
mod peers;
mod streams;

use super::configuration::{AcpConfiguration, ConfigurationEffect, ConfigurationLaunch};
use super::deadlines::{DeadlineEffect, Deadlines};
use super::mcp::McpConfig;
use super::negotiation::{CompatibilityProfile, ProfileFit};
use super::open::{OpenState, ResumeTarget};
use super::queue::{ActivePrompt, BatchState, Job, SteerFlight};
use super::quirks::AcpSessionQuirks;
use super::resume_error::{ResumeFailure, ResumeFailureCode};
use super::routing::SessionRouting;
use super::shells::ShellSettlement;
use crate::translate::frame_redaction::redact_lease;
use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::lines::LineFramer;
use ace_supervisor::peer::{PeerConfig, PeerOwner, RpcPeer};
use indexmap::{IndexMap, IndexSet};
use std::collections::VecDeque;

/// Default max line length for supervised stdout/stderr (`process.ts`: 16 MiB).
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// Maximum concurrent incoming interaction requests (`session.ts:806`).
const MAX_PENDING_INTERACTIONS: usize = 128;
/// High bit reserving internal peer call ids so they never collide with facade call ids.
const INTERNAL_CALL_BIT: u64 = 1u64 << 63;

/// Error codes emitted on settled promises from ACP session core.
pub const CODE_OPEN_FAILED: &str = "ACE_ACP_OPEN_FAILED";
pub const CODE_RESUME_UNAVAILABLE: &str = "ACE_ACP_RESUME_UNAVAILABLE";
pub const CODE_RESUME_UNSUPPORTED: &str = "ACE_ACP_RESUME_UNSUPPORTED";
pub const CODE_RPC_ERROR: &str = "ACE_ACP_RPC_ERROR";

/// Structured error carried on a settled call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpErrorWire {
    pub code: &'static str,
    pub message: String,
}

impl AcpErrorWire {
    pub fn open_failed(message: impl Into<String>) -> Self {
        Self {
            code: CODE_OPEN_FAILED,
            message: message.into(),
        }
    }

    pub fn rpc_error(message: impl Into<String>) -> Self {
        Self {
            code: CODE_RPC_ERROR,
            message: message.into(),
        }
    }

    /// The provider refused before taking any of the input
    /// (`ace_adapter_api::bridge::queue::INPUT_REJECTED`).
    pub fn input_rejected(message: impl Into<String>) -> Self {
        Self {
            code: ace_adapter_api::bridge::queue::INPUT_REJECTED,
            message: message.into(),
        }
    }

    /// The turn the input was meant to join ended
    /// (`ace_adapter_api::bridge::queue::STEER_TARGET_LOST`).
    pub fn steer_target_lost(message: impl Into<String>) -> Self {
        Self {
            code: ace_adapter_api::bridge::queue::STEER_TARGET_LOST,
            message: message.into(),
        }
    }

    pub fn resume_failure(failure: ResumeFailure) -> Self {
        let code = match failure.code {
            ResumeFailureCode::ResumeUnavailable => CODE_RESUME_UNAVAILABLE,
            ResumeFailureCode::ResumeUnsupported => CODE_RESUME_UNSUPPORTED,
        };
        Self {
            code,
            message: failure.detail,
        }
    }
}

/// One pending agent-to-client interaction request (`session.ts:43`–`:47`).
#[derive(Debug, Clone)]
pub struct PendingInteraction {
    pub id: RpcId,
    pub method: JsString,
    pub params: Value,
    pub owner: JsString,
}

/// Effects returned by [`AcpCore`] in the exact order state changed.
#[derive(Debug, Clone, PartialEq)]
pub enum AcpEffect {
    Frame {
        dir: FrameDirection,
        channel: String,
        text: String,
    },
    Write {
        wire: Vec<u8>,
        ticket: u64,
    },
    Callback {
        name: &'static str,
        json: String,
    },
    Settle {
        id: u64,
        result: Result<String, AcpErrorWire>,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    Fatal {
        message: String,
    },
    Drained,
}

/// Configuration for constructing an [`AcpCore`].
pub struct AcpCoreConfig {
    pub thread_id: String,
    pub cwd: String,
    pub quirks: AcpSessionQuirks,
    pub version: Option<String>,
    pub profile: Option<CompatibilityProfile>,
    pub profile_fit: Option<ProfileFit>,
    pub resume: Option<ResumeTarget>,
    /// The launch's saved permission mode, model and effort: applied once the session
    /// opens, before its open settles (`session.ts:499`–`:509`).
    pub permission_mode: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub mcp: Option<McpConfig>,
    pub peer_config: PeerConfig,
}

impl AcpCoreConfig {
    pub fn new(
        thread_id: impl Into<String>,
        cwd: impl Into<String>,
        quirks: AcpSessionQuirks,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            cwd: cwd.into(),
            quirks,
            version: None,
            profile: None,
            profile_fit: None,
            resume: None,
            permission_mode: None,
            model: None,
            effort: None,
            mcp: None,
            // ACP publishes every frame as text, so its peer carries each line: the frame
            // is that line, never a re-serialization of the tree it parsed.
            peer_config: PeerConfig {
                frame_text: true,
                ..PeerConfig::default()
            },
        }
    }
}

/// Sans-IO ACP session core (`AcpSession` in `session.ts:118`–`:940`, E3-acp.1 surface).
pub struct AcpCore {
    pub(crate) cwd: String,
    pub(crate) quirks: AcpSessionQuirks,
    pub(crate) launch_version: Option<String>,
    pub(crate) launch_profile: Option<CompatibilityProfile>,
    pub(crate) resume: Option<ResumeTarget>,
    pub(crate) permission_mode: Option<String>,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) mcp: Option<McpConfig>,
    pub(crate) secrets: Vec<String>,

    pub(crate) peer: RpcPeer,
    stdout_framer: LineFramer,
    stderr_framer: LineFramer,
    active_write_ticket: Option<u64>,

    pub configuration: AcpConfiguration,
    pub routing: SessionRouting,
    pub shells: ShellSettlement,
    pub deadlines: Deadlines,
    pub pending: IndexMap<JsString, PendingInteraction>,
    pub(crate) cancelling_children: IndexSet<JsString>,

    /// The prompts waiting for a turn (`session.ts:677`-`:700`, `:704`-`:797`).
    pub(crate) queue: VecDeque<Job>,
    pub(crate) queued_bytes: usize,
    /// A prompt of this session's is in flight: nothing else may go out.
    pub(crate) active: bool,
    pub(crate) active_prompt: Option<ActivePrompt>,
    /// Steering requests awaiting their reply, by internal call (`session.ts:644`-`:663`).
    pub(crate) steering: IndexMap<u64, SteerFlight>,
    /// A selection is running: no prompt goes out meanwhile (`session.ts:707`).
    pub(crate) selecting: bool,
    /// Selections a command asked for, in the order asked (`session.ts:534`-`:540`).
    pub(crate) selection_queue: VecDeque<super::commands::QueuedSelection>,
    pub(crate) selection_flight: Option<super::commands::SelectionFlight>,
    pub(crate) next_batch: u64,
    /// The promises sends settle, with their prompts (`session.ts:609`, `:671`).
    pub(crate) batches: IndexMap<u64, BatchState>,

    pub native_session_id: JsString,
    pub steer_via_cancel: bool,
    /// The mode ace last set; a model's reply that resets it gets it back
    /// (`session.ts:570`–`:586`).
    pub wanted_mode: Option<String>,
    pub loading: bool,
    pub closed: bool,
    pub deliberate: bool,
    pub guided: bool,
    pub fault: Option<String>,

    pub prompt_frames: u64,
    pub prompt_id: Option<RpcId>,
    pub(crate) open_id: Option<RpcId>,
    pub(crate) opening_session: JsString,
    pub(crate) open_stalled: bool,
    pub(crate) open: Option<OpenState>,
    /// The session request `initialize` decided, kept for a sign-in retry (`session.ts:459`).
    next_internal_id: u64,
    pub(crate) process_exited: bool,
    /// The MCP lease was ended, once (`session.ts:912`).
    pub(crate) lease_ended: bool,
}

impl AcpCore {
    /// Construct a new ACP core with a fresh [`PeerOwner`] and emit the initial
    /// `process-start` note (`session.ts:274`).
    pub fn new(config: AcpCoreConfig) -> (Self, Vec<AcpEffect>) {
        let owner = PeerOwner::new(config.peer_config.max_queued_bytes);
        Self::with_owner(config, owner)
    }

    /// Construct a new ACP core over an explicit [`PeerOwner`].
    pub fn with_owner(config: AcpCoreConfig, owner: PeerOwner) -> (Self, Vec<AcpEffect>) {
        let secrets = config
            .mcp
            .as_ref()
            .map(|m| m.secrets.clone())
            .unwrap_or_default();
        let initial_root = config
            .resume
            .as_ref()
            .map(|r| JsString::from(r.native_session_id.as_str()))
            .unwrap_or_default();
        let configuration = AcpConfiguration::new(
            config.quirks.clone(),
            ConfigurationLaunch {
                version: config.version.clone(),
                profile: config.profile.clone(),
                profile_fit: config.profile_fit,
            },
            secrets.clone(),
        );
        let translate_quirks = config.quirks.translate_kind();
        let peer = RpcPeer::with_owner(config.peer_config, owner);
        let mut core = Self {
            cwd: config.cwd,
            quirks: config.quirks,
            launch_version: config.version,
            launch_profile: config.profile,
            resume: config.resume,
            permission_mode: config.permission_mode,
            model: config.model,
            effort: config.effort,
            mcp: config.mcp,
            secrets,
            peer,
            stdout_framer: LineFramer::new(MAX_LINE_BYTES),
            stderr_framer: LineFramer::new(MAX_LINE_BYTES),
            active_write_ticket: None,
            configuration,
            routing: SessionRouting::new(config.thread_id, initial_root),
            shells: ShellSettlement::new(translate_quirks),
            deadlines: Deadlines::new(),
            pending: IndexMap::new(),
            cancelling_children: IndexSet::new(),
            queue: VecDeque::new(),
            queued_bytes: 0,
            active: false,
            active_prompt: None,
            steering: IndexMap::new(),
            selecting: false,
            selection_queue: VecDeque::new(),
            selection_flight: None,
            next_batch: 1,
            batches: IndexMap::new(),
            native_session_id: JsString::default(),
            steer_via_cancel: false,
            wanted_mode: None,
            loading: false,
            closed: false,
            deliberate: false,
            guided: false,
            fault: None,
            prompt_frames: 0,
            prompt_id: None,
            open_id: None,
            opening_session: JsString::default(),
            open_stalled: false,
            open: None,
            next_internal_id: 1,
            process_exited: false,
            lease_ended: false,
        };
        let mut effects = Vec::with_capacity(1);
        let mut start_note = Map::with_capacity(1);
        start_note.insert("event", Value::from("process-start"));
        core.emit_note("recorder", Value::Object(start_note), &mut effects);
        (core, effects)
    }

    pub(crate) fn alloc_internal_id(&mut self) -> u64 {
        let id = INTERNAL_CALL_BIT | self.next_internal_id;
        self.next_internal_id = self.next_internal_id.saturating_add(1);
        id
    }

    pub(crate) fn arm_deadline(&mut self, name: &str, ms: f64, effects: &mut Vec<AcpEffect>) {
        push_deadline_effects(self.deadlines.arm(name, ms), effects);
    }

    pub(crate) fn clear_deadline(&mut self, name: &str, effects: &mut Vec<AcpEffect>) {
        push_deadline_effects(self.deadlines.clear(name), effects);
    }

    pub(crate) fn clear_all_deadlines(&mut self, effects: &mut Vec<AcpEffect>) {
        push_deadline_effects(self.deadlines.clear_all(), effects);
    }

    pub(crate) fn push_config_effects(
        &self,
        cfg_effects: Vec<ConfigurationEffect>,
        effects: &mut Vec<AcpEffect>,
    ) {
        for effect in cfg_effects {
            match effect {
                ConfigurationEffect::OnCapabilities {
                    capabilities,
                    support,
                } => effects.push(AcpEffect::Callback {
                    name: "onCapabilities",
                    json: Value::Array(
                        vec![Value::Object(capabilities), Value::Object(support)].into(),
                    )
                    .to_json(),
                }),
                ConfigurationEffect::OnSessionMetadata { raw } => {
                    effects.push(AcpEffect::Callback {
                        name: "onSessionMetadata",
                        json: Value::Array(vec![raw].into()).to_json(),
                    });
                }
                ConfigurationEffect::OnPermissionMode { mode } => {
                    effects.push(AcpEffect::Callback {
                        name: "onPermissionMode",
                        json: Value::Array(vec![Value::from(mode)].into()).to_json(),
                    });
                }
            }
        }
    }

    pub(crate) fn redact_message(&self, message: &str) -> String {
        match redact_lease(&Value::from(message), &self.secrets) {
            Value::String(text) => text.to_string(),
            other => other.to_json(),
        }
    }
}

fn push_deadline_effects(deadline_effects: Vec<DeadlineEffect>, effects: &mut Vec<AcpEffect>) {
    for effect in deadline_effects {
        match effect {
            DeadlineEffect::Arm { key, ms } => effects.push(AcpEffect::ArmTimer { key, ms }),
            DeadlineEffect::Cancel { key } => effects.push(AcpEffect::CancelTimer { key }),
        }
    }
}
