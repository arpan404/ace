use std::sync::Arc;

use serde_json::{Value, json};
use spade_connect::Connectors;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{AceLink, EngineHandle, Tool, ToolFuture, ToolOutput, TurnFacts};
use crate::skill_store::SkillStore;
use crate::teams::share_template;

/// Checks candidate text with the local daemon's signed-in identity.
pub trait TemplatePrivacy: Send + Sync {
    fn scan<'a>(&'a self, texts: &'a [&'a str]) -> crate::teams::BoxFuture<'a, Option<bool>>;
}

impl TemplatePrivacy for AceLink {
    fn scan<'a>(&'a self, texts: &'a [&'a str]) -> crate::teams::BoxFuture<'a, Option<bool>> {
        Box::pin(self.template_is_private(texts))
    }
}

pub struct TemplateDraft {
    engine: EngineHandle,
    connectors: Option<Arc<Connectors>>,
    skills: Option<Arc<SkillStore>>,
    private_words: Vec<String>,
    privacy: Option<Arc<dyn TemplatePrivacy>>,
}

impl TemplateDraft {
    pub fn new(
        engine: EngineHandle,
        connectors: Option<Arc<Connectors>>,
        skills: Option<Arc<SkillStore>>,
        privacy: Option<Arc<dyn TemplatePrivacy>>,
    ) -> Self {
        Self {
            engine,
            connectors,
            skills,
            private_words: share_template::system_words(),
            privacy,
        }
    }

    pub(super) fn local(engine: EngineHandle) -> Self {
        Self {
            engine,
            connectors: None,
            skills: None,
            private_words: Vec::new(),
            privacy: None,
        }
    }
}

impl Tool for TemplateDraft {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "template_draft".to_owned(),
                description: "Draft a private template as capable as you are. Review your own task, personality, memory, skills and their files, routines and heartbeat, model roles, apps and plugins, panels and contracts. Use knowledge_search and knowledge_read for what you know and episode_search for what worked and failed on past goals. Distil both into separate reusable knowledge pages: kind playbook for methods, lesson for insights from episodes. Rewrite notes and task for a new owner. Leave personal names, places, accounts, repositories, history and raw source records behind, and explain what stays. Include skill names or Store ids, generalized schedule and event routine suggestions, a heartbeat checklist if useful, and portable surface files and contract definitions. Plugin commands stay with their plugins. Only the person can publish.".to_owned(),
                schema: json!({
                    "type": "object", "additionalProperties": false,
                    "required": ["description", "task"],
                    "properties": {
                        "name": {"type":"string"},
                        "description": {"type":"string"},
                        "task": {"type":"string"},
                        "skills": {"type":"array", "items":{"type":"string"}, "maxItems":32},
                        "knowledge": {"type":"array", "maxItems":32, "items":{
                            "type":"object", "additionalProperties":false,
                            "required":["kind","topic","title","body"],
                            "properties":{"kind":{"enum":["playbook","lesson"]},"topic":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"}}
                        }},
                        "heartbeat":{"type":"object", "additionalProperties":false, "required":["every_minutes","checklist"],
                            "properties":{"every_minutes":{"type":"integer","minimum":5,"maximum":1440},"checklist":{"type":"string"}}},
                        "surfaces":{"type":"array","maxItems":16,"items":{"type":"object","required":["definition","text"],
                            "properties":{"definition":{"type":"object"},"text":{"type":"string"}}}},
                        "event_routines":{"type":"array","maxItems":32,"items":{"type":"object","required":["kind","name","instruction"],
                            "properties":{"kind":{"enum":["event","webhook"]},"name":{"type":"string"},"instruction":{"type":"string"},"event":{"enum":["thread.finished","thread.failed","thread.needs_you"]}}}},
                        "contracts":{"type":"array","maxItems":16,"items":{"type":"object"}},
                        "effects":{"type":"array","maxItems":32,"items":{"type":"object"}},
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
        let privacy = self.privacy.clone();
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
            let Some(privacy) = privacy else {
                return ToolOutput::error(
                    "Sign in to ace and reconnect to check the draft's privacy.",
                );
            };
            let texts = share_template::privacy_text(&draft);
            match tokio::time::timeout(std::time::Duration::from_secs(2), privacy.scan(&texts))
                .await
            {
                Ok(Some(false)) => {}
                Ok(Some(true)) => {
                    return ToolOutput::error(
                        "The proposal contains private text. Generalize it and try again.",
                    );
                }
                _ => {
                    return ToolOutput::error(
                        "The signed-in privacy check did not complete. Try again before drafting.",
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
