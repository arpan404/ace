// SPDX-License-Identifier: Apache-2.0
//! A batch's frames and acknowledgements: what a translator returns and how a batch settles.

use crate::EngineError;
use crate::actor::state::FrameRef;
use crate::futures::channel::oneshot;
use ace_json::Value;

/// One frame's translation, as the batch helper returned it.
#[derive(Debug, Default, Clone)]
pub struct TranslatedFrame {
    pub facts: Vec<Value>,
    pub diagnostics: Vec<Value>,
    /// The whole frame, for the Cursor SDK journal (`actor.ts:475`–`:491`) only.
    pub frame: Option<Value>,
    /// The frame's own account, when it has one: `{id, billingMode}`.
    pub usage_account: Option<Value>,
}

/// A JavaScript translator, called once per batch (`engine/js_translator.rs`).
pub trait JsBatchTranslator {
    fn translate_batch(
        &mut self,
        frames: &[&FrameRef],
        now: f64,
    ) -> Result<Vec<TranslatedFrame>, EngineError>;
    fn tick(&mut self, now: f64) -> Result<Vec<Value>, EngineError>;
    fn next_deadline(&mut self) -> Option<i64>;
}

/// Each actor's translator, set when a session attaches and cleared with it.
pub enum ActorTranslator {
    Js(Box<dyn JsBatchTranslator>),
    Native(Box<dyn ace_adapter_api::Translator>),
}

/// The shell's promises for frame acknowledgements: one per batch.
pub trait FrameAcks {
    /// One promise for a batch this frame starts; `None` before the shell registers any.
    fn alloc(&self) -> Option<u64>;
    fn settle(&self, call: u64, reject: Option<String>);
}

/// Before the shell registers its promises, a settlement is reported, never silent.
pub struct UnportedAcks;

impl FrameAcks for UnportedAcks {
    fn alloc(&self) -> Option<u64> {
        None
    }

    fn settle(&self, _call: u64, reject: Option<String>) {
        if let Some(message) = reject {
            eprintln!("engine frame acknowledgement settled with no shell promise: {message}");
        }
    }
}

/// One batch's acknowledgement: the facade promise, and one sender per native session.
#[derive(Default)]
pub struct BatchAck {
    pub js: Option<u64>,
    pub native: Vec<oneshot::Sender<Result<(), String>>>,
}

impl BatchAck {
    pub fn resolve(&mut self) {
        for sender in self.native.drain(..) {
            let _ = sender.send(Ok(()));
        }
    }

    pub fn reject(&mut self, message: &str) {
        for sender in self.native.drain(..) {
            let _ = sender.send(Err(message.to_string()));
        }
    }
}
