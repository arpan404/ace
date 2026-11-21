//! An outside agent's skills as a bot's tools (ADR 0202 §5): `<agent>__<skill>`, deferred and
//! found with `tool_search`, each call read as `send_as_person`, so it goes to the person every
//! call. A call sends one message whose id is the call's key (so a call run again after a restart
//! reaches the same task, never a second new one), then reads the task with backoff until it
//! ends; a long one goes on as the bot's background job. Stop cuts the call off, and its task is
//! cancelled (`CancelTask`), sent until the agent answers.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use spade_core::effect::Effect;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_store::Store;

use super::card::Skill;
use super::client::{A2aClient, Unreached};
use super::task::{self, Step};
use super::{Added, OutsideAgents};
use crate::tools::{Tool, ToolFuture, ToolOutput, ToolSource};

/// Spade's A2A extension: a message names the skill it is for under it, which Spade's own A2A
/// endpoint reads (`outside::a2a`); other agents ignore it.
const EXTENSION: &str = "https://spec.acehq.dev/a2a/spade/1";
/// Reading a task: the first wait, the longest, and how many failed reads in a row end the call.
const FIRST_POLL: Duration = Duration::from_millis(200);
const LONGEST_POLL: Duration = Duration::from_secs(5);
const MOST_FAILED_READS: u32 = 5;
const CANCEL_TRIES: u32 = 5;

/// The person's outside agents' skills, for the main bot.
pub struct OutsideAgentSource {
    agents: Arc<OutsideAgents>,
    store: Store,
}

impl OutsideAgentSource {
    pub fn new(agents: Arc<OutsideAgents>, store: Store) -> Self {
        Self { agents, store }
    }
}

impl ToolSource for OutsideAgentSource {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        Vec::new()
    }

    /// The main bot's alone for now: an outside agent isn't granted to other bots yet.
    fn tools_for(&self, conversation: &str) -> Vec<Arc<dyn Tool>> {
        match self.store.agent_for_conversation(conversation) {
            Ok(Some(agent)) if agent.kind == crate::engine::MAIN => {}
            _ => return Vec::new(),
        }
        self.agents
            .list()
            .into_iter()
            .flat_map(|added| {
                let client = self.agents.client().clone();
                added.card.skills.clone().into_iter().map(move |skill| {
                    Arc::new(SkillCall {
                        agent: added.clone(),
                        skill,
                        client: client.clone(),
                    }) as Arc<dyn Tool>
                })
            })
            .collect()
    }
}

struct SkillCall {
    agent: Added,
    skill: Skill,
    client: A2aClient,
}

impl SkillCall {
    fn name(&self) -> String {
        format!(
            "{}{}{}",
            self.agent.agent.id,
            spade_connect::SEPARATOR,
            self.skill.id
        )
    }

    /// The message's parts: a JSON skill takes the arguments as one data part, any other the
    /// `message` as text.
    fn parts(&self, arguments: &Value) -> Value {
        if self.skill.json {
            json!([{ "data": arguments, "mediaType": "application/json" }])
        } else {
            json!([{ "text": arguments["message"].as_str().unwrap_or_default() }])
        }
    }
}

impl Tool for SkillCall {
    fn def(&self) -> ToolDef {
        let schema = if self.skill.json {
            json!({
                "type": "object",
                "description": "The JSON this skill takes, as the agent describes it.",
            })
        } else {
            json!({
                "type": "object",
                "properties": { "message": { "type": "string", "description": "What to send the agent." } },
                "required": ["message"],
            })
        };
        let about = if self.skill.description.is_empty() {
            &self.skill.name
        } else {
            &self.skill.description
        };
        ToolDef {
            spec: ToolSpec {
                name: self.name(),
                description: format!(
                    "{} (an outside agent, over A2A): {about}. Each call sends what you give it \
                     to that agent as the person, so the person decides each one.",
                    self.agent.agent.name
                ),
                schema,
            },
            risk: Risk::Write,
            untrusted_output: true,
            deferred: true,
            background: false,
        }
    }

    /// The person's data leaves for another party, signed in as them: a send, every call. The
    /// card's word never lowers it.
    fn effect(&self, _arguments: &Value) -> Option<Effect> {
        Some(Effect::SendAsPerson)
    }

