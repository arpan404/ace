// SPDX-License-Identifier: Apache-2.0
//! The event helpers of `emit.ts` and the events the fold emits. Events are
//! snapshots: every emission owns its value, even when the reducer later
//! mutates the stored state. Map access goes through `get`/`put` so native
//! keys keep working even when they are JavaScript prototype property names
//! like `__proto__`. Optional event fields are omitted, never `null`.

use serde::{Deserialize, Serialize};

use crate::entity_model::{BackgroundTask, Interaction, InteractionResolution};
use crate::item_meta::Vetted;
use crate::items::Item;
use crate::runs::Run;
use crate::state::Agent;
use crate::status::{AgentStatus, ThreadStatus};

/// Push a snapshot of the event: later state mutation must not rewrite it.
pub fn emit(events: &mut Vec<Event>, payload: Event) {
    events.push(payload);
}

/// Read a native-keyed record, like `Object.hasOwn`.
pub fn get<'a, V>(records: &'a indexmap::IndexMap<String, V>, key: &str) -> Option<&'a V> {
    records.get(key)
}

/// Write a native-keyed record, keeping insertion order.
pub fn put<V>(records: &mut indexmap::IndexMap<String, V>, key: String, value: V) {
    records.insert(key, value);
}

/// Remove a native-keyed record, like `delete`.
pub fn remove<V>(records: &mut indexmap::IndexMap<String, V>, key: &str) -> Option<V> {
    records.shift_remove(key)
}

/// One event the fold emits, exactly the protocol JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Event {
    /// A new agent joined the tree.
    #[serde(rename = "agent.created")]
    AgentCreated {
        agent: Agent,
    },
    /// An agent's derived status changed.
    #[serde(rename = "agent.status")]
    AgentStatus {
        #[serde(rename = "agentId")]
        agent_id: String,
        status: AgentStatus,
        #[serde(rename = "completionRelevant")]
        completion_relevant: bool,
    },
    /// Changed agent fields after creation.
    #[serde(rename = "agent.updated")]
    AgentUpdated {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "childThreadId", skip_serializing_if = "Option::is_none")]
        child_thread_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        machine: Option<crate::item_meta::AgentMachine>,
        #[serde(rename = "parentId", skip_serializing_if = "Option::is_none")]
        parent_id: Option<Option<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lineage: Option<crate::item_meta::ThreadLineage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fidelity: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        native: Option<crate::item_model::NativeRef>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
        spawned_by: Option<Option<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        background: Option<bool>,
        #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
        ended_at: Option<i64>,
    },
    /// Durable admission is distinct from execution and completion.
    #[serde(rename = "input.admitted")]
    InputAdmitted {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "nativeInputId")]
        native_input_id: String,
        #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
    },
    /// A new turn started.
    #[serde(rename = "run.started")]
    RunStarted {
        run: Run,
    },
    /// A turn ended, with its outcome.
    #[serde(rename = "run.ended")]
    RunEnded {
        #[serde(rename = "runId")]
        run_id: String,
        state: String,
        #[serde(rename = "endedBy", skip_serializing_if = "Option::is_none")]
        ended_by: Option<String>,
        #[serde(rename = "endedAt")]
        ended_at: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
    },
    /// A new transcript item.
    #[serde(rename = "item.created")]
    ItemCreated {
        item: Item,
    },
    /// A transcript item changed; the payload is authoritative.
    #[serde(rename = "item.updated")]
    ItemUpdated {
        item: Item,
    },
    /// A streaming append; the next `item.updated` is authoritative.
    #[serde(rename = "item.delta")]
    ItemDelta {
        #[serde(rename = "itemId")]
        item_id: String,
        #[serde(rename = "agentId")]
        agent_id: String,
        field: String,
        append: String,
    },
    /// A new interaction opened.
    #[serde(rename = "interaction.opened")]
    InteractionOpened {
        interaction: Interaction,
    },
    /// An interaction closed.
    #[serde(rename = "interaction.closed")]
    InteractionClosed {
        #[serde(rename = "interactionId")]
        interaction_id: String,
        state: String,
        #[serde(rename = "closedAt")]
        closed_at: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        resolution: Option<InteractionResolution>,
        #[serde(rename = "resolvedBy", skip_serializing_if = "Option::is_none")]
        resolved_by: Option<String>,
        #[serde(rename = "autoReviewed", skip_serializing_if = "Option::is_none")]
        auto_reviewed: Option<bool>,
    },
    /// A background task started.
    #[serde(rename = "background_task.started")]
    BackgroundTaskStarted {
        task: BackgroundTask,
    },
    /// A background task changed state.
    #[serde(rename = "background_task.updated")]
    BackgroundTaskUpdated {
        #[serde(rename = "taskId")]
        task_id: String,
        status: String,
        #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
        ended_at: Option<i64>,
    },
    /// The provider reported usage.
    #[serde(rename = "usage.updated")]
    UsageUpdated {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "inputTokens")]
        input_tokens: i64,
        #[serde(rename = "outputTokens")]
        output_tokens: i64,
        #[serde(rename = "cachedInputTokens", skip_serializing_if = "Option::is_none")]
        cached_input_tokens: Option<i64>,
        #[serde(rename = "contextWindow", skip_serializing_if = "Option::is_none")]
        context_window: Option<i64>,
        #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(rename = "contextTokens", skip_serializing_if = "Option::is_none")]
        context_tokens: Option<i64>,
        #[serde(rename = "contextSessionId", skip_serializing_if = "Option::is_none")]
        context_session_id: Option<String>,
        #[serde(rename = "reasoningTokens", skip_serializing_if = "Option::is_none")]
        reasoning_tokens: Option<i64>,
        #[serde(rename = "cacheWriteTokens", skip_serializing_if = "Option::is_none")]
        cache_write_tokens: Option<i64>,
        #[serde(rename = "cacheWrite1hTokens", skip_serializing_if = "Option::is_none")]
        cache_write_1h_tokens: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(rename = "accountId", skip_serializing_if = "Option::is_none")]
        account_id: Option<String>,
        #[serde(rename = "billingMode", skip_serializing_if = "Option::is_none")]
        billing_mode: Option<String>,
        #[serde(rename = "counterMode", skip_serializing_if = "Option::is_none")]
        counter_mode: Option<String>,
        #[serde(rename = "counterKey", skip_serializing_if = "Option::is_none")]
        counter_key: Option<String>,
        #[serde(rename = "usageScope", skip_serializing_if = "Option::is_none")]
        usage_scope: Option<String>,
    },
    /// The provider sampled context usage.
    #[serde(rename = "context.sampled")]
    ContextSampled {
        #[serde(rename = "agentId")]
        agent_id: String,
        #[serde(rename = "usedTokens")]
        used_tokens: i64,
        #[serde(rename = "windowTokens", skip_serializing_if = "Option::is_none")]
        window_tokens: Option<i64>,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// The thread's derived status changed.
    #[serde(rename = "thread.updated")]
    ThreadUpdated {
        status: ThreadStatus,
    },
}
