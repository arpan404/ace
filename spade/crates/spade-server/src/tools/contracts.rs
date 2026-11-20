//! `contracts_find`, `contract_call` and `contract_return` (ADR 0200 §7): typed calls between the
//! person's bots. The engine does the work; these hold a handle to it.

use serde_json::{Value, json};
use spade_core::contract::{CONTRACT_CALL, CONTRACT_RETURN, CONTRACTS_FIND};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::bots::caller;
use super::{EngineHandle, Tool, ToolFuture, ToolOutput};

fn def(name: &str, description: &str, schema: Value, risk: Risk, background: bool) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk,
        // A call's output is another bot's: the engine marks it untrusted when the callee read
        // anything untrusted during the call, as a helper's result is (ADR 0152 §6).
        untrusted_output: false,
        deferred: false,
        background,
    }
}

pub struct ContractsFind(pub EngineHandle);

impl Tool for ContractsFind {
    fn def(&self) -> ToolDef {
        def(
            CONTRACTS_FIND,
            "Lists the contracts your person's other bots offer, on this machine and their other \
             machines: typed calls with an input and an output schema. Give `need` to list only \
             those that answer it.",
            json!({
                "type": "object",
                "properties": {
                    "need": { "type": "string", "description": "What you need answered, in a few words." }
                }
            }),
            Risk::Read,
            false,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key).to_owned());
        Box::pin(async move {
            match engine {
                Some(engine) => engine.contracts_find(&caller, &arguments).await,
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}

pub struct ContractCall(pub EngineHandle);

impl Tool for ContractCall {
    fn def(&self) -> ToolDef {
        def(
            CONTRACT_CALL,
            "Calls another bot's contract with an input in its input schema. It answers at once; \
             the result arrives later as a <contract_result> with output in the contract's output \
             schema, or why it failed. Carry on meanwhile. The other bot works under its own \
             permissions; yours don't pass to it.",
            json!({
                "type": "object",
                "properties": {
                    "bot": { "type": "string", "description": "The bot's id or exact name, as contracts_find lists it." },
                    "machine": { "type": "string", "description": "The bot's machine, as contracts_find names it; leave out for this machine." },
                    "contract": { "type": "string", "description": "The contract's name." },
                    "input": { "type": "object", "description": "The input, in the contract's input schema." }
                },
                "required": ["bot", "contract", "input"]
            }),
            Risk::Write,
            true,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, caller, key) = (self.0.get(), caller(key).to_owned(), key.to_owned());
        Box::pin(async move {
            match engine {
                Some(engine) => engine.contract_call(&caller, &key, arguments).await,
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}

pub struct ContractReturn(pub EngineHandle);

impl Tool for ContractReturn {
    fn def(&self) -> ToolDef {
        def(
            CONTRACT_RETURN,
            "Answers a contract call another bot made to you (a <contract_call>) with output in \
             the contract's output schema. Output that doesn't fit comes back with the problems; \
             fix it and return again.",
            json!({
                "type": "object",
                "properties": {
                    "call": { "type": "string", "description": "The call's id, from its <contract_call>." },
                    "output": { "description": "The answer, in the contract's output schema." }
                },
                "required": ["call", "output"]
            }),
            // It answers a call: the caller treats what it carries as another bot's data.
            Risk::Memory,
            false,
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (engine, caller) = (self.0.get(), caller(key).to_owned());
        Box::pin(async move {
            match engine {
                Some(engine) => engine.contract_return(&caller, &arguments),
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}
