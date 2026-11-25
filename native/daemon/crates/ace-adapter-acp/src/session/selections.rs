// SPDX-License-Identifier: Apache-2.0
//! The saved mode, model and effort a launch applies before its open settles
//! (`packages/adapter-acp/src/session.ts:495`–`:533`, `:572`–`:590`).
//!
//! Sans-IO: every selection is one `session/set_mode`, `session/set_config_option` or
//! `session/set_model` request whose reply arrives in frame order. A value the agent
//! no longer lists, or refuses, is reported as refused instead of failing the start;
//! a closed session still fails it (`session.ts:511`–`:520`).

use ace_json::{Map, Value};
use ace_supervisor::peer::Timeout;

use super::configuration::{PendingSelection, SelectError};
use super::core::{AcpCore, AcpEffect, AcpErrorWire};
use super::mcp::McpTransport;
use super::open::{OpenPhase, OpenResult, OpenState};
use super::selectors::SelectorKind;

/// One saved option, in the order `session.ts:499`–`:509` applies them.
#[derive(Debug, Clone, PartialEq)]
pub enum SavedSelection {
    PermissionMode(String),
    Model(String),
    Effort(String),
}

impl SavedSelection {
    pub fn kind(&self) -> SelectorKind {
        match self {
            SavedSelection::PermissionMode(_) => SelectorKind::Mode,
            SavedSelection::Model(_) => SelectorKind::Model,
            SavedSelection::Effort(_) => SelectorKind::Effort,
        }
    }

    pub fn value(&self) -> &str {
        match self {
            SavedSelection::PermissionMode(value)
            | SavedSelection::Model(value)
            | SavedSelection::Effort(value) => value,
        }
    }

    /// The name the open reports in `refusedOptions` when it did not apply.
    pub fn refused_name(&self) -> &'static str {
        match self {
            SavedSelection::PermissionMode(_) => "permissionMode",
            SavedSelection::Model(_) => "model",
            SavedSelection::Effort(_) => "effort",
        }
    }
}

/// The launch's saved options, in the order they apply (`session.ts:499`–`:509`).
pub fn saved_selections(
    mode: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
) -> Vec<SavedStep> {
    let mut steps = Vec::with_capacity(3);
    if let Some(mode) = mode.filter(|value| !value.is_empty()) {
        steps.push(SavedStep::wanted(SavedSelection::PermissionMode(
            mode.to_owned(),
        )));
    }
    if let Some(model) = model.filter(|value| !value.is_empty()) {
        steps.push(SavedStep::wanted(SavedSelection::Model(model.to_owned())));
    }
    if let Some(effort) = effort.filter(|value| !value.is_empty()) {
        steps.push(SavedStep::wanted(SavedSelection::Effort(effort.to_owned())));
    }
    steps
}

/// One saved option still to apply.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedStep {
    pub selection: SavedSelection,
    /// A mode restored after a model's reply: its failure never counts as a refusal
    /// (`session.ts:577`–`:584`).
    pub swallow: bool,
}

impl SavedStep {
    fn wanted(selection: SavedSelection) -> Self {
        Self {
            selection,
            swallow: false,
        }
    }

    fn restored(selection: SavedSelection) -> Self {
        Self {
            selection,
            swallow: true,
        }
    }
}

/// A selection request awaiting its reply.
#[derive(Debug)]
pub(crate) struct ActiveSelection {
    pub rpc_id: u64,
    pub pending: PendingSelection,
    /// This step's failure is swallowed: a mode restored after a model's reply.
    pub swallow: bool,
    /// The mode running before this selection: a model's reply may reset it.
    pub before_mode: Option<String>,
}

/// The open of a session that answered `session/new` and still applies its saved options.
#[derive(Debug)]
pub(crate) struct PostOpen {
    pub facade_id: u64,
    pub mcp_transport: McpTransport,
    pub remaining: Vec<SavedStep>,
    pub refused: Vec<&'static str>,
    pub active: Option<ActiveSelection>,
}