    fn identity(&self) -> String {
        format!(
            "a2a:{}@{}:{}",
            self.agent.agent.id, self.agent.agent.endpoint, self.skill.id
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let client = self.client.clone();
        let endpoint = self.agent.agent.endpoint.clone();
        let agent = self.agent.agent.name.clone();
        let skill = self.skill.id.clone();
        let message = json!({
            "messageId": key,
            "role": "ROLE_USER",
            "parts": self.parts(&arguments),
            "metadata": { EXTENSION: { "skill": skill } },
        });
        Box::pin(async move {
            let mut cancel = Cancel {
                client: client.clone(),
                endpoint: endpoint.clone(),
                task: Arc::new(Mutex::new(None)),
            };
            let sent = client
                .call(
                    &endpoint,
                    "SendMessage",
                    json!({ "message": message, "configuration": { "returnImmediately": true } }),
                )
                .await;
            let answer = match sent {
                Ok(answer) => answer,
                Err(Unreached::NotSent(why)) => {
                    return ToolOutput::error(format!("Not sent: {why}. It is safe to try again."));
                }
                Err(Unreached::Unknown(why)) => {
                    return ToolOutput::maybe_ran(format!(
                        "{} ({why})",
                        spade_core::context::MAYBE_RAN
                    ));
                }
                Err(Unreached::Refused { message, .. }) => {
                    return ToolOutput::error(format!(
                        "{agent} refused it: \"{message}\" (its words, untrusted)"
                    ));
                }
            };
            let (mut id, mut step) = task::read(&answer, &agent, &skill);
            cancel.hold(id.clone());
            let mut wait = FIRST_POLL;
            let mut failed = 0;
            while step == Step::Working {
                let Some(task) = id.clone() else { break };
                tokio::time::sleep(wait).await;
                wait = (wait * 3 / 2).min(LONGEST_POLL);
                match client
                    .call(&endpoint, "GetTask", json!({ "id": task }))
                    .await
                {
                    Ok(answer) => {
                        failed = 0;
                        let (read_id, read) = task::read(&answer, &agent, &skill);
                        id = read_id.or(id);
                        step = read;
                    }
                    Err(Unreached::Refused { message, .. }) => {
                        step = Step::Ended(format!("{agent} lost the task: \"{message}\""));
                    }
                    Err(_) if failed + 1 < MOST_FAILED_READS => failed += 1,
                    Err(error) => {
                        step = Step::Ended(format!("{agent} couldn't be read: {error}"));
                    }
                }
            }
            // It ended on its own: nothing to cancel.
            cancel.hold(None);
            let output = match step {
                Step::Done(text) => ToolOutput::ok(text),
                Step::Waiting(text) => ToolOutput::ok(format!(
                    "{agent} asks for more before it goes on. Ask the person; their answer is \
                     theirs to give, not the agent's:\n{text}"
                )),
                Step::NeedsSignIn => ToolOutput::error(format!(
                    "{agent} needs a sign-in Spade doesn't hold for it."
                )),
                Step::Ended(why) => ToolOutput::error(why),
                Step::Working => ToolOutput::error(format!("{agent} gave no task to follow.")),
            };
            ToolOutput {
                untrusted: true,
                ..output
            }
        })
    }
}

/// Cancels the call's task when the call is cut off (Stop) before the task ended.
struct Cancel {
    client: A2aClient,
    endpoint: String,
    task: Arc<Mutex<Option<String>>>,
}

impl Cancel {
    fn hold(&mut self, task: Option<String>) {
        *self.task.lock().unwrap_or_else(|p| p.into_inner()) = task;
    }
}

impl Drop for Cancel {
    fn drop(&mut self) {
        let Some(task) = self.task.lock().unwrap_or_else(|p| p.into_inner()).take() else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let (client, endpoint) = (self.client.clone(), self.endpoint.clone());
        runtime.spawn(async move {
            let mut wait = FIRST_POLL;
            for _ in 0..CANCEL_TRIES {
                match client
                    .call(&endpoint, "CancelTask", json!({ "id": task }))
                    .await
                {
                    // Any answer is an answer: cancelled, or it ended already.
                    Ok(_) | Err(Unreached::Refused { .. }) => return,
                    Err(_) => {
                        tokio::time::sleep(wait).await;
                        wait = (wait * 2).min(LONGEST_POLL);
                    }
                }
            }
            tracing::warn!(%task, "an outside agent's task could not be cancelled");
        });
    }
}
