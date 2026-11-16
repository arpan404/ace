//! Episodes and the topic index (ADR 0164): when a goal closes its episode is stored, once;
//! before a model call the topic index of the bases a bot reads is stored for the cached top,
//! at the points the top may change.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::event::{Event, Known};
use spade_core::knowledge::episode::{self, Episode};
use spade_core::knowledge::{self, Kind, TopicLine, Trust};
use spade_core::memory;
use spade_store::{NewEpisode, StoreError, StoredEpisode};

use super::Engine;
use super::knowledge::{Base, KnowledgeError, Role, escaped};
use crate::tools::ToolOutput;

/// The most episodes a search returns.
const FOUND: usize = 5;

/// An episode as the API shows it.
pub fn episode_json(stored: &StoredEpisode) -> Value {
    let body: Value = serde_json::from_str(&stored.body).unwrap_or(Value::Null);
    json!({
        "id": stored.id,
        "agent": stored.agent,
        "conversation": stored.conversation,
        "goal": stored.goal,
        "title": stored.title,
        "outcome": stored.outcome,
        "untrusted": stored.untrusted,
        "cost_micros": stored.cost_micros,
        "started_at": stored.started_ms,
        "closed_at": stored.closed_ms,
        "duration_ms": stored.closed_ms - stored.started_ms,
        "episode": body,
    })
}

/// Stores the topic index for the cached top when one may be stored (before the first model
/// call, and once after each compaction) and there is something to show. Returns whether it
/// stored one.
pub(super) fn index_if_due(engine: &Arc<Engine>, id: &str, events: &[Event]) -> bool {
    if !knowledge::index_due(events) {
        return false;
    }
    let text = match engine.topic_index(id, events) {
        Ok(text) => text,
        Err(error) => {
            // Without it the prompt goes on; the next compaction indexes again.
            tracing::warn!(%error, "no knowledge index for this conversation");
            return false;
        }
    };
    if text.is_empty() {
        return false;
    }
    match engine.record(id, &Event::Known(Known::KnowledgeIndexed { text })) {
        Ok(_) => true,
        Err(error) => {
            tracing::error!(%error, "could not store the knowledge index");
            false
        }
    }
}

impl Engine {
    /// The topic index for `id`: the topics of the bases its bot reads, those whose words match
    /// its task and open goal first.
    fn topic_index(&self, id: &str, events: &[Event]) -> Result<String, StoreError> {
        let Some(agent) = self.store.agent_for_conversation(id)? else {
            return Ok(String::new());
        };
        let mut wanted = String::new();
        if let Some(task) = spade_core::context::task_for_turn(events) {
            wanted.push_str(task);
        }
        if let Some(task) = spade_core::goal::Task::fold(events).filter(|t| t.goal.closed.is_none())
        {
            wanted.push_str(&format!(" {} {}", task.goal.title, task.goal.text));
        }
        let words = memory::words(&wanted);
        let mut topics: BTreeMap<String, TopicLine> = BTreeMap::new();
        for base in self.bases(&agent, false) {
            let mut entries = self.store.knowledge(&base.agent, None)?;
            entries.sort_by(|a, b| b.uses.cmp(&a.uses).then(b.updated_ms.cmp(&a.updated_ms)));
            for entry in entries {
                let line = topics
                    .entry(entry.topic.clone())
                    .or_insert_with(|| TopicLine {
                        topic: entry.topic.clone(),
                        entries: 0,
                        untrusted: 0,
                        titles: Vec::new(),
                        relevance: 0.0,
                        latest_ms: 0,
                    });
                line.entries += 1;
                line.latest_ms = line
                    .latest_ms
                    .max(entry.updated_ms)
                    .max(entry.used_ms.unwrap_or(0));
                if entry.trust == Trust::Untrusted {
                    line.untrusted += 1;
                } else {
                    let said = memory::words(&format!("{} {}", entry.topic, entry.title));
                    line.relevance += words.iter().filter(|w| said.contains(w)).count() as f64;
                    line.titles.push(entry.title);
                }
            }
        }
        // A topic only an untrusted entry has was named by text a stranger may have written:
        // it never reaches the standing instructions, nor do untrusted entries' titles.
        let lines: Vec<TopicLine> = topics
            .into_values()
            .filter(|line| line.entries > line.untrusted)
            .collect();
        let episodes = self.store.count_episodes(&self.episode_bases(&agent))?;
        Ok(knowledge::index(&lines, episodes))
    }

