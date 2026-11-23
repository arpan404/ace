// SPDX-License-Identifier: Apache-2.0
//! Status shapes of `status.ts` and the protocol: priority 1, ported rule
//! for rule in the same order, with the malformed-tree guard (`starting`,
//! never settled). Optional fields serialize omitted, never `null`, exactly
//! like the TypeScript.
//!
//! Decoding here is lenient the way the Zod schemas are: unknown fields are
//! stripped, never fatal. (Items are the opposite: unknown fields reject the
//! fact. That lives in `validate`.)

use crate::json_io::json_equal;
use serde::{Deserialize, Serialize};

/// What the agent is doing right now while `working`.
pub fn valid_activity(value: &str) -> bool {
    matches!(
        value,
        "thinking" | "responding" | "tool" | "compacting" | "retrying" | "starting_turn"
    )
}

/// Why a non-idle agent is not making progress on its own output.
pub fn valid_blocked_on(value: &str) -> bool {
    matches!(
        value,
        "human" | "subagents" | "queue" | "background_task" | "rate_limit" | "network" | "upstream"
    )
}

/// An agent's status, exactly the protocol shape.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "state")]
pub enum AgentStatus {
    /// Nothing runs yet, or the work has not started.
    #[serde(rename = "starting")]
    Starting,
    /// Making progress on its own output.
    #[serde(rename = "working")]
    Working {
        activity: String,
        #[serde(rename = "itemId", skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// Waiting on something else.
    #[serde(rename = "blocked")]
    Blocked {
        on: String,
        #[serde(default)]
        refs: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        until: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        attempt: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        /// The pending-retry rule spreads the retry object after `refs`, so its keys come out
        /// `refs, on, attempt, until, message` (see `status.ts`'s `{ state: "blocked", refs:
        /// [], ...record.retry }`). Every other rule writes `on, refs, ...`.
        #[serde(skip)]
        retry_order: bool,
    },
    /// Its last turn finished on its own.
    #[serde(rename = "idle")]
    Idle,
    /// Stopped by the user.
    #[serde(rename = "interrupted")]
    Interrupted,
    /// Its last turn failed.
    #[serde(rename = "failed")]
    Failed { error: AgentError },
    /// Silent past the silence threshold.
    #[serde(rename = "unresponsive")]
    Unresponsive {
        #[serde(rename = "lastSignalAt")]
        last_signal_at: i64,
    },
}

impl Serialize for AgentStatus {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap as _;
        match self {
            Self::Starting => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "starting")?;
                map.end()
            }
            Self::Working {
                activity,
                item_id,
                detail,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("state", "working")?;
                map.serialize_entry("activity", activity)?;
                if let Some(item_id) = item_id {
                    map.serialize_entry("itemId", item_id)?;
                }
                if let Some(detail) = detail {
                    map.serialize_entry("detail", detail)?;
                }
                map.end()
            }
            Self::Blocked {
                on,
                refs,
                until,
                attempt,
                message,
                retry_order,
            } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("state", "blocked")?;
                let optional = |map: &mut S::SerializeMap, key: &str, text: Option<&String>| {
                    if let Some(text) = text {
                        map.serialize_entry(key, text)
                    } else {
                        Ok(())
                    }
                };
                let number = |map: &mut S::SerializeMap, key: &str, value: Option<i64>| {
                    if let Some(value) = value {
                        map.serialize_entry(key, &value)
                    } else {
                        Ok(())
                    }
                };
                if *retry_order {
                    map.serialize_entry("refs", refs)?;
                    map.serialize_entry("on", on)?;
                    number(&mut map, "attempt", *attempt)?;
                    number(&mut map, "until", *until)?;
                    optional(&mut map, "message", message.as_ref())?;
                } else {
                    map.serialize_entry("on", on)?;
                    map.serialize_entry("refs", refs)?;
                    number(&mut map, "until", *until)?;
                    number(&mut map, "attempt", *attempt)?;
                    optional(&mut map, "message", message.as_ref())?;
                }
                map.end()
            }
            Self::Idle => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "idle")?;
                map.end()
            }
            Self::Interrupted => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("state", "interrupted")?;
                map.end()
            }
            Self::Failed { error } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("state", "failed")?;
                map.serialize_entry("error", error)?;
                map.end()
            }
            Self::Unresponsive { last_signal_at } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("state", "unresponsive")?;
                map.serialize_entry("lastSignalAt", last_signal_at)?;
                map.end()
            }
        }
    }
}

/// Why an agent's turn failed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<ProviderErrorDetails>,
}

/// Structured provider error detail.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderErrorDetails {
    pub code: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Where a moved thread runs now.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MovedTo {
    #[serde(rename = "hostId")]
    pub host_id: String,
    pub name: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
}

