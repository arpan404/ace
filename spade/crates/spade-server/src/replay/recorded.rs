//! The tool layer of a replay (ADR 0204 §2): every tool that would reach outside answers from the
//! kept run's recording, under its real name, read by the gate from the same table. A call the
//! recording holds by tool and arguments gets the answer the kept run got; any other answers
//! "Not in the recording" and is counted. Nothing it does leaves the run.

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use spade_core::quality::replay::{NOT_IN_RECORDING, Recording};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use crate::bot_test::fakes;
use crate::tools::{Tool, ToolFuture, ToolOutput};

pub struct Recorded {
    name: String,
    recording: Arc<Mutex<Recording>>,
}

impl Recorded {
    pub fn new(name: &str, recording: Arc<Mutex<Recording>>) -> Arc<Self> {
        Arc::new(Self {
            name: name.to_owned(),
            recording,
        })
    }
}

/// The risk the real tool has, so compaction and the review see the call as it would be.
fn risk(name: &str) -> Risk {
    match spade_core::effect::runtime::effect(name) {
        Some(spade_core::effect::Effect::Read) => Risk::Read,
        Some(spade_core::effect::Effect::WriteLocal) => Risk::Memory,
        _ => Risk::Write,
    }
}

impl Tool for Recorded {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: self.name.clone(),
                description: format!("{} (answered from a kept run)", self.name),
                schema: json!({ "type": "object" }),
            },
            risk: risk(&self.name),
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        fakes::effect_of(&self.name)
    }

    fn run(&self, _key: &str, arguments: Value) -> ToolFuture {
        let answer = self
            .recording
            .lock()
            .ok()
            .and_then(|mut recording| recording.answer(&self.name, &arguments));
        Box::pin(async move {
            match answer {
                Some((content, false)) => ToolOutput::ok(content),
                Some((content, true)) => ToolOutput::error(content),
                None => ToolOutput::error(NOT_IN_RECORDING),
            }
        })
    }
}
