// SPDX-License-Identifier: Apache-2.0
//! The claude translator (the port of `translator.ts`).
//! Pure and synchronous; it never throws on provider data. Unknown frames
//! become raw diagnostics plus a signal fact, as the TypeScript does.

pub mod blocks;
pub mod compaction;
pub mod consumed_inputs;
pub mod content;
pub mod drafts;
pub mod frame;
pub mod goal;
pub mod injected_inputs;
pub mod interactions;
pub mod json;
pub mod missing_edges;
pub mod model_usage;
pub mod native_queue;
pub mod pending_tasks;
pub mod pending_transcripts;
pub mod provider_error;
pub mod rate_limits;
pub mod raw_facts;
pub mod resolution;
pub mod result_usage;
pub mod sdk;
pub mod sdk_facts;
pub mod state;
pub mod state_emit;
pub mod state_turn;
pub mod steer_continuation;
pub mod stream;
pub mod system_notices;
pub mod task_frames;
pub mod tasks;
pub mod token_counts;
pub mod tools;
pub mod translate_interactions;
pub mod usage;

use ace_json::Value;
use std::collections::HashMap;

use blocks::{MessageIndex, StreamState};
use consumed_inputs::ConsumedInputs;
use frame::FrameView;
use json::{object, raw, str_of};
use native_queue::NativeQueue;
use pending_transcripts::PendingTranscripts;
use raw_facts::{canonical_only, fact_raw};
use result_usage::ResultUsage;
use sdk::sdk_translator;
use sdk_facts::{process_exited, signal, tick_fact};
use state::ClaudeState;
use steer_continuation::SteerContinuation;
use stream::finish_stream;
use task_frames::task_tick;
use translate_interactions::interaction_frame;

pub struct ClaudeTranslator {
    pub(crate) root_key: String,
    pub(crate) state: ClaudeState,
    pub(crate) accounting: ResultUsage,
    pub(crate) queue: NativeQueue,
    pub(crate) consumed: ConsumedInputs,
    pub(crate) steers: SteerContinuation,
    pub(crate) streams: HashMap<String, StreamState>,
    pub(crate) messages: MessageIndex,
    pub(crate) pending: PendingTranscripts,
    pub(crate) diagnostics: Vec<Value>,
}

impl ClaudeTranslator {
    pub fn new(root_key: &str) -> Self {
        ClaudeTranslator {
            root_key: root_key.to_owned(),
            state: ClaudeState::new(root_key),
            accounting: ResultUsage::new(),
            queue: NativeQueue::new(),
            consumed: ConsumedInputs::new(),
            steers: SteerContinuation::new(),
            streams: HashMap::new(),
            messages: MessageIndex::new(root_key),
            pending: PendingTranscripts::new(),
            diagnostics: Vec::new(),
        }
    }

    pub fn take_diagnostics(&mut self) -> Vec<Value> {
        let mut out = std::mem::take(&mut self.diagnostics);
        out.extend(std::mem::take(&mut self.state.diagnostics));
        out
    }

    pub fn next_deadline(&self) -> Option<i64> {
        let mut best: Option<i64> = self.state.missing.next_deadline();
        for at in [self.state.wake_until, self.pending.next_deadline()]
            .into_iter()
            .flatten()
        {
            best = Some(best.map(|b| b.min(at)).unwrap_or(at));
        }
        best
    }

