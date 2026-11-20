//! `bot_create` (ADR 0161): a bot makes a worker bot for part of its work. The worker is a bot
//! of the person's like any other, listed under its maker, with its own conversation, workspace,
//! goal and plan. It never gets more than its maker has: its tools, connectors and
//! plugins are subsets of the maker's.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::event::{FromAgent, Known};
use spade_core::tree::{self, Grants, Kind, Link, Started};
use spade_core::{Event, context};
use spade_store::NewAgent;

use super::super::Engine;
use super::lock;
use crate::tools::ToolOutput;

/// What `bot_create` answers when the work that called it was stopped.
const STOPPED: &str = "Not made: the person stopped this work.";

/// Where a bot's connectors are granted (ADR 0131): the server sets the person's connector hub.
pub trait ConnectorGrants: Send + Sync {
    /// The connectors `agent` may use now: `None` for every one.
    fn allowed(&self, agent: &str, is_main: bool) -> Option<BTreeSet<String>>;
    /// Lets `agent` use exactly `connectors`.
    fn grant(&self, agent: &str, connectors: BTreeSet<String>) -> Result<(), String>;
}

impl ConnectorGrants for spade_connect::Connectors {
    fn allowed(&self, agent: &str, is_main: bool) -> Option<BTreeSet<String>> {
        match self.access(agent, is_main) {
            spade_connect::Access::All => None,
            spade_connect::Access::Only(ids) => Some(ids),
        }
    }

    fn grant(&self, agent: &str, connectors: BTreeSet<String>) -> Result<(), String> {
        self.set_access(agent, spade_connect::Access::Only(connectors))
            .map_err(|e| e.to_string())
    }
}

/// The `bot_create` call's arguments.
#[derive(serde::Deserialize)]
struct Arguments {
    name: String,
    task: String,
    #[serde(default)]
    brief: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    tools: Option<Vec<String>>,
    #[serde(default)]
    connectors: Vec<String>,
    #[serde(default)]
    plugins: Vec<String>,
}

impl Engine {
    /// Sets the person's apps: where connectors are granted to workers, and what a bot asking
    /// for an app is answered from. Once; later calls are ignored.
    pub fn set_connector_grants(&self, hub: Arc<spade_connect::Connectors>) {
        let _ = self.apps.set(hub.clone());
        let _ = self.workers.grants.set(hub);
    }

    /// The person's apps, as bots are let use them; `None` when Spade has none.
    pub(crate) fn connector_grants(&self) -> Option<&Arc<dyn ConnectorGrants>> {
        self.workers.grants.get()
    }

    /// `bot_create` from the call with `key` (`<conversation>.<call>`): makes the worker (once,
    /// even when the call runs again after a restart) and starts it, or queues it while the
    /// maker's workers are all busy.
    pub(crate) fn bot_create(self: &Arc<Self>, key: &str, arguments: Value) -> ToolOutput {
        let Some((caller, _)) = key.split_once('.') else {
            return ToolOutput::error("Spade could not tell which bot asked.");
        };
        if self.helper_of(caller).is_some() {
            return ToolOutput::error(
                "Refused: a helper cannot make bots. Answer, and say what your bot should make.",
            );
        }
        // Made already by an earlier run of this call.
        if let Some(made) = self
            .worker_children(caller)
            .into_iter()
            .find(|c| self.worker_link(c).is_some_and(|l| l.call == key))
        {
            return self.created(&made);
        }
        let arguments: Arguments = match crate::tools::parse(arguments) {
            Ok(arguments) => arguments,
            Err(refused) => return refused,
        };
        match self.make_worker(caller, key, arguments) {
            Ok(conversation) => {
                self.admit_queued(caller);
                self.created(&conversation)
            }
            Err(why) => ToolOutput::error(why),
        }
    }