impl AcpCore {
    /// Continue the open past `session/new` with the launch's saved options
    /// (`session.ts:495`–`:509`): the open settles only once each has applied or
    /// been refused, so the daemon hears what runs.
    pub(crate) fn start_saved_selections(
        &mut self,
        facade_id: u64,
        mcp_transport: McpTransport,
        effects: &mut Vec<AcpEffect>,
    ) {
        let post = PostOpen {
            facade_id,
            mcp_transport,
            remaining: saved_selections(
                self.permission_mode.as_deref(),
                self.model.as_deref(),
                self.effort.as_deref(),
            ),
            refused: Vec::new(),
            active: None,
        };
        self.open = Some(OpenState {
            facade_id,
            phase: OpenPhase::Selecting(Box::new(post)),
        });
        self.advance_saved_selections(effects);
    }

    /// Send the next saved option's request, or settle the open when none is left.
    fn advance_saved_selections(&mut self, effects: &mut Vec<AcpEffect>) {
        loop {
            if self.closed {
                let Some(state) = self.open.take() else {
                    return;
                };
                self.clear_open_guards(effects);
                self.settle_open_error(
                    state.facade_id,
                    AcpErrorWire::open_failed("ACP session closed"),
                    effects,
                );
                return;
            }
            if saved_post(&self.open).is_none_or(|post| post.active.is_some()) {
                return;
            }
            let Some(step) =
                saved_post(&self.open).and_then(|post| post.remaining.first().cloned())
            else {
                self.settle_saved_open(effects);
                return;
            };
            let prepared = self.configuration.prepare_select(
                step.selection.kind(),
                step.selection.value(),
                self.native_session_id.as_str(),
            );
            let Ok(pending) = prepared else {
                // Not listed now: renamed, dropped, or a loaded session reporting none.
                self.refuse_step(&step);
                continue;
            };
            let method = pending.request.method.clone();
            let params = Value::Object(pending.request.params.clone());
            let rpc_id = self.alloc_internal_id();
            if let Some(post) = saved_post_mut(&mut self.open) {
                post.remaining.remove(0);
                post.active = Some(ActiveSelection {
                    rpc_id,
                    pending,
                    swallow: step.swallow,
                    before_mode: self.configuration.current(SelectorKind::Mode),
                });
            }
            match self
                .peer
                .request(&method, Some(&params), rpc_id, Timeout::Default)
            {
                Ok(peer_effects) => self.apply_peer_effects(peer_effects, effects),
                Err(err) => self.fail_open(AcpErrorWire::open_failed(err.message()), effects),
            }
            return;
        }
    }

    /// One saved selection's reply, then the next one (`session.ts:552`–`:568`).
    /// Returns false when `rpc_id` is not the saved selection in flight.
    pub(crate) fn finish_saved_selection(
        &mut self,
        rpc_id: u64,
        result: Result<Value, String>,
        effects: &mut Vec<AcpEffect>,
    ) -> bool {
        let Some(state) = self.open.take() else {
            return false;
        };
        let mut post = match state.phase {
            OpenPhase::Selecting(post) => *post,
            other => {
                self.open = Some(OpenState {
                    facade_id: state.facade_id,
                    phase: other,
                });
                return false;
            }
        };
        let Some(active) = post.active.take().filter(|a| a.rpc_id == rpc_id) else {
            self.open = Some(OpenState {
                facade_id: post.facade_id,
                phase: OpenPhase::Selecting(Box::new(post)),
            });
            return false;
        };
        let mut failure = None;
        match result {
            Ok(reply) => {
                let (cfg, outcome) = self
                    .configuration
                    .apply_select_reply(&active.pending, &reply);
                self.push_config_effects(cfg, effects);
                match outcome {
                    Ok(()) => {
                        if active.pending.kind == SelectorKind::Mode {
                            self.wanted_mode = Some(active.pending.value.clone());
                        }
                    }
                    Err(err) => {
                        self.report_selection_error(&err, &active, effects);
                        if !active.swallow {
                            post.refused.push(active.pending.kind_refused());
                        }
                    }
                }
            }
            Err(message) => {
                let (cfg, err) = self
                    .configuration
                    .apply_select_error(&active.pending, &message);
                self.push_config_effects(cfg, effects);
                self.report_selection_error(&err, &active, effects);
                if !active.swallow {
                    post.refused.push(active.pending.kind_refused());
                }
                if message.contains("request timed out") {
                    // A selection that never answered ends the session (`session.ts:555`).
                    failure = Some(self.redact_message(&message));
                }
            }
        }
        self.restore_mode_after_model(&active, &mut post, effects);
        if let Some(message) = failure {
            self.open = Some(OpenState {
                facade_id: post.facade_id,
                phase: OpenPhase::Selecting(Box::new(post)),
            });
            self.fail(&message, effects);
            return true;
        }
        self.open = Some(OpenState {
            facade_id: post.facade_id,
            phase: OpenPhase::Selecting(Box::new(post)),
        });
        self.advance_saved_selections(effects);
        true
    }