    pub fn translate(&mut self, frame: &FrameView<'_>, now: i64) -> Vec<Value> {
        self.diagnostics.clear();
        self.state.facts.clear();
        self.state.diagnostics.clear();
        let data = object(frame.data).clone();
        let data_value = Value::Object(data.clone());
        if frame.channel == "lifecycle"
            && str_of(data.get("type").unwrap_or(&Value::Null)) == "process.started"
        {
            self.pending.close(&mut self.state);
            let ended = std::mem::take(&mut self.state.facts);
            let root_key = self.root_key.clone();
            self.state = ClaudeState::new(&root_key);
            self.state.facts = ended;
            self.accounting = ResultUsage::new();
            self.queue = NativeQueue::new();
            self.consumed = ConsumedInputs::new();
            self.steers = SteerContinuation::new();
            self.streams.clear();
            self.messages.clear();
        }
        // taskTick returns the state's facts after pushing expirations.
        let _ = task_tick(&mut self.state, now);
        self.pending.expire(&mut self.state, now);
        self.state.ensure_root(&data_value);
        let agent = self.state.agent_for(&data_value);
        self.state.emit(signal(&agent));
        if frame.channel == "sdk"
            && frame.dir == "recv"
            && str_of(data.get("type").unwrap_or(&Value::Null)) == "result"
            && !self.accounting.accept(&data_value)
        {
            self.diagnostics.push(raw(frame.data));
            return self.state.facts.clone();
        }
        self.queue.observe(&mut self.state, frame);
        let active_root = self.state.active.contains(&self.state.root.clone());
        self.steers
            .observe(frame.dir, frame.channel, active_root, &data_value);
        if self.pending.defer(&mut self.state, frame, now) {
            return self.state.facts.clone();
        }
        if frame.channel == "sdk" {
            let observed = data_value.clone();
            self.pending.observe(&mut self.state, &observed);
        }
        if interaction_frame(&mut self.state, frame) {
            // Interaction owner reports only lifecycle facts.
        } else if frame.channel == "lifecycle"
            && str_of(data.get("type").unwrap_or(&Value::Null)) == "process.exited"
        {
            let deliberate = data.get("deliberate") == Some(&Value::Bool(true));
            let msg = str_of(data.get("message").unwrap_or(&Value::Null));
            self.state.emit(process_exited(deliberate, &msg));
            self.pending.close(&mut self.state);
            self.state.level.clear();
            self.state.missing.clear();
        } else if frame.channel == "lifecycle"
            && str_of(data.get("type").unwrap_or(&Value::Null)) == "process.started"
        {
            // ensureRoot already emitted the startup fact.
        } else if frame.channel != "sdk" || !sdk_translator(self, &data_value, frame, now) {
            let level = if frame.dir == "stderr" {
                "warning"
            } else {
                "info"
            };
            let root = self.state.root.clone();
            let seq = frame.seq.to_string();
            self.state.notice(frame.data, &seq, &root, level, None);
        }
        self.consumed.observe(&mut self.state, frame);
        self.pending.bind_registered(&mut self.state);
        let bindings = std::mem::take(&mut self.state.bindings);
        for spawn in bindings {
            let deferred = self.pending.take(&mut self.state, &spawn);
            for frame_owned in deferred {
                let start = self.state.facts.len();
                let diag_start = self.state.diagnostics.len();
                let view = frame_owned.view();
                if !self.pending.defer(&mut self.state, &view, now) {
                    let replayed = object(&frame_owned.data).clone();
                    let replayed_value = Value::Object(replayed);
                    self.pending.observe(&mut self.state, &replayed_value);
                    let replayed_again = replayed_value.clone();
                    sdk_translator(self, &replayed_again, &view, now);
                }
                self.state.diagnostics.truncate(diag_start);
                for index in start..self.state.facts.len() {
                    let fact = self.state.facts[index].clone();
                    self.state.facts[index] = canonical_only(&fact);
                }
            }
        }
        // End streamed blocks whose turn ended elsewhere.
        let ended_agents: Vec<String> = self
            .state
            .facts
            .iter()
            .filter_map(|fact| {
                let obj = object(fact);
                if str_of(obj.get("type").unwrap_or(&Value::Null)) == "turn.ended" {
                    Some(str_of(obj.get("agent").unwrap_or(&Value::Null)))
                } else {
                    None
                }
            })
            .collect();
        let root = self.state.root.clone();
        for agent in ended_agents {
            if agent != root {
                finish_stream(&mut self.state, &mut self.streams, &agent);
            } else {
                self.pending.turn_ended(now);
            }
        }
        let carries_raw = self.state.facts.iter().any(|fact| {
            fact_raw(fact)
                .iter()
                .any(|payload| object(payload).get("data") == Some(frame.data))
        });
        let diagnosed = self
            .state
            .diagnostics
            .iter()
            .any(|payload| object(payload).get("data") == Some(frame.data));
        if !carries_raw && !diagnosed && frame.channel != "lifecycle" {
            self.diagnostics.push(raw(frame.data));
        }
        self.state.facts.clone()
    }

    pub fn tick(&mut self, now: i64) -> Vec<Value> {
        self.state.facts.clear();
        if self
            .state
            .wake_until
            .map(|until| now >= until)
            .unwrap_or(false)
        {
            self.state.wake = None;
            self.state.wake_until = None;
        }
        self.pending.expire(&mut self.state, now);
        let mut out = task_tick(&mut self.state, now);
        out.push(tick_fact());
        out
    }
}
