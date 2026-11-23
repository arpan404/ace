// SPDX-License-Identifier: Apache-2.0
//! The adapter facts of `facts.ts` as a serde enum tagged by `type`.
//! Translators emit facts; only core allocates ace ids. Unknown fact types
//! are kept as raw and never fatal: validation turns them into rejection
//! notices, and the fold goes on.

use serde::{Deserialize, Serialize};

use crate::json_io::Maybe;

use crate::entity_model::{InteractionRequest, InteractionResolution};
use crate::item_meta::AgentMachine;
use crate::item_meta::ThreadLineage;
use crate::item_model::{NativeRef, RawPayload};
use crate::status::{AgentError, ThreadStatus};

/// Adapter-owned identity, unique within an entity kind and provider process.
pub type Key = String;

/// A translator-built fact as untyped JSON: the `type` tag names the fold,
/// and the body crosses verbatim. Translators build these; only the core
/// allocates ace ids. Write-only: bindings splice `data` verbatim, never
/// through serde.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RawFact {
    /// The fact's `type` tag, which the core's `Fact` enum matches on.
    pub fact_type: String,
    /// The fact's body as canonical JSON, kept whole.
    pub data: ace_json::Raw,
}

/// What a translator says a frame means, in adapter-owned native keys.
/// Drafts stay transient `Map`s: they are validated and merged within the
/// same apply call, never stored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Fact {
    /// Durable provider admission transfers queue ownership.
    #[serde(rename = "agent.external")]
    AgentExternal {
        agent: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        status: ThreadStatus,
    },
    /// An agent the provider reports.
    #[serde(rename = "agent.seen")]
    AgentSeen {
        agent: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
        spawned_by: Option<String>,
        origin: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        lineage: Option<ThreadLineage>,
        fidelity: String,
        native: NativeRef,
        cwd: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        role: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        background: Option<bool>,
        /// A delegated child on another paired machine: where it runs.
        #[serde(skip_serializing_if = "Option::is_none")]
        machine: Option<AgentMachine>,
    },
    /// A late or partial link for an already-known agent.
    #[serde(rename = "agent.linked")]
    AgentLinked {
        agent: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
        #[serde(rename = "spawnedBy", skip_serializing_if = "Option::is_none")]
        spawned_by: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        background: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// Durable provider admission of the engine's input.
    #[serde(rename = "input.admitted")]
    InputAdmitted {
        agent: String,
        #[serde(rename = "nativeInputId")]
        native_input_id: String,
        #[serde(rename = "commandId", skip_serializing_if = "Option::is_none")]
        command_id: Option<String>,
    },
    /// The provider took inputs into the agent's turn.
    #[serde(rename = "input.consumed")]
    InputConsumed {
        agent: String,
        #[serde(rename = "nativeInputIds")]
        native_input_ids: Vec<String>,
    },
    /// An agent's turn started.
    #[serde(rename = "turn.started")]
    TurnStarted {
        agent: String,
        #[serde(rename = "nativeTurnId", skip_serializing_if = "Option::is_none")]
        native_turn_id: Option<String>,
        trigger: String,
        #[serde(
            rename = "permissionMode",
            default,
            deserialize_with = "Maybe::<String>::deserialize",
            serialize_with = "Maybe::<String>::serialize",
            skip_serializing_if = "Maybe::<String>::is_missing"
        )]
        permission_mode: Maybe<String>,
    },
    /// An agent's turn ended.
    #[serde(rename = "turn.ended")]
    TurnEnded {
        agent: String,
        #[serde(rename = "nativeTurnId", skip_serializing_if = "Option::is_none")]
        native_turn_id: Option<String>,
        outcome: String,
        /// The engine interrupted this turn so the person's steer reached it.
        #[serde(rename = "endedBy", skip_serializing_if = "Option::is_none")]
        ended_by: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        trigger: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<AgentError>,
        /// Historical settlement records outcomes without current policy.
        #[serde(skip_serializing_if = "Option::is_none")]
        historical: Option<bool>,
    },
    /// A live native wait tool blocks on targets.
    #[serde(rename = "subagents.waiting")]
    SubagentsWaiting {
        agent: String,
        item: String,
        targets: Vec<String>,
    },
    /// What the agent is doing right now.
    #[serde(rename = "activity")]
    Activity {
        agent: String,
        activity: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// A transcript item upsert; partial upserts merge.
    #[serde(rename = "item.upsert")]
    ItemUpsert {
        agent: String,
        item: String,
        #[serde(skip)]
        draft: crate::json_io::Map,
    },
    /// Idempotent snapshot reconciliation.
    #[serde(rename = "item.reconciled")]
    ItemReconciled {
        agent: String,
        item: String,
        #[serde(skip)]
        draft: crate::json_io::Map,
    },
    /// A streaming append to a transcript item.
    #[serde(rename = "item.delta")]
    ItemDelta {
        agent: String,
        item: String,
        field: String,
        append: ace_json::JsString,
    },
    /// An interaction opened.
    #[serde(rename = "interaction.opened")]
    InteractionOpened {
        agent: String,
        interaction: String,
        blocking: bool,
        request: InteractionRequest,
        #[serde(skip_serializing_if = "Option::is_none")]
        item: Option<String>,
        /// Kept out of typed decoding: opaque provider data may be nested arbitrarily deep.
        #[serde(skip)]
        raw: Option<Vec<RawPayload>>,
    },
    /// An interaction closed.
    #[serde(rename = "interaction.closed")]
    InteractionClosed {
        interaction: String,
        state: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        resolution: Option<InteractionResolution>,
        #[serde(rename = "resolvedBy", skip_serializing_if = "Option::is_none")]
        resolved_by: Option<String>,
        #[serde(rename = "autoReviewed", skip_serializing_if = "Option::is_none")]
        auto_reviewed: Option<bool>,
    },
    /// A background task started.
    #[serde(rename = "background.started")]
    BackgroundStarted {
        #[serde(skip_serializing_if = "Option::is_none")]
        owner: Option<String>,
        agent: String,
        task: String,
        kind: String,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        item: Option<String>,
        #[serde(rename = "childAgent", skip_serializing_if = "Option::is_none")]
        child_agent: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        ambient: Option<serde_json::Value>,
        /// ace's own bookkeeping: holds the thread open, never listed.
        #[serde(skip_serializing_if = "Option::is_none")]
        internal: Option<bool>,
        stoppable: bool,
        #[serde(rename = "outputPath", skip_serializing_if = "Option::is_none")]
        output_path: Option<String>,
        /// The provider never resumes the agent when this task ends.
        #[serde(rename = "wakesAgent", skip_serializing_if = "Option::is_none")]
        wakes_agent: Option<bool>,
        /// The provider takes no new prompt while it runs.
        #[serde(rename = "blocksPrompts", skip_serializing_if = "Option::is_none")]
        blocks_prompts: Option<bool>,
        /// Ending the provider's session ends it.
        #[serde(rename = "endsWithSession", skip_serializing_if = "Option::is_none")]
        ends_with_session: Option<bool>,
        /// Kept out of typed decoding: opaque provider data may be nested arbitrarily deep.
        #[serde(skip)]
        raw: Option<Vec<RawPayload>>,
    },
    /// The ports a running task's processes listen on now.
    #[serde(rename = "background.listening")]
    BackgroundListening {
        task: String,
        #[serde(deserialize_with = "crate::json_io::de_vec_i64")]
        ports: Vec<i64>,
    },
    /// ace's own task waits on the person elsewhere, or no longer does.
    #[serde(rename = "background.waiting")]
    BackgroundWaiting { task: String, waiting: bool },
    /// A background task ended.
    #[serde(rename = "background.ended")]
    BackgroundEnded {
        task: String,
        status: String,
        /// Unknown execution still holds completion.
        #[serde(skip_serializing_if = "Option::is_none")]
        uncertain: Option<bool>,
    },
    /// The provider retries on its own.
    #[serde(rename = "retry")]
    Retry {
        agent: String,
        on: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        attempt: Option<i64>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        until: Option<i64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// The agent's transport disconnected.
    #[serde(rename = "agent.disconnected")]
    AgentDisconnected { agent: String },
    /// The agent's transport reconnected.
    #[serde(rename = "agent.reconnected")]
    AgentReconnected { agent: String },
    /// The provider's retry cleared.
    #[serde(rename = "retry.cleared")]
    RetryCleared { agent: String },
    /// Explicit quota recovery.
    #[serde(rename = "limit.cleared")]
    LimitCleared { agent: String },
    /// A wake the provider expects.
    #[serde(rename = "wake.expected")]
    WakeExpected {
        agent: String,
        #[serde(deserialize_with = "crate::json_io::de_i64")]
        until: i64,
    },
    /// The provider's native goal changed.
    #[serde(rename = "goal.updated")]
    GoalUpdated {
        agent: String,
        goal: Option<ProviderGoal>,
    },
    /// The provider reported token usage.
    #[serde(rename = "usage")]
    Usage {
        agent: String,
        #[serde(rename = "inputTokens")]
        #[serde(deserialize_with = "crate::json_io::de_i64")]
        input_tokens: i64,
        #[serde(rename = "outputTokens")]
        #[serde(deserialize_with = "crate::json_io::de_i64")]
        output_tokens: i64,
        #[serde(
            rename = "cachedInputTokens",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        cached_input_tokens: Option<i64>,
        #[serde(
            rename = "contextWindow",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        context_window: Option<i64>,
        #[serde(rename = "costUsd", skip_serializing_if = "Option::is_none")]
        cost_usd: Option<f64>,
        #[serde(
            rename = "contextTokens",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        context_tokens: Option<i64>,
        #[serde(rename = "contextSessionId", skip_serializing_if = "Option::is_none")]
        context_session_id: Option<String>,
        #[serde(
            rename = "reasoningTokens",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        reasoning_tokens: Option<i64>,
        #[serde(
            rename = "cacheWriteTokens",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        cache_write_tokens: Option<i64>,
        #[serde(
            rename = "cacheWrite1hTokens",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
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
    #[serde(rename = "context.sample")]
    ContextSample {
        agent: String,
        #[serde(rename = "usedTokens")]
        #[serde(deserialize_with = "crate::json_io::de_i64")]
        used_tokens: i64,
        #[serde(
            rename = "windowTokens",
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::json_io::de_opt_i64"
        )]
        window_tokens: Option<i64>,
        #[serde(rename = "sessionId", skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// A transport heartbeat with no content of its own.
    #[serde(rename = "signal")]
    Signal {
        #[serde(skip_serializing_if = "Option::is_none")]
        agent: Option<String>,
    },
    /// The provider's process started.
    #[serde(rename = "process.started")]
    ProcessStarted,
    /// The provider's process ended.
    #[serde(rename = "process.exited")]
    ProcessExited {
        deliberate: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        unconfirmed: Option<bool>,
    },
    /// The queue changed size or hold.
    #[serde(rename = "queue.changed")]
    QueueChanged {
        #[serde(deserialize_with = "crate::json_io::de_i64")]
        count: i64,
        #[serde(skip_serializing_if = "Option::is_none")]
        source: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        held: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stopped: Option<bool>,
    },
    /// The thread's work moved to another machine, or runs here again.
    #[serde(rename = "thread.moved")]
    ThreadMoved { to: Option<crate::status::MovedTo> },
    /// A clock tick: time passed with no provider output.
    #[serde(rename = "tick")]
    Tick,
}

/// A goal the thread's provider keeps working toward.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderGoal {
    pub objective: String,
    pub status: String,
    #[serde(rename = "tokensUsed", skip_serializing_if = "Option::is_none")]
    pub tokens_used: Option<i64>,
    #[serde(rename = "tokenBudget", skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<i64>,
    #[serde(rename = "timeUsedSeconds", skip_serializing_if = "Option::is_none")]
    pub time_used_seconds: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checks: Option<i64>,
    #[serde(rename = "lastReason", skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
    #[serde(rename = "setAt", skip_serializing_if = "Option::is_none")]
    pub set_at: Option<i64>,
}