    /// The bots whose episodes `agent` searches: its whole tree, makers and workers.
    fn episode_bases(&self, agent: &spade_store::Agent) -> Vec<String> {
        self.bases(agent, true)
            .into_iter()
            .map(|b| b.agent)
            .collect()
    }

    /// [`Engine::remember_episodes`] once per conversation after Spade starts: a goal that
    /// closed just before a stop gets its episode. Closes while Spade runs store theirs at once.
    pub(super) fn episodes_once(&self, id: &str) -> bool {
        let first = self
            .episodes_checked
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_owned());
        first && self.remember_episodes(id)
    }

    /// Stores an episode for each goal of `id` that closed without one, then `episode_stored`.
    /// Safe to call at any time and more than once: a goal keeps one episode. Returns whether it
    /// stored anything.
    pub(super) fn remember_episodes(&self, id: &str) -> bool {
        match self.store_episodes(id) {
            Ok(stored) => stored,
            Err(error) => {
                tracing::warn!(%error, "could not store a task's episode; tried again later");
                false
            }
        }
    }

    fn store_episodes(&self, id: &str) -> Result<bool, StoreError> {
        if self.helper_of(id).is_some() {
            return Ok(false);
        }
        let (events, stamps) = self.load_stamped(id)?;
        let due = episode::due(&events, &self.registry_for(id));
        if due.is_empty() {
            return Ok(false);
        }
        let Some(agent) = self.store.agent_for_conversation(id)? else {
            return Ok(false);
        };
        let mut stored = false;
        for found in due {
            let at = |index: usize| stamps.get(index).copied().unwrap_or((0, 0));
            let (started_ms, closed_ms) = (at(found.started).1, at(found.closed).1);
            let body = self.episode_body(&agent.id, &found, &|i| at(i).0, started_ms, closed_ms)?;
            let cost = self.store.spent_between(id, started_ms, closed_ms)?;
            let episode_id = self.ids.next("e");
            let (kept, _) = self.store.save_episode(NewEpisode {
                id: &episode_id,
                agent: &agent.id,
                conversation: id,
                goal: &found.goal,
                title: &found.title,
                outcome: found.outcome.name(),
                body: &body.to_string(),
                text: &episode::text(&found),
                untrusted: found.untrusted,
                cost_micros: cost,
                started_ms,
                closed_ms,
            })?;
            let _order = self.record_lock.lock().unwrap_or_else(|p| p.into_inner());
            let again = self.load(id)?;
            let marked = again.iter().any(|e| {
                matches!(e, Event::Known(Known::EpisodeStored { goal, .. }) if *goal == found.goal)
            });
            if !marked {
                self.append(
                    id,
                    &Event::Known(Known::EpisodeStored {
                        goal: found.goal.clone(),
                        episode: kept.id,
                    }),
                )?;
                stored = true;
            }
        }
        Ok(stored)
    }

    /// The episode as stored: the fold, with each evidence call's position, and the bot's
    /// decisions written during the goal.
    fn episode_body(
        &self,
        agent: &str,
        found: &Episode,
        seq: &dyn Fn(usize) -> i64,
        started_ms: i64,
        closed_ms: i64,
    ) -> Result<Value, StoreError> {
        let decisions: Vec<Value> = self
            .store
            .knowledge(agent, None)?
            .into_iter()
            .filter(|e| e.kind == Kind::Decision && e.author.as_deref() == Some(agent))
            .filter(|e| e.created_ms >= started_ms && e.created_ms <= closed_ms)
            .map(|e| json!({ "id": e.id, "title": e.title }))
            .collect();
        let evidence: Vec<Value> = found
            .evidence
            .iter()
            .map(|link| {
                let mut piece = serde_json::to_value(&link.evidence).unwrap_or(Value::Null);
                piece["item"] = json!(link.item);
                if let Some(at) = link.at {
                    piece["position"] = json!(seq(at));
                }
                piece
            })
            .collect();
        Ok(json!({
            "goal": found.goal,
            "title": found.title,
            "text": found.text,
            "outcome": found.outcome.name(),
            "criteria": found.criteria,
            "worked": found.worked,
            "failed": found.failed,
            "missing": found.missing,
            "decisions": decisions,
            "evidence": evidence,
            "note": found.note,
            "untrusted": found.untrusted,
        }))
    }

    /// `episode_search`: past episodes of the bot's tree, like the task at hand.
    pub(super) fn episode_search(
        &self,
        agent: &spade_store::Agent,
        arguments: &Value,
    ) -> Result<ToolOutput, KnowledgeError> {
        let bases = self.bases(agent, true);
        let agents: Vec<String> = bases.iter().map(|b| b.agent.clone()).collect();
        let query = arguments
            .get("query")
            .and_then(Value::as_str)
            .and_then(memory::match_query);
        let found = self.store.episodes(&agents, query.as_deref(), FOUND)?;
        if found.is_empty() {
            return Ok(ToolOutput::ok("No past episodes matched."));
        }
        Ok(shown(&found, &bases))
    }
}

