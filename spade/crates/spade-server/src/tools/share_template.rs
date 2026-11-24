use std::sync::Arc;

use serde_json::{Value, json};
use spade_connect::Connectors;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{AceLink, EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts};
use crate::skill_store::SkillStore;
use crate::teams::share_template;

pub struct TemplateDraft {
    engine: EngineHandle,
    connectors: Option<Arc<Connectors>>,
    skills: Option<Arc<SkillStore>>,
    private_words: Vec<String>,
    ace: Option<Arc<AceLink>>,
}

impl TemplateDraft {
    pub fn new(
        engine: EngineHandle,
        connectors: Arc<Connectors>,
        skills: Arc<SkillStore>,
        ace: Option<Arc<AceLink>>,
    ) -> Self {
        Self {
            engine,
            connectors: Some(connectors),
            skills: Some(skills),
            private_words: share_template::system_words(),
            ace,
        }
    }

    pub(super) fn local(engine: EngineHandle) -> Self {
        Self {
            engine,
            connectors: None,
            skills: None,
            private_words: Vec::new(),
            ace: None,
        }
    }
}

impl Tool for TemplateDraft {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "template_draft".to_owned(),
                description: "Draft a private shareable template of yourself. First review your memories, skills, routines and apps. Explain what transfers and what stays personal. Propose generalized instructions and notes, never copy personal material. Name reusable skills to include (save new skills with skill_propose first). Only the person can publish the card.".to_owned(),
                schema: json!({
                    "type": "object", "additionalProperties": false,
                    "required": ["description", "task"],
                    "properties": {
                        "name": {"type":"string"},
                        "description": {"type":"string"},
                        "task": {"type":"string"},
                        "skills": {"type":"array", "items":{"type":"string"}, "maxItems":32},
                        "notes": {"type":"array", "items":{"type":"string"}, "maxItems":50},
                        "routines": {"type":"array", "maxItems":32, "items":{
                            "type":"object", "additionalProperties":false,
                            "required":["name","instruction","schedule"],
                            "properties":{"name":{"type":"string"},"instruction":{"type":"string"},"schedule":{"type":"string"}}
                        }}
                    }
                }),
            },
            risk: Risk::Memory,
            untrusted_output: false,
            deferred: true,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        self.run_in(key, arguments, &TurnFacts::default())
    }

    fn run_in(&self, key: &str, arguments: Value, turn: &TurnFacts) -> ToolFuture {
        let bot = self.engine.agent_for_key(key);
        let engine = self.engine.get();
        let conversation = super::bots::caller(key).to_owned();
        let call = key.split_once('.').map_or(key, |(_, call)| call).to_owned();
        let connectors = self.connectors.clone();
        let skills = self.skills.clone();
        let names = self.private_words.clone();
        let ace = self.ace.clone();
        let untrusted = turn.untrusted.is_some();
        Box::pin(async move {
            let (Some(engine), Some(bot)) = (engine, bot) else {
                return ToolOutput::error(
                    "Only a bot in its own conversation can draft a template.",
                );
            };
            if untrusted || engine.is_helper(&conversation) {
                return ToolOutput::error(
                    "Draft the template in the bot's own chat without untrusted content.",
                );
            }
            let proposal = match serde_json::from_value(arguments) {
                Ok(proposal) => proposal,
                Err(_) => {
                    return ToolOutput::error(
                        "Provide a description, task, and optional reusable notes, skills and schedules.",
                    );
                }
            };
            let draft = match share_template::make(
                &engine,
                &bot,
                proposal,
                connectors.as_deref(),
                skills.as_deref(),
                &names,
            )
            .await
            {
                Ok(draft) => draft,
                Err(error) => return ToolOutput::error(error),
            };
            if let Some(ace) = ace {
                let texts = share_template::privacy_text(&draft);
                let scanned = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    ace.template_is_private(&texts),
                )
                .await;
                if matches!(scanned, Ok(Some(true))) {
                    return ToolOutput::error(
                        "The proposal contains private text. Generalize it and try again.",
                    );
                }
            }
            match engine.keep_share_template(&conversation, &call, &draft) {
                Ok(id) => ToolOutput::ok(format!(
                    "Template {id} is in the chat. It stays private until the person confirms. Left out: {}",
                    draft.left_out.join(" ")
                )),
                Err(error) => ToolOutput::error(error),
            }
        })
    }
}