/// A rejected fact kept whole for its notice, with its `type` tag.
#[derive(Debug, Clone)]
pub struct UnknownFact {
    /// The fact's `type` tag, which no known variant matched.
    pub fact_type: String,
    /// The fact's body as canonical JSON, kept verbatim.
    pub data: ace_json::Raw,
}

/// Convert a validated fact value into the typed fold input. Validation has
/// already established every shape, so a failure here is a caller-contract
/// violation, never provider data. Bridges ace-json (transient) to serde
/// (typed) via canonical text until the Value deserializer lands.
pub fn convert(value: &crate::json_io::Json) -> Option<Fact> {
    let crate::json_io::Json::Object(map) = value else {
        return None;
    };
    // A delta's `append` is a JavaScript string and may hold a lone surrogate (a provider can
    // split a pair across frames). serde's internally tagged decoding buffers the fact through
    // `deserialize_any`, which cannot carry one, so this variant is read from the doorway's
    // value directly — the same units, exactly.
    if map.get("type").and_then(|tag| tag.as_str()) == Some("item.delta") {
        // Keys are JavaScript strings: read them with their units, not a lossy display text.
        let text = |key: &str| {
            map.get(key).and_then(|value| match value {
                crate::json_io::Json::String(text) => Some(text.to_rust().into_owned()),
                _ => None,
            })
        };
        return Some(Fact::ItemDelta {
            agent: text("agent")?,
            item: text("item")?,
            field: text("field")?,
            append: match map.get("append") {
                Some(crate::json_io::Json::String(text)) => text.clone(),
                _ => return None,
            },
        });
    }
    // Typed decoding must never walk the opaque payloads: they are replaced with a placeholder
    // in the map it reads (their own `#[serde(skip)]` fields ignore it) and attached after, as
    // the values the doorway parsed. That keeps their depth out of serde's recursion.
    let mut typed = map.clone();
    for key in ["raw", "draft"] {
        if typed.contains_key(key) {
            typed.insert(key.to_owned(), crate::json_io::Json::Null);
        }
    }
    let fact = crate::json_io::decode(&crate::json_io::Json::Object(typed)).ok()?;
    // Opaque payloads never went through typed decoding (they may nest arbitrarily deep): take
    // them as the values the doorway parsed.
    match fact {
        Fact::ItemUpsert { agent, item, .. } => Some(Fact::ItemUpsert {
            agent,
            item,
            draft: draft_of(map)?,
        }),
        Fact::ItemReconciled { agent, item, .. } => Some(Fact::ItemReconciled {
            agent,
            item,
            draft: draft_of(map)?,
        }),
        Fact::InteractionOpened {
            agent,
            interaction,
            blocking,
            request,
            item,
            ..
        } => Some(Fact::InteractionOpened {
            agent,
            interaction,
            blocking,
            request,
            item,
            raw: raw_of(map),
        }),
        Fact::BackgroundStarted {
            owner,
            agent,
            task,
            kind,
            title,
            item,
            child_agent,
            ambient,
            internal,
            stoppable,
            output_path,
            wakes_agent,
            blocks_prompts,
            ends_with_session,
            ..
        } => Some(Fact::BackgroundStarted {
            owner,
            agent,
            task,
            kind,
            title,
            item,
            child_agent,
            ambient,
            internal,
            stoppable,
            output_path,
            wakes_agent,
            blocks_prompts,
            ends_with_session,
            raw: raw_of(map),
        }),
        other => Some(other),
    }
}

/// The item draft as the provider sent it, never typed-decoded.
fn draft_of(map: &crate::json_io::Map) -> Option<crate::json_io::Map> {
    match map.get("draft") {
        Some(crate::json_io::Json::Object(draft)) => Some(draft.clone()),
        _ => None,
    }
}

/// The raw payloads a fact carried, decoded per element (each one's data is opaque text).
fn raw_of(map: &crate::json_io::Map) -> Option<Vec<RawPayload>> {
    map.get("raw")
        .and_then(|raw| crate::json_io::decode(raw).ok())
}
