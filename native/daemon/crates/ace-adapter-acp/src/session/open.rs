// SPDX-License-Identifier: Apache-2.0
//! ACP session open handshake state machine (`packages/adapter-acp/src/session.ts:383`–`:495`
//! and `packages/provider-kit/src/acp-sign-in.ts`).

use ace_json::{JsString, Map, Value};
use ace_supervisor::jsonrpc::error_code;
use ace_supervisor::peer::Timeout;
use serde::{Deserialize, Serialize};

use super::mcp::{McpTransport, prepare_acp_mcp};
use super::negotiation::{ProfileFit, ResumeMethod};
use super::protocol::{AUTH_REQUIRED_CODE, PROTOCOL_VERSION, agent_methods};
use super::resume_error::{ResumeFailure, resume_load_failure};
use crate::session::core::{AcpCore, AcpEffect, AcpErrorWire};
use crate::translate::data::object;

/// Stall timeout for `session/new`, `session/load`, or `session/resume` (`session.ts:65`).
pub const OPEN_STALL_MS: f64 = 30_000.0;
/// Timeout for `authenticate` during sign-in retry (`acp-sign-in.ts:6`).
pub const AUTHENTICATE_TIMEOUT_MS: f64 = 30_000.0;

/// Resume target passed when reopening an existing native ACP session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeTarget {
    pub native_session_id: String,
}

/// Result returned when the ACP open handshake completes (`initialize` + `session/new|load|resume`).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenResult {
    pub native_session_id: JsString,
    pub steer_via_cancel: bool,
    pub mcp_transport: McpTransport,
    pub capabilities: Map,
    pub support: Map,
    pub raw_selectors: Value,
}

impl OpenResult {
    pub fn to_json(&self) -> String {
        let mut map = Map::with_capacity(6);
        map.insert(
            "nativeSessionId",
            Value::String(self.native_session_id.clone()),
        );
        map.insert("steerViaCancel", Value::Bool(self.steer_via_cancel));
        map.insert("mcpTransport", Value::from(self.mcp_transport.as_str()));
        map.insert("capabilities", Value::Object(self.capabilities.clone()));
        map.insert("support", Value::Object(self.support.clone()));
        map.insert("rawSelectors", self.raw_selectors.clone());
        Value::Object(map).to_json()
    }
}

#[derive(Debug)]
pub(crate) struct OpenRequestSpec {
    pub method: &'static str,
    pub params: Value,
    pub mcp_transport: McpTransport,
    pub has_system_prompt: bool,
    pub retried_sign_in: bool,
}

#[derive(Debug)]
pub(crate) enum OpenPhase {
    Initializing { rpc_id: u64 },
    Opening { rpc_id: u64, spec: OpenRequestSpec },
    Authenticating { rpc_id: u64, spec: OpenRequestSpec },
}

#[derive(Debug)]
pub(crate) struct OpenState {
    pub facade_id: u64,
    pub phase: OpenPhase,
}

impl OpenState {
    pub fn active_rpc_id(&self) -> u64 {
        match &self.phase {
            OpenPhase::Initializing { rpc_id }
            | OpenPhase::Opening { rpc_id, .. }
            | OpenPhase::Authenticating { rpc_id, .. } => *rpc_id,
        }
    }
}

impl AcpCore {
    /// Start the ACP open handshake (`initialize`, MCP capability filtering,
    /// `session/new | session/load | session/resume`, optional `authenticate` retry).
    ///
    /// Guarantees `AcpEffect::Settle { id: facade_id, .. }` fires **exactly once**.
    pub fn start_open(&mut self, facade_id: u64) -> Vec<AcpEffect> {
        let mut effects = Vec::new();
        if self.closed {
            effects.push(AcpEffect::Settle {
                id: facade_id,
                result: Err(AcpErrorWire::open_failed("ACP session closed")),
            });
            return effects;
        }
        if self.open.is_some() {
            effects.push(AcpEffect::Settle {
                id: facade_id,
                result: Err(AcpErrorWire::open_failed(
                    "ACP session open already in progress",
                )),
            });
            return effects;
        }

        let rpc_id = self.alloc_internal_id();
        self.open = Some(OpenState {
            facade_id,
            phase: OpenPhase::Initializing { rpc_id },
        });

        let init_params = self.build_initialize_params();
        match self.peer.request(
            agent_methods::INITIALIZE,
            Some(&init_params),
            rpc_id,
            Timeout::Default,
        ) {
            Ok(peer_effects) => self.apply_peer_effects(peer_effects, &mut effects),
            Err(err) => self.fail_open(AcpErrorWire::open_failed(err.message()), &mut effects),
        }
        effects
    }