/// A thread's status, exactly the protocol shape. A state newer than this
/// build reads `unknown` and is kept whole in `raw`, never settled.
#[derive(Debug, Clone)]
pub enum ThreadStatus {
    /// Someone's attention is needed, with the count.
    NeedsYou { interactions: i64 },
    /// At least one agent works.
    Working { agents: i64 },
    /// Held on a background task, a limit, or the queue.
    Waiting {
        on: String,
        slot_limit: Option<i64>,
        slots_in_use: Option<i64>,
        queue_position: Option<i64>,
        waiting_for: Option<String>,
    },
    /// Blocked on a usage limit.
    Limited { until: Option<i64> },
    /// Something failed after the root's last success.
    Failed,
    /// A live agent went silent.
    Unresponsive,
    /// Its work moved to another machine.
    Moved { to: MovedTo },
    /// Every agent idle, nothing pending.
    Done,
    /// Never run.
    New,
    /// A state newer than this build: kept whole, never settled.
    Unknown { raw: ace_json::Raw },
}

impl ThreadStatus {
    /// The state tag, for the malformed-tree guard and the moved check.
    pub fn state(&self) -> &str {
        match self {
            Self::NeedsYou { .. } => "needs_you",
            Self::Working { .. } => "working",
            Self::Waiting { .. } => "waiting",
            Self::Limited { .. } => "limited",
            Self::Failed => "failed",
            Self::Unresponsive => "unresponsive",
            Self::Moved { .. } => "moved",
            Self::Done => "done",
            Self::New => "new",
            Self::Unknown { .. } => "unknown",
        }
    }
}

impl AgentStatus {
    /// The state tag, mirroring the protocol.
    pub fn state(&self) -> &str {
        match self {
            Self::Starting => "starting",
            Self::Working { .. } => "working",
            Self::Blocked { .. } => "blocked",
            Self::Idle => "idle",
            Self::Interrupted => "interrupted",
            Self::Failed { .. } => "failed",
            Self::Unresponsive { .. } => "unresponsive",
        }
    }
}

/// Whether an agent status counts as finished for thread `done`.
pub fn is_settled(status: &AgentStatus) -> bool {
    matches!(
        status,
        AgentStatus::Idle | AgentStatus::Interrupted | AgentStatus::Failed { .. }
    )
}

/// JSON equality independent of object property order, like `equal`.
pub fn status_equal(left: &AgentStatus, right: &AgentStatus) -> bool {
    let left_value = crate::json_io::to_value(left);
    let right_value = crate::json_io::to_value(right);
    json_equal(&left_value, &right_value)
}

/// JSON equality for thread statuses.
pub fn thread_status_equal(left: &ThreadStatus, right: &ThreadStatus) -> bool {
    let left_value = crate::json_io::to_value(left);
    let right_value = crate::json_io::to_value(right);
    json_equal(&left_value, &right_value)
}

use crate::emit::{Event, emit, get};
use crate::indexes::{pending_interaction_keys, running_task_keys};
use crate::state::{AgentRecord, ThreadState};
use crate::status_inputs::{status_inputs, task_holds_thread};

/// Derive one agent's status for the current fact, descendants first.
pub fn derive_agent_status(state: &ThreadState, key: &str, now: i64) -> AgentStatus {
    crate::status_resolve::StatusResolver::new(state, now).resolve(key)
}

/// Whether an unresponsive agent still holds completion.
fn completion_holds(resolver: &mut crate::status_resolve::StatusResolver<'_>, key: &str) -> bool {
    resolver.holds_completion(key, 0)
}

/// Read completion evidence from an already-derived, persisted agent tree.
pub fn completion_relevance_reader(state: &ThreadState) -> impl Fn(&str) -> bool + '_ {
    let mut resolver = crate::status_resolve::StatusResolver::persisted(state, 0);
    let mut relevant: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let keys: Vec<String> = state.agents.keys().cloned().collect();
    for key in &keys {
        relevant.insert(key.clone(), resolver.holds_completion(key, 0));
    }
    move |key: &str| relevant.get(key).copied().unwrap_or(false)
}

