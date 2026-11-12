//! `skill_propose` and `skill_feedback`: a bot offers the person a new skill or an edit of one,
//! and keeps notes on the skills it used. Neither changes anything outside Spade, so neither asks.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{
    BODY_BYTES, DESCRIPTION_CHARS, Draft, Learning, NOTE_CHARS, Verdict, WHY_CHARS, is_slug,
};
use crate::tools::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};

pub struct SkillPropose {
    pub learning: Arc<Learning>,
    pub bots: EngineHandle,
}

pub struct SkillFeedback {
    pub learning: Arc<Learning>,
    pub bots: EngineHandle,
}

#[derive(Deserialize)]
struct ProposeArgs {
    name: String,
    description: String,
    body: String,
    #[serde(default)]
    why: String,
}

#[derive(Deserialize)]
struct FeedbackArgs {
    name: String,
    verdict: Verdict,
    #[serde(default)]
    note: String,
}

fn def(name: &str, description: &str, schema: Value) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema,
        },
        risk: Risk::Read,
        untrusted_output: false,
        deferred: false,
        background: false,
    }
}

/// Why `args` cannot be proposed, in words for the model.
fn refusal(args: &ProposeArgs) -> Option<String> {
    if !is_slug(&args.name) {
        return Some(
            "name must be lowercase letters and digits joined by single hyphens, at most 64, \
             such as release-notes"
                .to_owned(),
        );
    }
    let description = args.description.trim();
    if description.is_empty() || description.chars().count() > DESCRIPTION_CHARS {
        return Some(format!(
            "description must say in 1 to {DESCRIPTION_CHARS} characters when to use the skill"
        ));
    }
    if args.body.trim().is_empty() || args.body.len() > BODY_BYTES {
        return Some(format!(
            "body must hold the skill's instructions, at most {BODY_BYTES} bytes"
        ));
    }
    if args.why.chars().count() > WHY_CHARS {
        return Some(format!("why must be at most {WHY_CHARS} characters"));
    }
    None
}

impl Tool for SkillPropose {
    fn def(&self) -> ToolDef {
        def(
            "skill_propose",
            "Offers the person a skill: instructions you or any agent can load later for this \
             kind of task. Use it after you worked out a task of several steps, or after the \
             person corrected you, when the lesson will matter again. Give the name of an \
             existing skill to propose an edit of it (load it first, and send the whole new \
             body). The person sees it and chooses Save or Discard; nothing changes until then. \
             body is Markdown without frontmatter: when it applies, the steps, what to avoid.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "lowercase-with-hyphens" },
                    "description": { "type": "string", "description": "When to use it, in one or two sentences." },
                    "body": { "type": "string" },
                    "why": { "type": "string", "description": "What you learned that this captures, for the person." }
                },
                "required": ["name", "description", "body"]
            }),
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (learning, agent, key) = (
            self.learning.clone(),
            self.bots.agent_for_key(key),
            key.to_owned(),
        );
        Box::pin(async move {
            let args: ProposeArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let Some(agent) = agent else {
                return ToolOutput::error("This conversation has no bot to propose for.");
            };
            if let Some(why) = refusal(&args) {
                return ToolOutput::error(why);
            }
            let source = match learning.library().source(&args.name).await {
                Ok(source) => source,
                Err(error) => {
                    return ToolOutput::error(format!(
                        "The skill library cannot be reached now ({error}). Propose it later."
                    ));
                }
            };
            if let Some(source) = &source {
                if !source.editable {
                    return ToolOutput::error(format!(
                        "{} is a skill that cannot be changed here (built in, from a plugin or \
                         a project). Propose yours under another name.",
                        args.name
                    ));
                }
                if source.description == args.description.trim() && source.body == args.body {
                    return ToolOutput::error(
                        "That is the skill as it already is; propose only a change.",
                    );
                }
            }
            let editing = source.is_some();
            let draft = Draft {
                name: args.name.clone(),
                description: args.description.trim().to_owned(),
                body: args.body,
                why: args.why.trim().to_owned(),
                base: source,
            };
            let stored =
                tokio::task::spawn_blocking(move || learning.propose(&agent, &key, draft)).await;
            match stored {
                Ok(Ok(_)) => ToolOutput::ok(format!(
                    "Proposed {} {}. The person sees it in the chat and chooses Save or \
                     Discard; nothing changes until then. Do not mention it again unless asked.",
                    if editing {
                        "an edit of"
                    } else {
                        "the new skill"
                    },
                    args.name
                )),
                Ok(Err(error)) => ToolOutput::error(error.to_string()),
                Err(_) => ToolOutput::error("The proposal could not be stored."),
            }
        })
    }
}

impl Tool for SkillFeedback {
    fn def(&self) -> ToolDef {
        def(
            "skill_feedback",
            "Notes how a skill you loaded worked: helpful, or outdated (wrong or missing \
             something). Your note shows with the skill whenever you load it again.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "verdict": { "type": "string", "enum": ["helpful", "outdated"] },
                    "note": { "type": "string", "description": "What worked, or what is wrong." }
                },
                "required": ["name", "verdict"]
            }),
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (learning, agent) = (self.learning.clone(), self.bots.agent_for_key(key));
        Box::pin(async move {
            let args: FeedbackArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let Some(agent) = agent else {
                return ToolOutput::error("This conversation has no bot to keep notes for.");
            };
            if args.note.chars().count() > NOTE_CHARS {
                return ToolOutput::error(format!("note must be at most {NOTE_CHARS} characters"));
            }
            let verdict = args.verdict;
            let noted = tokio::task::spawn_blocking(move || {
                learning.note(&agent, &args.name, args.verdict, args.note.trim())
            })
            .await;
            match noted {
                Ok(Ok(())) if verdict == Verdict::Outdated => ToolOutput::ok(
                    "Noted. If you know what should change, propose an edit with skill_propose.",
                ),
                Ok(Ok(())) => ToolOutput::ok("Noted."),
                Ok(Err(error)) => ToolOutput::error(format!("The note was not kept: {error}")),
                Err(_) => ToolOutput::error("The note was not kept."),
            }
        })
    }
}