    /// Checks the grants against the maker's and stores the worker; its conversation.
    fn make_worker(
        self: &Arc<Self>,
        caller: &str,
        key: &str,
        arguments: Arguments,
    ) -> Result<String, String> {
        let me = self
            .store
            .agent_for_conversation(caller)
            .map_err(|e| e.to_string())?
            .ok_or("Only a bot can make workers.")?;
        let name = super::super::agents::name(&arguments.name).map_err(|e| e.to_string())?;
        let task = super::super::agents::task(&arguments.task).map_err(|e| e.to_string())?;
        if task.is_empty() {
            return Err("Give the worker a task: what it is for, in full.".to_owned());
        }
        // Routing's choice (ADR 0162): a role, or a model the person configured, within the
        // maker's allowed list.
        let model = match arguments.model.as_deref().map(str::trim) {
            Some(model) if !model.is_empty() => self.pick_model(caller, model)?,
            _ => self.reply_model(caller),
        };
        let depth = self.worker_ancestors(caller).len() + 1;
        if depth >= super::super::MOST_HOPS as usize {
            return Err(format!(
                "Refused: your tree is {depth} bots deep already. Do this part yourself or with \
                 a helper."
            ));
        }
        let events = self.load(caller).map_err(|e| e.to_string())?;
        // Tools: only the maker's.
        let registry = self.registry_for(caller);
        if let Some(tools) = &arguments.tools {
            let missing = tree::ungrantable(tools, |name| registry.get(name).is_some());
            if !missing.is_empty() {
                return Err(format!(
                    "Refused: you can't give a worker tools you don't have: {}.",
                    missing.join(", ")
                ));
            }
        }
        let connectors = self.grantable_connectors(&me, &arguments.connectors)?;
        let plugins = self.grantable_plugins(&me.id, &arguments.plugins)?;
        let brief = arguments
            .brief
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map_or_else(|| task.clone(), str::to_owned);
        if brief.chars().count() > self.limits.longest_message {
            return Err("The brief is too long.".to_owned());
        }
        // Fixed now, while the brief is written: a queued one may start much later.
        let untrusted = !context::untrusted_in_view(&events, &registry).is_empty();
        let id = self.ids.next("a");
        let conversation = self.ids.next("c");
        let avatar = self.avatar(&id, None).map_err(|e| e.to_string())?;
        let link = Link {
            parent: me.id.clone(),
            parent_conversation: caller.to_owned(),
            parent_name: me.name.clone(),
            call: key.to_owned(),
            grants: Grants {
                tools: arguments.tools.clone(),
                connectors: connectors.iter().cloned().collect(),
                plugins: plugins.iter().cloned().collect(),
            },
            brief,
            untrusted,
        };
        let first = [
            Event::Known(Known::WorkerOf(link)),
            Event::Known(Known::AgentConfigured {
                task: task.clone(),
                model: model.clone(),
                personality: None,
                change: None,
            }),
            // Named by its maker: no model call for a title.
            Event::renamed(name.clone()),
        ];
        let call = key.split_once('.').map_or(key, |(_, c)| c).to_owned();
        let started = Event::Known(Known::WorkerStarted(Started {
            worker: id.clone(),
            kind: Kind::Bot,
            name: name.clone(),
            conversation: Some(conversation.clone()),
            call: call.clone(),
        }));
        self.registering("worker", caller);
        {
            // Admitted under the lock Stop stores its marker under: a worker from stopped work is
            // never made, and one made before the marker is there for Stop's second sweep.
            let _order = lock(&self.record_lock);
            let now = self.load(caller).map_err(|e| e.to_string())?;
            if spade_core::turn::call_stopped(&now, &call) || self.deleting(caller) {
                return Err(STOPPED.to_owned());
            }
            self.store
                .create_agent(
                    NewAgent {
                        id: &id,
                        kind: super::super::BOT,
                        name: &name,
                        task: &task,
                        avatar: &avatar,
                        model: &model,
                        conversation: &conversation,
                    },
                    &first,
                    self.now_ms(),
                )
                .map_err(|e| format!("Spade could not make it: {e}"))?;
            self.workers_stored(&conversation, &first);
            if let Err(error) = self.append(caller, &started) {
                // The worker's own link is what the tree is folded from; this is the maker's note.
                tracing::warn!(%error, "a worker's start was not noted in its maker's conversation");
            }
        }
        self.announce(caller);
        if let (Some(grants), false) = (self.workers.grants.get(), connectors.is_empty())
            && let Err(error) = grants.grant(&id, connectors)
        {
            tracing::warn!(%error, "a worker's connectors were not granted");
        }
        if let (Some(all), false) = (self.plugins(), plugins.is_empty())
            && let Err(error) = all.set_allowed(&id, plugins)
        {
            tracing::warn!(%error, "a worker's plugins were not granted");
        }
        Ok(conversation)
    }