/// Deadline eligibility from current completion relevance, memoized
/// bottom-up. A descendant's wake/silence transition is scheduled before an
/// ancestor can become newly eligible.
pub fn silence_deadline_reader(
    state: &ThreadState,
) -> impl FnMut(&str, &AgentRecord) -> Option<i64> + '_ {
    let mut resolver = crate::status_resolve::StatusResolver::persisted(state, 0);
    let mut subtree = crate::liveness::SubtreeSignalReader::new(state);
    let waiting = resolver_waiting(state);
    let has_run = state.has_run;
    let root_key = state.root_key.clone();
    let silence_ms = state.config.silence_ms;
    move |key: &str, record: &AgentRecord| {
        let phase = record.agent.status.state();
        if phase != "working" && phase != "starting" {
            return None;
        }
        if record.active_run.is_none()
            && (phase == "working"
                || (Some(key) == root_key.as_deref()
                    && !has_run
                    && record.agent.fidelity != "placeholder"))
        {
            return None;
        }
        if record.active_run.is_some() {
            let live_children = live_relevant_children(&mut resolver, &record.agent.id);
            if crate::status_inputs::suppresses_active_silence(
                &waiting,
                &record.agent.id,
                live_children,
            ) {
                return None;
            }
        }
        Some((subtree.read(key) as f64 + silence_ms).floor() as i64 + 1)
    }
}

fn resolver_waiting(state: &ThreadState) -> std::collections::HashSet<String> {
    status_inputs(state).waiting_owners
}

fn live_relevant_children(
    resolver: &mut crate::status_resolve::StatusResolver<'_>,
    agent_id: &str,
) -> usize {
    resolver.live_children_count(agent_id)
}

/// A thread whose work moved to another machine reads `moved` once nothing
/// runs here; work that still runs here always shows as it is.
pub fn derive_thread_status(state: &ThreadState) -> ThreadStatus {
    let status = live_thread_status(state);
    // Messages queued here stay held: nothing will send them on this machine.
    let held = matches!(&status, ThreadStatus::Waiting { on, .. } if on == "queue");
    if state.moved_to.is_some()
        && (held
            || matches!(
                status,
                ThreadStatus::Done | ThreadStatus::New | ThreadStatus::Failed
            ))
        && let Some(to) = state.moved_to.clone()
    {
        return ThreadStatus::Moved { to };
    }
    status
}

