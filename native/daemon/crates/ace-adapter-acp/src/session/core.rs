// SPDX-License-Identifier: Apache-2.0
//! The sans-IO ACP session core (`packages/adapter-acp/src/session.ts:118`-`:940`, E3-acp.1).
//!
//! Runs over `ace_supervisor::peer::{RpcPeer, PeerOwner}` and `ace_supervisor::lines::LineFramer`.
//! Settlement (`sending`, `replied`, `prompt_ended`) runs immediately inside the peer's
//! `PeerEffect::Frame` handler, in frame order, before any subsequent notification or reply in
//! the same stdout chunk.

use std::collections::HashSet;

use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::RpcId;
use ace_supervisor::lines::{LineFramer, restore};
use ace_supervisor::peer::{
    Direction, INTERNAL_ERROR, PeerConfig, PeerEffect, PeerError, PeerOwner, RpcPeer, Timeout,
};
use indexmap::{IndexMap, IndexSet};

use super::configuration::{AcpConfiguration, ConfigurationEffect, ConfigurationLaunch};
use super::deadlines::{DeadlineEffect, Deadlines};
use super::frames::{capture_frame, capture_text_frame};
use super::mcp::McpConfig;
use super::negotiation::{CompatibilityProfile, ProfileFit};
use super::open::{OPEN_STALL_MS, OpenState, ResumeTarget};
use super::protocol::{agent_methods, client_methods};
use super::quirks::AcpSessionQuirks;
use super::resume_error::{ResumeFailure, ResumeFailureCode};
use super::routing::SessionRouting;
use super::shells::ShellSettlement;
use crate::translate::approval::interaction_key;
use crate::translate::data::{js_string, object, string};
use crate::translate::frame_redaction::redact_lease;
use crate::translate::interactions::interaction_request;
use crate::translate::requests::request_tool;
use crate::translate::settlement::{CANCELLATION_GRACE_MS, prompt_end};

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
            peer_config: PeerConfig::default(),
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
    secrets: Vec<String>,

    pub(crate) peer: RpcPeer,
    stdout_framer: LineFramer,
    stderr_framer: LineFramer,
    active_write_ticket: Option<u64>,

    pub configuration: AcpConfiguration,
    pub routing: SessionRouting,
    pub shells: ShellSettlement,
    pub deadlines: Deadlines,
    pub pending: IndexMap<JsString, PendingInteraction>,
    cancelling_children: IndexSet<JsString>,

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
    next_internal_id: u64,
    process_exited: bool,
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

    /// Issue a JSON-RPC request through the underlying [`RpcPeer`].
    pub fn request(
        &mut self,
        method: &str,
        params: Option<&Value>,
        facade_id: u64,
        timeout: Timeout,
    ) -> Result<Vec<AcpEffect>, PeerError> {
        let peer_effects = self.peer.request(method, params, facade_id, timeout)?;
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        Ok(effects)
    }

    /// Issue a JSON-RPC notification through the underlying [`RpcPeer`].
    pub fn notify(
        &mut self,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Vec<AcpEffect>, PeerError> {
        let peer_effects = self.peer.notify(method, params)?;
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        Ok(effects)
    }

    /// Feed raw bytes from the child's stdout.
    pub fn stdout_bytes(&mut self, chunk: &[u8]) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        match self.stdout_framer.push(chunk) {
            Ok(framed) => {
                if framed.count > 0 {
                    for raw_line in framed.text.split('\n') {
                        let line = restore(raw_line);
                        let peer_effects = self.peer.line(&line);
                        self.apply_peer_effects(peer_effects, &mut effects);
                    }
                }
            }
            Err(message) => self.fail(&message, &mut effects),
        }
        effects
    }

    /// Feed raw bytes from the child's stderr.
    pub fn stderr_bytes(&mut self, chunk: &[u8]) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        match self.stderr_framer.push(chunk) {
            Ok(framed) => {
                if framed.count > 0 {
                    for raw_line in framed.text.split('\n') {
                        let line = restore(raw_line);
                        self.emit_text_frame(FrameDirection::Stderr, "stdio", &line, &mut effects);
                    }
                }
            }
            Err(message) => self.fail(&message, &mut effects),
        }
        effects
    }

    /// Acknowledge the currently active stdin write (`OutputConsumer::stdin_written`).
    pub fn stdin_written(&mut self) -> Vec<AcpEffect> {
        let Some(ticket) = self.active_write_ticket.take() else {
            return Vec::new();
        };
        self.written(ticket)
    }

    /// Acknowledge a specific write ticket on [`RpcPeer`].
    pub fn written(&mut self, ticket: u64) -> Vec<AcpEffect> {
        if self.active_write_ticket == Some(ticket) {
            self.active_write_ticket = None;
        }
        let peer_effects = self.peer.written(ticket);
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        effects
    }

    /// Stdin write failed (`OutputConsumer::stdin_error`).
    pub fn stdin_error(&mut self, message: &str) -> Vec<AcpEffect> {
        self.active_write_ticket = None;
        let mut effects = Vec::new();
        self.fail(message, &mut effects);
        effects
    }

    /// Stdout stream ended (`session.ts:334`–`:337`).
    pub fn stdout_closed(&mut self) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        let trailing = self.stdout_framer.finish();
        if trailing.count > 0 {
            for raw_line in trailing.text.split('\n') {
                let line = restore(raw_line);
                let peer_effects = self.peer.line(&line);
                self.apply_peer_effects(peer_effects, &mut effects);
            }
        }
        if !self.closed && !self.process_exited {
            self.fail(
                "ACP transport stdout closed before process termination",
                &mut effects,
            );
        }
        effects
    }

    /// Mark that the child process leader has exited (before `close` barrier).
    ///
    /// The pipes may still drain, so frames keep being captured, but no work is
    /// accepted from here: a buffered reply must not resolve a call the exit
    /// already ended (`jsonrpc.ts:265`, `:270`–`:272`, `#end`).
    pub fn mark_exited(&mut self) -> Vec<AcpEffect> {
        self.process_exited = true;
        let peer_effects = self.peer.stop_requests("process exited");
        let mut effects = Vec::new();
        self.apply_peer_effects(peer_effects, &mut effects);
        effects
    }

    /// Handle a fired timer (either a [`Deadlines`] timer or an [`RpcPeer`] request timeout).
    pub fn timer(&mut self, key: &str) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        if let Some(logical) = self.deadlines.fire(key) {
            self.handle_deadline(&logical, &mut effects);
            return effects;
        }
        let peer_effects = self.peer.timer(key);
        self.apply_peer_effects(peer_effects, &mut effects);
        effects
    }

    /// No child will ever report (the spawn threw): fail every pending call, then
    /// publish `Drained` so each promise settles and the close barrier opens.
    pub fn abandon(&mut self) -> Vec<AcpEffect> {
        let mut effects = self.fail_session("ACP session abandoned before start");
        effects.push(AcpEffect::Drained);
        effects
    }

    /// Fail the session (`session.ts:338`–`:355`). Idempotent once closed.
    pub fn fail_session(&mut self, message: &str) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        self.fail(message, &mut effects);
        effects
    }

    /// Terminal barrier when the child's pipes have closed (`session.ts:256`–`:272`).
    pub fn finish(&mut self, exit_detail: Value, exit_summary: &str) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        // Flush any remaining partial lines before draining.
        let out_tail = self.stdout_framer.finish();
        if out_tail.count > 0 {
            for raw_line in out_tail.text.split('\n') {
                let line = restore(raw_line);
                let peer_effects = self.peer.line(&line);
                self.apply_peer_effects(peer_effects, &mut effects);
            }
        }
        let err_tail = self.stderr_framer.finish();
        if err_tail.count > 0 {
            for raw_line in err_tail.text.split('\n') {
                let line = restore(raw_line);
                self.emit_text_frame(FrameDirection::Stderr, "stdio", &line, &mut effects);
            }
        }

        self.process_exited = true;
        self.closed = true;
        self.clear_all_deadlines(&mut effects);
        self.cancel_questions(None, None, &mut effects);

        let peer_effects = self.peer.close("ACP process exited");
        self.apply_peer_effects(peer_effects, &mut effects);
        self.fail_open(
            AcpErrorWire::open_failed("ACP process exited"),
            &mut effects,
        );

        let mut detail = object(&exit_detail).clone();
        detail.insert("deliberate", Value::Bool(self.deliberate));
        let mut note = Map::with_capacity(2);
        note.insert("event", Value::from("process-exit"));
        note.insert("detail", Value::Object(detail));
        self.emit_note("recorder", Value::Object(note), &mut effects);

        let mut on_exit = Map::with_capacity(2);
        on_exit.insert("deliberate", Value::Bool(self.deliberate));
        on_exit.insert(
            "message",
            Value::from(format!("ACP process exited: {exit_summary}")),
        );
        effects.push(AcpEffect::Callback {
            name: "onExit",
            json: Value::Array(vec![Value::Object(on_exit)].into()).to_json(),
        });
        effects.push(AcpEffect::Drained);
        effects
    }

    pub(crate) fn fail(&mut self, message: &str, effects: &mut Vec<AcpEffect>) {
        if self.closed {
            return;
        }
        let clean_msg = self.redact_message(message);
        self.fault = Some(clean_msg.clone());
        self.closed = true;
        self.clear_all_deadlines(effects);

        let mut note = Map::with_capacity(2);
        note.insert("event", Value::from("transport-error"));
        note.insert("message", Value::from(clean_msg.as_str()));
        self.emit_note("transport", Value::Object(note), effects);

        self.cancel_questions(None, None, effects);
        let peer_effects = self.peer.stop_requests(&clean_msg);
        self.apply_peer_effects(peer_effects, effects);
        self.fail_open(AcpErrorWire::open_failed(clean_msg.clone()), effects);
        effects.push(AcpEffect::Fatal { message: clean_msg });
    }

    pub(crate) fn apply_peer_effects(
        &mut self,
        peer_effects: Vec<PeerEffect>,
        effects: &mut Vec<AcpEffect>,
    ) {
        // Set once a frame of this input failed to capture. TS acts on no part of such a
        // line (`jsonrpc.ts:285`, `:299`): it stops before the write or the dispatch.
        let mut capture_failed: Option<String> = None;
        for effect in peer_effects {
            if let Some(message) = capture_failed.clone() {
                // The call this line carried is already out of the peer, so nothing else
                // would settle it; it ends as the capture failure, as TS's `close` ends it.
                if let PeerEffect::Settle { id, .. } = effect {
                    self.settle_call(id, Err(message), effects);
                }
                continue;
            }
            match effect {
                PeerEffect::Frame { dir, value } => {
                    // The frame is captured first, so a capture that throws applies none of
                    // the step's effects and no reply it causes is captured before it.
                    let frame_dir = match dir {
                        Direction::Send => FrameDirection::Send,
                        Direction::Recv => FrameDirection::Recv,
                    };
                    match capture_frame(&value, &self.secrets) {
                        Ok(captured) => effects.push(AcpEffect::Frame {
                            dir: frame_dir,
                            channel: "stdio".to_owned(),
                            text: captured.json,
                        }),
                        Err(err) => {
                            let message = self.redact_message(&err.to_string());
                            self.fail_capture(&message, effects);
                            capture_failed = Some(message);
                            continue;
                        }
                    }
                    // Settlement happens here, in frame order, before any subsequent
                    // notification or reply in the same stdout chunk (`session.ts:201`–`:211`).
                    match dir {
                        Direction::Send => self.sending(&value),
                        Direction::Recv => {
                            if self.open_stalled {
                                self.arm_deadline("open", OPEN_STALL_MS, effects);
                            }
                            if value.as_object().is_some_and(|m| !m.contains_key("method")) {
                                self.replied(&value, effects);
                            }
                        }
                    }
                }
                PeerEffect::Write { wire, ticket } => {
                    self.active_write_ticket = Some(ticket);
                    effects.push(AcpEffect::Write { wire, ticket });
                }
                PeerEffect::Settle { id, result } => {
                    let mapped = result.map_err(|e| e.to_string());
                    self.settle_call(id, mapped, effects);
                }
                PeerEffect::ServerRequest { id, method, params } => {
                    self.handle_server_request(id, method, params, effects);
                }
                PeerEffect::Notification { method, params } => {
                    self.handle_notification(&method, params.as_ref(), effects);
                }
                PeerEffect::Malformed { line } => {
                    self.emit_text_frame(FrameDirection::Recv, "stdio-text", &line, effects);
                }
                PeerEffect::ArmTimer { key, ms } => {
                    effects.push(AcpEffect::ArmTimer { key, ms });
                }
                PeerEffect::CancelTimer { key } => {
                    effects.push(AcpEffect::CancelTimer { key });
                }
                PeerEffect::Failed { message } => {
                    self.fail(&message, effects);
                }
            }
        }
    }

    /// Settle one facade call, routing the open's internal ids first (`session.ts:290`).
    fn settle_call(
        &mut self,
        id: u64,
        mapped: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) {
        if self.on_open_rpc_settled(id, mapped.clone(), effects) {
            return;
        }
        if id & INTERNAL_CALL_BIT != 0 {
            // Internal open call whose open state already settled (e.g. stall timeout).
            return;
        }
        let settled = match mapped {
            Ok(val) => Ok(val.to_json()),
            Err(msg) => Err(AcpErrorWire::rpc_error(self.redact_message(&msg))),
        };
        effects.push(AcpEffect::Settle {
            id,
            result: settled,
        });
    }

    /// Track outbound `session/prompt` and `session/new|load|resume` (`session.ts:277`–`:289`).
    fn sending(&mut self, value: &Value) {
        let message = object(value);
        let method = string(message.get("method").unwrap_or(&Value::Null));
        if method == agent_methods::SESSION_PROMPT {
            self.prompt_frames = self.prompt_frames.saturating_add(1);
            self.prompt_id = value_rpc_id(message.get("id"));
            self.shells.prompt_started();
        }
        if matches!(
            method,
            agent_methods::SESSION_NEW
                | agent_methods::SESSION_LOAD
                | agent_methods::SESSION_RESUME
        ) {
            self.open_id = value_rpc_id(message.get("id"));
            self.loading = method == agent_methods::SESSION_LOAD;
        }
    }

    /// Settle inbound open or prompt replies in frame order (`session.ts:290`–`:312`).
    fn replied(&mut self, value: &Value, effects: &mut Vec<AcpEffect>) {
        let message = object(value);
        let Some(id) = value_rpc_id(message.get("id")) else {
            return;
        };
        if self.open_id.as_ref() == Some(&id) {
            self.open_id = None;
            self.loading = false;
            if !message.contains_key("error") {
                let result_id = object(message.get("result").unwrap_or(&Value::Null))
                    .get("sessionId")
                    .and_then(js_string)
                    .filter(|s| !s.is_empty())
                    .cloned();
                let resume_id = self
                    .resume
                    .as_ref()
                    .map(|r| JsString::from(r.native_session_id.as_str()))
                    .filter(|s| !s.is_empty());
                let resolved = result_id
                    .or(resume_id)
                    .unwrap_or_else(|| self.opening_session.clone());
                self.native_session_id = resolved.clone();
                self.routing.bind_root(resolved.clone());
                self.shells.set_root(resolved);
            }
            return;
        }
        if self.prompt_id.as_ref() != Some(&id) {
            return;
        }
        let Some((reason, _)) = prompt_end(value) else {
            return;
        };
        self.prompt_id = None;
        self.prompt_ended(&reason, effects);
    }

    /// Close prompt-scoped work immediately when the prompt reply frame arrives (`session.ts:314`–`:333`).
    fn prompt_ended(&mut self, reason: &str, effects: &mut Vec<AcpEffect>) {
        let root = self.native_session_id.clone();
        self.clear_deadline("root", effects);
        if reason == "cancelled" {
            self.cancel_questions(None, None, effects);
        } else {
            let mut owners = HashSet::with_capacity(1);
            owners.insert(root.clone());
            self.cancel_questions(Some(&owners), None, effects);
        }
        self.shells.prompt_ended(&root, reason);
        self.routing.prompt_ended();
        if reason != "cancelled" {
            return;
        }
        if self.routing.has_live_children() {
            self.arm_deadline("children", CANCELLATION_GRACE_MS as f64, effects);
        }
        if self.shells.blocked() {
            self.arm_deadline("shells", CANCELLATION_GRACE_MS as f64, effects);
        }
    }

    /// Handle incoming `session/update` notifications (`session.ts:217`–`:251`).
    fn handle_notification(
        &mut self,
        method: &JsString,
        params: Option<&Value>,
        effects: &mut Vec<AcpEffect>,
    ) {
        if method.as_str() != client_methods::SESSION_UPDATE {
            return;
        }
        let params_val = params.cloned().unwrap_or_else(|| Value::Object(Map::new()));
        let params_map = object(&params_val);
        let update_val = params_map.get("update").unwrap_or(&Value::Null);
        let update = object(update_val);
        let session_id = js_string(params_map.get("sessionId").unwrap_or(&Value::Null))
            .cloned()
            .unwrap_or_default();

        // Antigravity names a new session in its updates before answering session/new.
        if self.open_id.is_some()
            && self.opening_session.is_empty()
            && self.native_session_id.is_empty()
        {
            self.opening_session = session_id.clone();
        }

        let active_session = if !self.native_session_id.is_empty() {
            &self.native_session_id
        } else {
            &self.opening_session
        };
        let update_kind = string(update.get("sessionUpdate").unwrap_or(&Value::Null));
        if !session_id.is_empty()
            && session_id == *active_session
            && update_kind == "config_option_update"
            && let Some(options) = update.get("configOptions")
            && options.is_array()
        {
            let mut patch = Map::with_capacity(1);
            patch.insert("configOptions", options.clone());
            let cfg_effects = self.configuration.update(&Value::Object(patch));
            self.push_config_effects(cfg_effects, effects);
        } else if !self.native_session_id.is_empty()
            && session_id == self.native_session_id
            && update_kind == "current_mode_update"
            && let Some(mode_id) = update.get("currentModeId").and_then(Value::as_str)
        {
            let cfg_effects = self.configuration.mode_changed(mode_id);
            self.push_config_effects(cfg_effects, effects);
        }

        if self.loading {
            return;
        }
        self.routing.receive(&params_val);
        self.shells.receive(&params_val);
        if !self.routing.has_live_children() {
            self.clear_deadline("children", effects);
        }
        if !self.shells.blocked() {
            self.clear_deadline("shells", effects);
        }
        let finished_children: Vec<JsString> = self
            .cancelling_children
            .iter()
            .filter(|id| !self.routing.is_live(id))
            .cloned()
            .collect();
        for id in finished_children {
            self.cancelling_children.shift_remove(&id);
            self.clear_deadline(&format!("child:{id}"), effects);
        }
    }

    /// Handle incoming agent-to-client JSON-RPC requests (`session.ts:798`–`:819`).
    fn handle_server_request(
        &mut self,
        id: RpcId,
        method: JsString,
        params: Option<Value>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let params_val = params.unwrap_or_else(|| Value::Object(Map::new()));
        if matches!(
            method.as_str(),
            "cursor/task" | "cursor/update_todos" | "cursor/generate_image"
        ) {
            let reply = self.peer.answer(&id, &Value::Object(Map::new()));
            self.apply_peer_effects(reply, effects);
            return;
        }
        if interaction_request(method.as_str(), &params_val, self.quirks.translate_kind()).is_none()
        {
            let reply = self.peer.answer_not_found(&id);
            self.apply_peer_effects(reply, effects);
            return;
        }
        if self.closed {
            let reply = self.peer.answer(&id, &cancelled_outcome());
            self.apply_peer_effects(reply, effects);
            return;
        }
        let key = interaction_key(&to_translate_rpc_id(&id));
        if self.pending.contains_key(&key) {
            let reply =
                self.peer
                    .answer_error(&id, INTERNAL_ERROR, "Duplicate pending ACP request");
            self.apply_peer_effects(reply, effects);
            return;
        }
        if self.pending.len() >= MAX_PENDING_INTERACTIONS {
            self.fail("ACP incoming interaction capacity reached", effects);
            let reply =
                self.peer
                    .answer_error(&id, INTERNAL_ERROR, "ACP interaction capacity reached");
            self.apply_peer_effects(reply, effects);
            return;
        }
        let owner = self.routing.owner(&params_val, &self.native_session_id);
        if let Some(tool) = request_tool(method.as_str(), &params_val)
            && let Some(tool_id) = tool.get("toolCallId").and_then(js_string).cloned()
            && !self.shells.knows(&owner, &tool_id)
        {
            let mut synth = Map::with_capacity(2);
            synth.insert("sessionId", Value::String(owner.clone()));
            synth.insert("update", Value::Object(tool));
            self.shells.receive(&Value::Object(synth));
        }
        self.pending.insert(
            key,
            PendingInteraction {
                id,
                method,
                params: params_val,
                owner,
            },
        );
    }

    /// Cancel matching pending interaction requests (`session.ts:842`–`:849`).
    pub fn cancel_questions(
        &mut self,
        owners: Option<&HashSet<JsString>>,
        only: Option<&HashSet<JsString>>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let matching: Vec<JsString> = self
            .pending
            .iter()
            .filter(|(key, item)| {
                owners.is_none_or(|set| set.contains(&item.owner))
                    && only.is_none_or(|set| set.contains(*key))
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in matching {
            let Some(item) = self.pending.shift_remove(&key) else {
                continue;
            };
            self.answered(&item, true);
            let reply = self.peer.answer(&item.id, &cancelled_outcome());
            self.apply_peer_effects(reply, effects);
        }
    }

    /// Notify shell settlement how a tool's request was answered (`session.ts:851`–`:855`).
    pub(crate) fn answered(&mut self, pending: &PendingInteraction, refused: bool) {
        let params = object(&pending.params);
        let tool = params
            .get("toolCallId")
            .and_then(js_string)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                object(params.get("toolCall").unwrap_or(&Value::Null))
                    .get("toolCallId")
                    .and_then(js_string)
                    .filter(|s| !s.is_empty())
            })
            .cloned();
        if let Some(tool_id) = tool {
            self.shells.answered(&pending.owner, &tool_id, refused);
        }
    }

    fn handle_deadline(&mut self, logical: &str, effects: &mut Vec<AcpEffect>) {
        if logical == "open" {
            self.on_open_stalled(effects);
        } else if logical == "children" {
            if self.routing.has_live_children() {
                self.fail(
                    "ACP child cancellation completion is unconfirmed after grace",
                    effects,
                );
            }
        } else if logical == "shells" {
            if self.shells.blocked() {
                self.fail(
                    "ACP shell cancellation completion is unconfirmed after grace",
                    effects,
                );
            }
        } else if logical == "root" {
            if self.prompt_id.is_some() {
                self.fail(
                    "ACP prompt cancellation is unconfirmed after grace",
                    effects,
                );
            }
        } else if let Some(child_id) = logical.strip_prefix("child:") {
            let child_js = JsString::from(child_id);
            self.cancelling_children.shift_remove(&child_js);
            if self.routing.expire(&child_js) && !self.routing.has_live_children() {
                self.clear_deadline("children", effects);
            }
        }
    }

    pub(crate) fn arm_deadline(&mut self, name: &str, ms: f64, effects: &mut Vec<AcpEffect>) {
        push_deadline_effects(self.deadlines.arm(name, ms), effects);
    }

    pub(crate) fn clear_deadline(&mut self, name: &str, effects: &mut Vec<AcpEffect>) {
        push_deadline_effects(self.deadlines.clear(name), effects);
    }

    fn clear_all_deadlines(&mut self, effects: &mut Vec<AcpEffect>) {
        push_deadline_effects(self.deadlines.clear_all(), effects);
    }

    pub(crate) fn emit_note(&mut self, channel: &str, data: Value, effects: &mut Vec<AcpEffect>) {
        self.emit_value_frame(FrameDirection::Note, channel, &data, effects);
    }

    fn emit_value_frame(
        &mut self,
        dir: FrameDirection,
        channel: &str,
        data: &Value,
        effects: &mut Vec<AcpEffect>,
    ) {
        match capture_frame(data, &self.secrets) {
            Ok(captured) => effects.push(AcpEffect::Frame {
                dir,
                channel: channel.to_owned(),
                text: captured.json,
            }),
            Err(err) => {
                let message = err.to_string();
                self.fail_capture(&message, effects);
            }
        }
    }

    fn emit_text_frame(
        &mut self,
        dir: FrameDirection,
        channel: &str,
        line: &str,
        effects: &mut Vec<AcpEffect>,
    ) {
        match capture_text_frame(line, &self.secrets) {
            Ok(captured) => effects.push(AcpEffect::Frame {
                dir,
                channel: channel.to_owned(),
                text: captured.json,
            }),
            Err(err) => {
                let message = err.to_string();
                self.fail_capture(&message, effects);
            }
        }
    }

    /// A frame that cannot be captured ends the session (`session.ts:373`–`:381`):
    /// `fail` once, then only the failure is left to report.
    fn fail_capture(&mut self, message: &str, effects: &mut Vec<AcpEffect>) {
        if self.closed {
            effects.push(AcpEffect::Fatal {
                message: message.to_owned(),
            });
        } else {
            self.fail(message, effects);
        }
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

fn value_rpc_id(value: Option<&Value>) -> Option<RpcId> {
    match value {
        Some(Value::String(text)) => Some(RpcId::Text(text.clone())),
        Some(Value::Number(num)) => num.as_f64().map(RpcId::Number),
        _ => None,
    }
}

fn to_translate_rpc_id(id: &RpcId) -> crate::translate::data::RpcId {
    match id {
        RpcId::Text(text) => crate::translate::data::RpcId::Str(text.clone()),
        RpcId::Number(value) => crate::translate::data::RpcId::FloatBits(value.to_bits()),
    }
}

fn cancelled_outcome() -> Value {
    let mut inner = Map::with_capacity(1);
    inner.insert("outcome", Value::from("cancelled"));
    let mut outer = Map::with_capacity(1);
    outer.insert("outcome", Value::Object(inner));
    Value::Object(outer)
}