    /// The connectors asked for, if the maker may use each of them.
    fn grantable_connectors(
        &self,
        me: &spade_store::Agent,
        asked: &[String],
    ) -> Result<BTreeSet<String>, String> {
        if asked.is_empty() {
            return Ok(BTreeSet::new());
        }
        let Some(grants) = self.workers.grants.get() else {
            return Err("Connectors can't be granted here.".to_owned());
        };
        let mine = grants.allowed(&me.id, me.kind == super::super::MAIN);
        let missing: Vec<&str> = asked
            .iter()
            .map(String::as_str)
            .filter(|c| mine.as_ref().is_some_and(|m| !m.contains(*c)))
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "Refused: you can't give a worker connectors you can't use: {}.",
                missing.join(", ")
            ));
        }
        Ok(asked.iter().cloned().collect())
    }

    /// The plugins asked for, if the maker may use each of them.
    fn grantable_plugins(&self, me: &str, asked: &[String]) -> Result<BTreeSet<String>, String> {
        if asked.is_empty() {
            return Ok(BTreeSet::new());
        }
        let mine: Vec<String> = self
            .plugins()
            .map(|p| {
                p.for_agent(me)
                    .iter()
                    .map(|plugin| plugin.install.name.clone())
                    .collect()
            })
            .unwrap_or_default();
        let missing = tree::ungrantable(asked, |p| mine.iter().any(|m| m == p));
        if !missing.is_empty() {
            return Err(format!(
                "Refused: you can't give a worker plugins you can't use: {}.",
                missing.join(", ")
            ));
        }
        Ok(asked.iter().cloned().collect())
    }

    /// What `bot_create` answers about the worker in `conversation`.
    fn created(&self, conversation: &str) -> ToolOutput {
        let Ok(Some(agent)) = self.store.agent_for_conversation(conversation) else {
            return ToolOutput::error("The worker was made but can't be read now.");
        };
        let queued = self
            .load(conversation)
            .is_ok_and(|events| tree::queued(&events));
        let answer = json!({
            "worker": agent.id,
            "name": agent.name,
            "state": if queued { "queued" } else { "working" },
            "next": "It reports back here when it settles (done, needs the person or failed). Carry on, or wait_for {condition: {kind: worker}}. Steer it with \
                     worker_message; check it with worker_status and worker_result.",
        });
        ToolOutput::ok(answer.to_string())
    }

    /// The brief that starts worker `conversation`, as its first message: Spade's words saying
    /// who sent it, always as its maker's message (never the person's: the reviewer reads the
    /// person's words from the root of the tree, and a maker's message never resets refusals).
    pub(super) fn brief_message(&self, conversation: &str, link: &Link) -> Event {
        let mut message = Event::user_message(link.brief.clone());
        if let Event::Known(Known::UserMessage {
            context: shown,
            from_agent,
            ..
        }) = &mut message
        {
            *shown = Some(format!(
                "You are a worker of the bot {} (id {}), which made you for part of its work. \
                 It reads how you settle: draft a goal with task_goal and close plan items with \
                 evidence, since only a checked goal reports done. Ask the person only what \
                 neither you nor it can decide.",
                link.parent_name, link.parent
            ));
            *from_agent = Some(FromAgent {
                id: link.parent.clone(),
                name: link.parent_name.clone(),
                depth: u32::try_from(self.worker_ancestors(conversation).len()).unwrap_or(1),
                machine: None,
                contract: None,
            });
        }
        message
    }

    /// Whether worker `conversation` is queued: made, its brief not delivered, never stopped.
    pub(super) fn worker_queued(&self, conversation: &str) -> bool {
        self.load(conversation).is_ok_and(|events| {
            tree::queued(&events)
                && !events
                    .iter()
                    .any(|e| matches!(e, Event::Known(Known::StopRequested { .. })))
        })
    }

    /// Clears what the tree keeps of a deleted worker.
    pub(super) fn forget_worker(&self, conversation: &str) {
        if let Some(index) = self.tree_index().as_mut() {
            index.put(conversation, None);
        }
        lock(&self.workers.dirty).remove(conversation);
    }
}