fn live_thread_status(state: &ThreadState) -> ThreadStatus {
    let records: Vec<&AgentRecord> = state.agents.values().collect();
    let by_id: std::collections::HashMap<&str, &AgentStatus> = records
        .iter()
        .map(|record| (record.agent.id.as_str(), &record.agent.status))
        .collect();
    let pending: Vec<&crate::entity_model::Interaction> = pending_interaction_keys(state, None)
        .iter()
        .filter_map(|key| get(&state.interactions, key))
        .collect();
    let actionable = pending
        .iter()
        .filter(|interaction| {
            crate::human::is_actionable_interaction(
                &interaction.state,
                interaction.blocking,
                by_id
                    .get(interaction.agent_id.as_str())
                    .map(|status| status.state()),
            )
        })
        .count();
    let external_human: usize = records
        .iter()
        .filter_map(|record| record.external_status.as_ref())
        .filter_map(|status| match status {
            ThreadStatus::NeedsYou { interactions } => Some(*interactions as usize),
            _ => None,
        })
        .sum();
    let waiting_on = state.person_tasks.as_ref();
    let held_human = waiting_on
        .map(|waiting| {
            running_task_keys(state, None)
                .iter()
                .filter(|key| waiting.contains_key(*key))
                .count()
        })
        .unwrap_or(0);
    let human = actionable + external_human + held_human;
    if human > 0 {
        return ThreadStatus::NeedsYou {
            interactions: human as i64,
        };
    }
    let root_id = state
        .root_key
        .as_ref()
        .and_then(|key| get(&state.agents, key))
        .map(|record| record.agent.id.clone());
    let working = records
        .iter()
        .filter(|record| {
            let status = &record.agent.status;
            (status.state() == "starting"
                && (state.has_run
                    || Some(&record.agent.id) != root_id.as_ref()))
                || status.state() == "working"
                || matches!(status, AgentStatus::Blocked { on, refs, .. } if on == "subagents" && refs.is_empty())
        })
        .count();
    if working > 0 {
        return ThreadStatus::Working {
            agents: working as i64,
        };
    }
    for reason in ["rate_limit", "network", "upstream"] {
        if records.iter().any(|record| {
            matches!(&record.agent.status, AgentStatus::Blocked { on, .. } if on == reason)
        }) {
            if reason == "rate_limit" {
                let limits: Vec<Option<i64>> = records
                    .iter()
                    .filter_map(|record| match &record.agent.status {
                        AgentStatus::Blocked { on, until, .. } if on == "rate_limit" => Some(*until),
                        _ => None,
                    })
                    .collect();
                if limits.iter().all(|limit| limit.is_some()) {
                    let until = limits
                        .iter()
                        .filter_map(|limit| *limit)
                        .max();
                    return ThreadStatus::Limited { until };
                }
                return ThreadStatus::Limited { until: None };
            }
            return ThreadStatus::Waiting {
                on: reason.to_owned(),
                slot_limit: None,
                slots_in_use: None,
                queue_position: None,
                waiting_for: None,
            };
        }
    }
    if running_task_keys(state, None)
        .iter()
        .any(|key| get(&state.tasks, key).is_some_and(|task| task_holds_thread(state, task)))
    {
        return ThreadStatus::Waiting {
            on: "background_task".to_owned(),
            slot_limit: None,
            slots_in_use: None,
            queue_position: None,
            waiting_for: None,
        };
    }
    if records.iter().any(|record| {
        (record.disconnected_at.is_some()
            || matches!(&record.external_status, Some(ThreadStatus::Unresponsive)))
            && record.agent.status.state() == "unresponsive"
    }) {
        return ThreadStatus::Unresponsive;
    }
    if records.iter().any(|record| {
        matches!(&record.agent.status, AgentStatus::Blocked { on, .. } if on == "background_task" || on == "subagents")
    }) {
        return ThreadStatus::Waiting {
            on: "background_task".to_owned(),
            slot_limit: None,
            slots_in_use: None,
            queue_position: None,
            waiting_for: None,
        };
    }
    // A send or session start that failed keeps its input, held, for the
    // person's Try again, Edit or Remove: the thread reads as failed.
    if state.queue_held == Some(true) && state.queue_sources.provider == 0 {
        return ThreadStatus::Failed;
    }
    // Input a Stop kept for the person's Resume sends nothing by itself.
    let resting_queue = state.queue_stopped == Some(true) && state.queue_sources.provider == 0;
    if (state.queue_count > 0 && !resting_queue)
        || records.iter().any(|record| {
            matches!(&record.external_status, Some(ThreadStatus::Waiting { on, .. }) if on == "queue")
        })
    {
        return ThreadStatus::Waiting {
            on: "queue".to_owned(),
            slot_limit: None,
            slots_in_use: None,
            queue_position: None,
            waiting_for: None,
        };
    }
    let reader = completion_relevance_reader(state);
    if state.agents.keys().any(|key| {
        get(&state.agents, key)
            .is_some_and(|record| record.agent.status.state() == "unresponsive" && reader(key))
    }) {
        return ThreadStatus::Unresponsive;
    }
    let root = state
        .root_key
        .as_ref()
        .and_then(|key| get(&state.agents, key));
    let success_order = root
        .and_then(|record| record.last_successful_outcome_order)
        .unwrap_or(0);
    if root.is_some_and(|record| record.agent.status.state() == "failed")
        || records.iter().any(|record| {
            record.agent.status.state() == "failed"
                && record.last_outcome_order.unwrap_or(0) > success_order
        })
    {
        return ThreadStatus::Failed;
    }
    if !state.has_run {
        return match &state.process_exit {
            None => ThreadStatus::New,
            Some(exit) if exit.deliberate => ThreadStatus::Done,
            Some(_) => ThreadStatus::Failed,
        };
    }
    ThreadStatus::Done
}

/// Recompute every agent status and the thread status, emitting changes.
pub fn recompute_statuses(state: &mut ThreadState, now: i64, events: &mut Vec<Event>) {
    state.status_observed_at = Some(now);
    state.appended("statusObservedAt");
    let mut resolver = crate::status_resolve::StatusResolver::new(state, now);
    let keys: Vec<String> = state.agents.keys().cloned().collect();
    let mut derived: Vec<(String, AgentStatus, bool)> = Vec::new();
    for key in &keys {
        let status = resolver.resolve(key);
        let relevant = resolver.holds_completion(key, 0);
        derived.push((key.clone(), status, relevant));
    }
    drop(resolver);
    for (key, status, relevant) in derived {
        let changed = get(&state.agents, &key).is_some_and(|record| {
            !status_equal(&record.agent.status, &status)
                || record.completion_relevant != Some(relevant)
        });
        if !changed {
            continue;
        }
        let settled_before = get(&state.agents, &key)
            .map(|record| is_settled(&record.agent.status))
            .unwrap_or(true);
        let settled_after = is_settled(&status);
        if settled_before && !settled_after {
            crate::tree::announce_agent_branch(state, &key, events);
        }
        if let Some(record) = state.agents.get_mut(&key) {
            record.agent.status = status.clone();
            record.completion_relevant = Some(relevant);
        }
        if let Some(record) = get(&state.agents, &key) {
            let id = record.agent.id.clone();
            emit(
                events,
                Event::AgentStatus {
                    agent_id: id,
                    status,
                    completion_relevant: relevant,
                },
            );
        }
    }
    let status = derive_thread_status(state);
    if !thread_status_equal(&state.status, &status) {
        state.status = status.clone();
        emit(events, Event::ThreadUpdated { status });
    }
}
