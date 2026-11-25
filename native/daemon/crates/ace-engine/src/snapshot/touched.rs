// SPDX-License-Identifier: Apache-2.0
//! The keys a batch touched, for a snapshot's adopt step (E5.3). The TypeScript's record
//! proxies see every read and write inside the fold; Rust marks the keys the batch's facts and
//! emitted events name, which is the same change set for a provider frame.

use ace_core::emit::Event;
use ace_core::facts::Fact;
use ace_json::Value;
use std::collections::HashSet;

/// The record keys one fold may have changed, by section.
#[derive(Debug, Default)]
pub struct Touched {
    pub agents: HashSet<String>,
    pub items: HashSet<String>,
    pub runs: HashSet<String>,
    pub interactions: HashSet<String>,
    pub tasks: HashSet<String>,
}

impl Touched {
    /// The keys a batch's JSON facts and emitted payloads name, which is the change set a fold
    /// can have made. Unlike the typed form this also runs in the frame, where facts are JSON.
    pub fn values(facts: &[Value], events: &[Value]) -> Touched {
        let mut touched = Touched::default();
        let text =
            |value: &Value, key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        for fact in facts {
            let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
            match kind {
                "item.upsert" | "item.reconciled" | "item.delta" => {
                    if let Some(item) = text(fact, "item") {
                        touched.items.insert(item);
                    }
                }
                "interaction.opened" | "interaction.closed" => {
                    if let Some(interaction) = text(fact, "interaction") {
                        touched.interactions.insert(interaction);
                    }
                }
                "background.started"
                | "background.listening"
                | "background.waiting"
                | "background.ended" => {
                    if let Some(task) = text(fact, "task") {
                        touched.tasks.insert(task);
                    }
                }
                _ => {}
            }
        }
        for event in events {
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match kind {
                "agent.created" => {
                    if let Some(agent) = event
                        .get("agent")
                        .and_then(|agent| agent.get("id"))
                        .and_then(Value::as_str)
                    {
                        touched.agents.insert(agent.to_owned());
                    }
                }
                "agent.updated" | "agent.status" => {
                    if let Some(agent) = text(event, "agentId") {
                        touched.agents.insert(agent);
                    }
                }
                "item.created" | "item.updated" => {
                    if let Some(item) = event
                        .get("item")
                        .and_then(|item| item.get("id"))
                        .and_then(Value::as_str)
                    {
                        touched.items.insert(item.to_owned());
                    }
                }
                "item.delta" => {
                    if let Some(item) = text(event, "itemId") {
                        touched.items.insert(item);
                    }
                }
                "run.started" => {
                    if let Some(run) = event
                        .get("run")
                        .and_then(|run| run.get("id"))
                        .and_then(Value::as_str)
                    {
                        touched.runs.insert(run.to_owned());
                    }
                }
                "run.ended" => {
                    if let Some(run) = text(event, "runId") {
                        touched.runs.insert(run);
                    }
                }
                "interaction.opened" => {
                    if let Some(interaction) = event
                        .get("interaction")
                        .and_then(|interaction| interaction.get("id"))
                        .and_then(Value::as_str)
                    {
                        touched.interactions.insert(interaction.to_owned());
                    }
                }
                "interaction.closed" => {
                    if let Some(interaction) = text(event, "interactionId") {
                        touched.interactions.insert(interaction);
                    }
                }
                "background_task.started" => {
                    if let Some(task) = event
                        .get("task")
                        .and_then(|task| task.get("id"))
                        .and_then(Value::as_str)
                    {
                        touched.tasks.insert(task.to_owned());
                    }
                }
                "background_task.updated" => {
                    if let Some(task) = text(event, "taskId") {
                        touched.tasks.insert(task);
                    }
                }
                _ => {}
            }
        }
        touched
    }

    /// Mark the keys the facts name (`item.delta`'s item, an interaction, a task).
    pub fn facts(&mut self, facts: &[Fact]) {
        for fact in facts {
            match fact {
                Fact::ItemUpsert { item, .. }
                | Fact::ItemReconciled { item, .. }
                | Fact::ItemDelta { item, .. } => {
                    self.items.insert(item.clone());
                }
                Fact::InteractionOpened { interaction, .. } => {
                    self.interactions.insert(interaction.clone());
                }
                Fact::InteractionClosed { interaction, .. } => {
                    self.interactions.insert(interaction.clone());
                }
                Fact::BackgroundStarted { task, .. }
                | Fact::BackgroundEnded { task, .. }
                | Fact::BackgroundListening { task, .. }
                | Fact::BackgroundWaiting { task, .. } => {
                    self.tasks.insert(task.clone());
                }
                _ => {}
            }
        }
    }

    /// Mark the keys the emitted events name: a record the fold created or changed.
    pub fn events(&mut self, events: &[Event]) {
        for event in events {
            match event {
                Event::AgentCreated { agent } => {
                    self.agents.insert(agent.id.clone());
                }
                Event::AgentUpdated { agent_id, .. } => {
                    self.agents.insert(agent_id.clone());
                }
                Event::ItemCreated { item } | Event::ItemUpdated { item } => {
                    self.items.insert(item.id().to_owned());
                }
                Event::ItemDelta { item_id, .. } => {
                    self.items.insert(item_id.clone());
                }
                Event::RunStarted { run } => {
                    self.runs.insert(run.id.clone());
                }
                Event::RunEnded { run_id, .. } => {
                    self.runs.insert(run_id.clone());
                }
                Event::InteractionOpened { interaction } => {
                    self.interactions.insert(interaction.id.clone());
                }
                Event::InteractionClosed { interaction_id, .. } => {
                    self.interactions.insert(interaction_id.clone());
                }
                Event::BackgroundTaskStarted { task } => {
                    self.tasks.insert(task.id.clone());
                }
                Event::BackgroundTaskUpdated { task_id, .. } => {
                    self.tasks.insert(task_id.clone());
                }
                _ => {}
            }
        }
    }
}