    fn build_initialize_params(&self) -> Value {
        let mut fs = Map::with_capacity(2);
        fs.insert("readTextFile", Value::Bool(false));
        fs.insert("writeTextFile", Value::Bool(false));

        let mut client_caps = Map::with_capacity(4);
        client_caps.insert("fs", Value::Object(fs));
        client_caps.insert("terminal", Value::Bool(false));
        let meta =
            super::negotiation::client_meta(&self.quirks.client_meta, self.launch_profile.as_ref());
        client_caps.insert("_meta", Value::Object(meta));
        if self
            .launch_profile
            .as_ref()
            .is_some_and(|p| p.subagent_sessions)
        {
            client_caps.insert("subagents", Value::Object(Map::new()));
        }

        let mut client_info = Map::with_capacity(2);
        client_info.insert("name", Value::from("ace"));
        client_info.insert("version", Value::from("0.0.0"));

        let mut params = Map::with_capacity(3);
        params.insert("protocolVersion", Value::from(PROTOCOL_VERSION));
        params.insert("clientInfo", Value::Object(client_info));
        params.insert("clientCapabilities", Value::Object(client_caps));
        Value::Object(params)
    }

    pub(crate) fn on_open_rpc_settled(
        &mut self,
        rpc_id: u64,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) -> bool {
        let Some(state) = self.open.as_ref() else {
            return false;
        };
        if state.active_rpc_id() != rpc_id {
            return false;
        }
        let Some(state) = self.open.take() else {
            return false;
        };
        match state.phase {
            OpenPhase::Initializing { .. } => {
                self.finish_initialize(state.facade_id, result, effects);
            }
            OpenPhase::Opening { spec, .. } => {
                self.finish_session_open(state.facade_id, spec, result, effects);
            }
            OpenPhase::Authenticating { spec, .. } => {
                self.finish_authenticate(state.facade_id, spec, result, effects);
            }
        }
        true
    }