/// Episodes as a tool result; an untrusted one, or a worker's, quoted as data.
fn shown(found: &[StoredEpisode], bases: &[Base]) -> ToolOutput {
    let mut out = String::new();
    let mut untrusted = false;
    for stored in found {
        let base = bases.iter().find(|b| b.agent == stored.agent);
        let whose = match base.map(|b| b.role) {
            Some(Role::Own) | None => "yours".to_owned(),
            Some(Role::Maker) => format!("{}'s, your maker", base.map_or("", |b| &b.name)),
            Some(Role::Worker) => format!("{}'s, your worker", base.map_or("", |b| &b.name)),
        };
        let body: Value = serde_json::from_str(&stored.body).unwrap_or(Value::Null);
        let lines = |key: &str| -> Vec<String> {
            body.get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|l| {
                    let item = l.get("item").and_then(Value::as_str).unwrap_or("");
                    let text = l.get("text").and_then(Value::as_str).unwrap_or("");
                    match l.get("why").and_then(Value::as_str) {
                        Some(why) => format!("{item} {text} ({why})"),
                        None => format!("{item} {text}"),
                    }
                })
                .collect()
        };
        let mut text = format!(
            "[{}] {} · {} · {whose} · {} to {} · {} min · ${:.2}",
            stored.id,
            escaped(&stored.title),
            stored.outcome,
            knowledge::day(stored.started_ms),
            knowledge::day(stored.closed_ms),
            (stored.closed_ms - stored.started_ms).max(0) / 60_000,
            stored.cost_micros as f64 / 1_000_000.0
        );
        for (label, key) in [("Worked", "worked"), ("Failed", "failed")] {
            for line in lines(key) {
                text.push_str(&format!("\n{label}: {}", escaped(&line)));
            }
        }
        for missing in body
            .get("missing")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            text.push_str(&format!(
                "\nMissing: {}",
                escaped(missing.as_str().unwrap_or(""))
            ));
        }
        for decision in body
            .get("decisions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = decision.get("id").and_then(Value::as_str).unwrap_or("");
            let title = decision.get("title").and_then(Value::as_str).unwrap_or("");
            text.push_str(&format!("\nDecided: [{id}] {}", escaped(title)));
        }
        if let Some(note) = body.get("note").and_then(Value::as_str) {
            text.push_str(&format!("\nIts own last note: {}", escaped(note)));
        }
        if stored.untrusted || base.is_some_and(|b| b.role == Role::Worker) {
            untrusted = true;
            out.push_str(&format!(
                "<untrusted episode=\"{}\">\n{text}\n</untrusted>\n\n",
                stored.id
            ));
        } else {
            out.push_str(&format!("{text}\n\n"));
        }
    }
    let output = ToolOutput::ok(out.trim_end().to_owned());
    if untrusted {
        output.untrusted()
    } else {
        output
    }
}
