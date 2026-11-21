//! An outside agent's skills as a bot's tools (ADR 0202 §5): `<agent>__<skill>`, deferred and
//! found with `tool_search`, each call read as `send_as_person`, so it goes to the person every
//! call. A call sends one message whose id is the call's key (so a call run again after a restart
//! reaches the same task, never a second new one), then reads the task with backoff until it
//! ends; a long one goes on as the bot's background job. Every result, an error included, is
//! marked untrusted: it carries the other party's words.
//!
//! Stop cuts the call off, and whatever task it opened is cancelled: a message still being sent
//! is left to finish (it is bounded by the client's timeout) so a task it opens is cancelled too,
//! and a task is held until an answer shows it ended (a call that ends otherwise, given up or
//! interrupted, cancels it as well). A cancel counts only once the agent answers that the task
//! ended; one it never confirms is listed on the agent as possibly still running.

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
use super::{Added, OutsideAgents, Unconfirmed};
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
                let unconfirmed = self.agents.unconfirmed();
                added.card.skills.clone().into_iter().map(move |skill| {
                    Arc::new(SkillCall {
                        agent: added.clone(),
                        skill,
                        client: client.clone(),
                        unconfirmed: unconfirmed.clone(),
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
    unconfirmed: Arc<Unconfirmed>,
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
        let stopper = Stopper {
            client: self.client.clone(),
            endpoint: self.agent.agent.endpoint.clone(),
            local: self.agent.agent.local,
            agent: self.agent.agent.id.clone(),
            unconfirmed: self.unconfirmed.clone(),
        };
        let agent = self.agent.agent.name.clone();
        let skill = self.skill.id.clone();
        let message = json!({
            "messageId": key,
            "role": "ROLE_USER",
            "parts": self.parts(&arguments),
            "metadata": { EXTENSION: { "skill": skill } },
        });
        // Every way out carries the agent's (or its server's) words.
        Box::pin(async move { call(stopper, agent, skill, message).await.untrusted() })
    }
}

async fn call(stopper: Stopper, agent: String, skill: String, message: Value) -> ToolOutput {
    let track = Track {
        shared: Arc::default(),
        stopper: stopper.clone(),
    };
    // Sent on its own, so a Stop while it is in flight doesn't lose the task it opens.
    let submission = {
        let (shared, stopper) = (track.shared.clone(), stopper.clone());
        tokio::spawn(async move {
            let params =
                json!({ "message": message, "configuration": { "returnImmediately": true } });
            let sent = stopper
                .client
                .call(&stopper.endpoint, stopper.local, "SendMessage", params)
                .await;
            if let Ok(answer) = &sent
                && !task::settled(answer)
                && let Some(task) = task::id_of(answer)
            {
                Track::hold(&shared, &stopper, task);
            }
            sent
        })
    };
    let sent = submission
        .await
        .unwrap_or_else(|_| Err(Unreached::Unknown("its answer was lost".to_owned())));
    let answer = match sent {
        Ok(answer) => answer,
        Err(Unreached::NotSent(why)) => {
            return ToolOutput::error(format!("Not sent: {why}. It is safe to try again."));
        }
        Err(Unreached::Unknown(why)) => {
            return ToolOutput::maybe_ran(format!("{} ({why})", spade_core::context::MAYBE_RAN));
        }
        Err(Unreached::Refused { message, .. }) => {
            return ToolOutput::error(format!(
                "{agent} refused it: \"{message}\" (its words, untrusted)"
            ));
        }
    };
    let (mut id, mut step) = task::read(&answer, &agent, &skill);
    let mut wait = FIRST_POLL;
    let mut failed = 0;
    while step == Step::Working {
        let Some(task) = id.clone() else { break };
        tokio::time::sleep(wait).await;
        wait = (wait * 3 / 2).min(LONGEST_POLL);
        match stopper
            .client
            .call(
                &stopper.endpoint,
                stopper.local,
                "GetTask",
                json!({ "id": task }),
            )
            .await
        {
            Ok(answer) => {
                failed = 0;
                if task::settled(&answer) {
                    track.settle();
                }
                let (read_id, read) = task::read(&answer, &agent, &skill);
                id = read_id.or(id);
                step = read;
            }
            // Not known to have ended: its task stays held, and is cancelled as the call ends.
            Err(Unreached::Refused { message, .. }) => {
                step = Step::Ended(format!("{agent} lost the task: \"{message}\""));
            }
            Err(_) if failed + 1 < MOST_FAILED_READS => failed += 1,
            Err(error) => {
                step = Step::Ended(format!("{agent} couldn't be read: {error}"));
            }
        }
    }
    match step {
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
    }
}

/// How to cancel one agent's tasks, and where a cancel it never confirms is noted.
#[derive(Clone)]
struct Stopper {
    client: A2aClient,
    endpoint: String,
    local: bool,
    agent: String,
    unconfirmed: Arc<Unconfirmed>,
}

impl Stopper {
    /// Cancels `task` on its own: the call it came from is over.
    fn cancel(&self, task: String) {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            self.unconfirmed.note(&self.agent, &task);
            return;
        };
        let stopper = self.clone();
        runtime.spawn(async move {
            if !stopper.cancelled(&task).await {
                tracing::warn!(%task, "an outside agent never confirmed its task was cancelled");
                stopper.unconfirmed.note(&stopper.agent, &task);
            }
        });
    }

    /// Whether the agent answered that `task` ended: `CancelTask`, then the task read, until an
    /// answer says so. An answer that the cancel was taken (the task still working), a refusal or
    /// no answer establishes nothing.
    async fn cancelled(&self, task: &str) -> bool {
        let id = json!({ "id": task });
        let mut wait = FIRST_POLL;
        for _ in 0..CANCEL_TRIES {
            for method in ["CancelTask", "GetTask"] {
                if let Ok(answer) = self
                    .client
                    .call(&self.endpoint, self.local, method, id.clone())
                    .await
                    && task::settled(&answer)
                {
                    return true;
                }
            }
            tokio::time::sleep(wait).await;
            wait = (wait * 2).min(LONGEST_POLL);
        }
        false
    }
}

/// The task a call opened and not yet seen end, shared with its submission.
#[derive(Default)]
struct Tracked {
    task: Option<String>,
    /// The call is over: cut off by Stop, or returned.
    over: bool,
}

/// Holds the call's task until it is seen to end; when the call is over first, cancels it.
struct Track {
    shared: Arc<Mutex<Tracked>>,
    stopper: Stopper,
}

impl Track {
    /// The submission opened `task`: held, or cancelled at once if the call is over already.
    fn hold(shared: &Mutex<Tracked>, stopper: &Stopper, task: String) {
        let mut tracked = shared.lock().unwrap_or_else(|p| p.into_inner());
        if tracked.over {
            drop(tracked);
            stopper.cancel(task);
        } else {
            tracked.task = Some(task);
        }
    }

    /// The task was seen to end: nothing to cancel.
    fn settle(&self) {
        self.shared.lock().unwrap_or_else(|p| p.into_inner()).task = None;
    }
}

impl Drop for Track {
    fn drop(&mut self) {
        let task = {
            let mut tracked = self.shared.lock().unwrap_or_else(|p| p.into_inner());
            tracked.over = true;
            tracked.task.take()
        };
        if let Some(task) = task {
            self.stopper.cancel(task);
        }
    }
}