    fn finish_initialize(
        &mut self,
        facade_id: u64,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) {
        let raw = match result {
            Ok(val) => val,
            Err(message) => {
                self.settle_open_error(facade_id, AcpErrorWire::open_failed(message), effects);
                return;
            }
        };

        let negotiated = match self.configuration.initialize(&raw) {
            Ok(neg) => neg.clone(),
            Err(err) => {
                self.settle_open_error(
                    facade_id,
                    AcpErrorWire::open_failed(err.to_string()),
                    effects,
                );
                return;
            }
        };

        let steering_native = negotiated
            .capabilities
            .get("steeringMode")
            .and_then(Value::as_str)
            == Some("native");
        self.steer_via_cancel = !steering_native;

        if let Some(changed) = &negotiated.version_changed {
            let mut note = Map::with_capacity(4);
            note.insert("event", Value::from("acp-version-changed"));
            note.insert("approved", Value::from(changed.approved.as_str()));
            note.insert("reported", Value::from(changed.reported.as_str()));
            note.insert(
                "runsAs",
                Value::from(match changed.runs_as {
                    super::negotiation::RunsAs::Profile => "profile",
                    super::negotiation::RunsAs::Generic => "generic",
                }),
            );
            self.emit_note("diagnostic", Value::Object(note), effects);
        }

        if let Some(profile) = &negotiated.profile
            && negotiated.profile_fit == Some(ProfileFit::Compatible)
        {
            let reported = negotiated
                .version_changed
                .as_ref()
                .map(|c| c.reported.as_str())
                .or(self.launch_version.as_deref());
            let mut note = Map::with_capacity(4);
            note.insert("event", Value::from("acp-version-unverified"));
            note.insert("profile", Value::from(profile.id.as_str()));
            note.insert("verified", Value::from(profile.version.as_str()));
            if let Some(ver) = reported {
                note.insert("version", Value::from(ver));
            }
            self.emit_note("diagnostic", Value::Object(note), effects);
        }

        let prepared =
            match prepare_acp_mcp(self.mcp.as_ref(), negotiated.http_mcp, negotiated.sse_mcp) {
                Ok(p) => p,
                Err(message) => {
                    self.settle_open_error(facade_id, AcpErrorWire::open_failed(message), effects);
                    return;
                }
            };
        for skipped in &prepared.skipped {
            let mut note = Map::with_capacity(3);
            note.insert("event", Value::from("mcp-server-skipped"));
            note.insert("name", Value::from(skipped.name.as_str()));
            note.insert("transport", Value::from(skipped.transport.as_str()));
            self.emit_note("recorder", Value::Object(note), effects);
        }

        let can_resume = negotiated
            .capabilities
            .get("resume")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if self.resume.is_some() && !can_resume {
            self.settle_open_error(
                facade_id,
                AcpErrorWire::resume_failure(ResumeFailure {
                    code: super::resume_error::ResumeFailureCode::ResumeUnsupported,
                    detail: "ACP agent does not advertise safe session loading".to_owned(),
                }),
                effects,
            );
            return;
        }

        let system_prompt = if negotiated.system_prompt_append {
            self.mcp
                .as_ref()
                .and_then(|mcp| mcp.guidance())
                .map(str::to_owned)
        } else {
            None
        };

        let method = if self.resume.is_some() {
            match negotiated.resume_method {
                Some(ResumeMethod::SessionResume) => agent_methods::SESSION_RESUME,
                _ => agent_methods::SESSION_LOAD,
            }
        } else {
            agent_methods::SESSION_NEW
        };

        let mut open_params = Map::with_capacity(4);
        open_params.insert("cwd", Value::from(self.cwd.as_str()));
        open_params.insert("mcpServers", Value::Array(prepared.servers.into()));
        if let Some(resume) = &self.resume {
            self.opening_session = JsString::from(resume.native_session_id.as_str());
            open_params.insert("sessionId", Value::from(resume.native_session_id.as_str()));
        }
        let has_system_prompt = system_prompt.is_some();
        if let Some(prompt) = system_prompt {
            let mut sp = Map::with_capacity(1);
            sp.insert("append", Value::from(prompt));
            let mut agy = Map::with_capacity(1);
            agy.insert("systemPrompt", Value::Object(sp));
            let mut meta = Map::with_capacity(1);
            meta.insert("antigravity", Value::Object(agy));
            open_params.insert("_meta", Value::Object(meta));
        }

        let spec = OpenRequestSpec {
            method,
            params: Value::Object(open_params),
            mcp_transport: prepared.transport,
            has_system_prompt,
            retried_sign_in: false,
        };
        self.open_stalled = true;
        self.arm_deadline("open", OPEN_STALL_MS, effects);
        self.send_session_open(facade_id, spec, effects);
    }

    fn send_session_open(
        &mut self,
        facade_id: u64,
        spec: OpenRequestSpec,
        effects: &mut Vec<AcpEffect>,
    ) {
        let rpc_id = self.alloc_internal_id();
        let method = spec.method;
        let params = spec.params.clone();
        self.open = Some(OpenState {
            facade_id,
            phase: OpenPhase::Opening { rpc_id, spec },
        });
        match self
            .peer
            .request(method, Some(&params), rpc_id, Timeout::Disabled)
        {
            Ok(peer_effects) => self.apply_peer_effects(peer_effects, effects),
            Err(err) => {
                self.clear_open_guards(effects);
                self.fail_open(AcpErrorWire::open_failed(err.message()), effects);
            }
        }
    }

