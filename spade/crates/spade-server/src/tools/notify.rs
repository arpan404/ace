//! `notify` (ADR 0200 §4.2) and `package_suggest` (§8, §10 phase 2): what a bot says to the
//! person outside its replies. `notify` is run by the engine for the calling conversation;
//! `package_suggest` is offered like any tool and answered by the turn loop with a card.

use serde_json::{Value, json};
use spade_core::question::suggest::PACKAGE_SUGGEST;
use spade_core::reach::notice::{BODY_CHARS, NOTIFY, TITLE_CHARS};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput};

const NOTIFY_ABOUT: &str = "Tell the person something now, outside this conversation: a short \
notice on their screen, for something they'd want to know without opening Spade (a fare that \
dropped, a job that finished, something that needs them soon). Not for progress or chatter, \
which belong in your reply. Spade decides when it reaches them: during their quiet hours, do not \
disturb or once they've had enough interruptions it waits for their morning brief, and it never \
reaches them when they've turned you off. At most 3 an hour reach them (more wait for the brief) \
and 12 a day (more are refused), so put what matters in one. Plain text only: links don't open.";

const SUGGEST_ABOUT: &str = "Suggest a bot package from the market to the person, when one would \
clearly help with what they asked: a card in this conversation with the package's face, name, \
publisher, what it does and what it would be allowed to do, and your reason. The person reviews \
and installs it themselves, or chooses Later or Not now; you can never install anything. It must \
be a package the market lists, by its name there (such as flight-watcher); a name the market \
doesn't have is refused. Once a person says Not now, don't suggest it again for this task.";

fn string(about: &str, most: usize) -> Value {
    json!({ "type": "string", "description": about, "maxLength": most })
}

/// `notify`, run by the engine for the calling conversation.
pub struct Notify(pub EngineHandle);

impl Tool for Notify {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: NOTIFY.to_owned(),
                description: NOTIFY_ABOUT.to_owned(),
                schema: json!({ "type": "object",
                    "properties": {
                        "title": string("A few words the person reads first.", TITLE_CHARS),
                        "body": string("One or two sentences more, if they help.", BODY_CHARS) },
                    "required": ["title"],
                    "additionalProperties": false }),
            },
            risk: Risk::Memory,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        Some(spade_core::effect::Effect::WriteLocal)
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let engine = self.0.get();
        let conversation = super::bots::caller(key).to_owned();
        let call_id = key.split_once('.').map_or(key, |(_, call)| call).to_owned();
        Box::pin(async move {
            match engine {
                Some(engine) => engine.notify_call(&conversation, &call_id, &arguments),
                None => ToolOutput::error("Spade is stopping."),
            }
        })
    }
}

/// `package_suggest`: offered like any tool, answered by the turn loop with a card.
pub struct PackageSuggest;

impl Tool for PackageSuggest {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: PACKAGE_SUGGEST.to_owned(),
                description: SUGGEST_ABOUT.to_owned(),
                schema: json!({ "type": "object",
                    "properties": {
                        "package": string("The package's name in the market.", 64),
                        "why": string("One short line for the person: why it would help them.", 300) },
                    "required": ["package", "why"],
                    "additionalProperties": false }),
            },
            risk: Risk::Read,
            untrusted_output: false,
            deferred: false,
            background: false,
        }
    }

    fn effect(&self, _arguments: &Value) -> Option<spade_core::effect::Effect> {
        Some(spade_core::effect::Effect::Read)
    }

    fn run(&self, _key: &str, _arguments: Value) -> ToolFuture {
        Box::pin(async { ToolOutput::error("package_suggest is answered by the person.") })
    }
}