    fn refuse_step(&mut self, step: &SavedStep) {
        let Some(post) = saved_post_mut(&mut self.open) else {
            return;
        };
        post.remaining.remove(0);
        if !step.swallow {
            post.refused.push(step.selection.refused_name());
        }
    }

    /// A model's reply can carry fresh options with the mode back at its default
    /// (`session.ts:572`–`:586`): ask for the mode ace wanted, or hear what runs.
    fn restore_mode_after_model(
        &mut self,
        active: &ActiveSelection,
        post: &mut PostOpen,
        effects: &mut Vec<AcpEffect>,
    ) {
        if active.pending.kind != SelectorKind::Model {
            return;
        }
        let now = self.configuration.current(SelectorKind::Mode);
        if now == active.before_mode {
            return;
        }
        match (&self.wanted_mode, &now) {
            (Some(wanted), Some(running)) if wanted != running => {
                post.remaining.insert(
                    0,
                    SavedStep::restored(SavedSelection::PermissionMode(wanted.clone())),
                );
            }
            _ => {
                if let Some(effect) = self.configuration.announce_mode() {
                    self.push_config_effects(vec![effect], effects);
                }
            }
        }
    }

    fn report_selection_error(
        &mut self,
        error: &SelectError,
        active: &ActiveSelection,
        effects: &mut Vec<AcpEffect>,
    ) {
        if let SelectError::LegacyModelRejected { unsupported, .. } = error {
            let mut note = Map::with_capacity(3);
            note.insert("event", Value::from("acp-legacy-model-rejected"));
            note.insert("requested", Value::from(active.pending.value.as_str()));
            note.insert("unsupported", Value::Bool(*unsupported));
            self.emit_note("diagnostic", Value::Object(note), effects);
        }
    }

    /// Settle the open once every saved option has applied or been refused
    /// (`session.ts:491`–`:509`).
    fn settle_saved_open(&mut self, effects: &mut Vec<AcpEffect>) {
        let Some(state) = self.open.take() else {
            return;
        };
        let OpenPhase::Selecting(post) = state.phase else {
            self.open = Some(state);
            return;
        };
        self.clear_open_guards(effects);
        let open_result = OpenResult {
            native_session_id: self.native_session_id.clone(),
            steer_via_cancel: self.steer_via_cancel,
            mcp_transport: post.mcp_transport,
            capabilities: self.configuration.capabilities.clone().unwrap_or_default(),
            support: self.configuration.support.clone().unwrap_or_default(),
            raw_selectors: self.configuration.selectors.raw.clone(),
            refused_options: post.refused.into_iter().map(str::to_owned).collect(),
        };
        effects.push(AcpEffect::Settle {
            id: post.facade_id,
            result: Ok(open_result.to_json()),
        });
    }
}

fn saved_post(open: &Option<OpenState>) -> Option<&PostOpen> {
    match open.as_ref().map(|state| &state.phase) {
        Some(OpenPhase::Selecting(post)) => Some(post),
        _ => None,
    }
}

fn saved_post_mut(open: &mut Option<OpenState>) -> Option<&mut PostOpen> {
    match open.as_mut().map(|state| &mut state.phase) {
        Some(OpenPhase::Selecting(post)) => Some(post),
        _ => None,
    }
}

impl PendingSelection {
    /// The name the open reports in `refusedOptions` for this selection.
    fn kind_refused(&self) -> &'static str {
        match self.kind {
            SelectorKind::Mode => "permissionMode",
            SelectorKind::Model => "model",
            SelectorKind::Effort => "effort",
        }
    }
}