    fn finish_session_open(
        &mut self,
        facade_id: u64,
        mut spec: OpenRequestSpec,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) {
        match result {
            Ok(opened) => {
                self.clear_open_guards(effects);
                if spec.has_system_prompt {
                    self.guided = true;
                }
                if self.native_session_id.is_empty() {
                    self.settle_open_error(
                        facade_id,
                        AcpErrorWire::open_failed("ACP server did not return a session id"),
                        effects,
                    );
                    return;
                }
                let session_val = Value::Object(object(&opened).clone());
                let cfg_effects = self.configuration.setup(&session_val, spec.mcp_transport);
                self.push_config_effects(cfg_effects, effects);

                let open_result = OpenResult {
                    native_session_id: self.native_session_id.clone(),
                    steer_via_cancel: self.steer_via_cancel,
                    mcp_transport: spec.mcp_transport,
                    capabilities: self.configuration.capabilities.clone().unwrap_or_default(),
                    support: self.configuration.support.clone().unwrap_or_default(),
                    raw_selectors: self.configuration.selectors.raw.clone(),
                };
                effects.push(AcpEffect::Settle {
                    id: facade_id,
                    result: Ok(open_result.to_json()),
                });
            }
            Err(message) => {
                if !spec.retried_sign_in
                    && error_code(&message) == Some(AUTH_REQUIRED_CODE as f64)
                    && let Some(sign_in) = self.sign_in_method.clone()
                {
                    spec.retried_sign_in = true;
                    let rpc_id = self.alloc_internal_id();
                    let mut auth_params = Map::with_capacity(1);
                    auth_params.insert("methodId", Value::from(sign_in));
                    let auth_val = Value::Object(auth_params);
                    self.open = Some(OpenState {
                        facade_id,
                        phase: OpenPhase::Authenticating { rpc_id, spec },
                    });
                    match self.peer.request(
                        agent_methods::AUTHENTICATE,
                        Some(&auth_val),
                        rpc_id,
                        Timeout::After(AUTHENTICATE_TIMEOUT_MS),
                    ) {
                        Ok(peer_effects) => self.apply_peer_effects(peer_effects, effects),
                        Err(err) => {
                            self.clear_open_guards(effects);
                            self.fail_open(AcpErrorWire::open_failed(err.message()), effects);
                        }
                    }
                    return;
                }

                self.clear_open_guards(effects);
                let error_wire = if self.resume.is_some()
                    && let Some(failure) = resume_load_failure(&message)
                {
                    AcpErrorWire::resume_failure(failure)
                } else {
                    AcpErrorWire::open_failed(message)
                };
                self.settle_open_error(facade_id, error_wire, effects);
            }
        }
    }

    fn finish_authenticate(
        &mut self,
        facade_id: u64,
        spec: OpenRequestSpec,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) {
        match result {
            Ok(_) => self.send_session_open(facade_id, spec, effects),
            Err(message) => {
                self.clear_open_guards(effects);
                let error_wire = if self.resume.is_some()
                    && let Some(failure) = resume_load_failure(&message)
                {
                    AcpErrorWire::resume_failure(failure)
                } else {
                    AcpErrorWire::open_failed(message)
                };
                self.settle_open_error(facade_id, error_wire, effects);
            }
        }
    }

    pub(crate) fn on_open_stalled(&mut self, effects: &mut Vec<AcpEffect>) {
        if !self.open_stalled {
            return;
        }
        let open_wire_id = self.open_id.clone();
        let auth_wire_id = self.auth_id.clone();
        self.clear_open_guards(effects);
        let message = "ACP session opening made no progress within 30 seconds";
        let Some(state) = self.open.take() else {
            return;
        };
        let cancel_wire_id = match &state.phase {
            OpenPhase::Opening { .. } => open_wire_id,
            OpenPhase::Authenticating { .. } => auth_wire_id,
            OpenPhase::Initializing { .. } => None,
        };
        if let Some(wire_id) = cancel_wire_id {
            let peer_effects = self
                .peer
                .reject_request(&wire_id, ace_supervisor::peer::PeerError::new(message));
            // `self.open` is already taken, so the internal Settle from `reject_request`
            // is swallowed; `state.facade_id` settles exactly once below.
            self.apply_peer_effects(peer_effects, effects);
        }
        self.settle_open_error(state.facade_id, AcpErrorWire::open_failed(message), effects);
    }

    pub(crate) fn clear_open_guards(&mut self, effects: &mut Vec<AcpEffect>) {
        self.loading = false;
        self.open_id = None;
        self.auth_id = None;
        self.open_stalled = false;
        self.clear_deadline("open", effects);
    }

    pub(crate) fn fail_open(&mut self, error: AcpErrorWire, effects: &mut Vec<AcpEffect>) {
        if let Some(state) = self.open.take() {
            self.clear_open_guards(effects);
            self.settle_open_error(state.facade_id, error, effects);
        }
    }

    fn settle_open_error(&self, facade_id: u64, error: AcpErrorWire, effects: &mut Vec<AcpEffect>) {
        let redacted_msg = self.redact_message(&error.message);
        effects.push(AcpEffect::Settle {
            id: facade_id,
            result: Err(AcpErrorWire {
                code: error.code,
                message: redacted_msg,
            }),
        });
    }
}
