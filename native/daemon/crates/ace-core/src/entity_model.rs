// SPDX-License-Identifier: Apache-2.0
//! The interaction and background-task rows: protocol shapes shared by the
//! fold, validation, and the facade's state refresh.

use serde::{Deserialize, Serialize};

use crate::item_model::{RawPayload, Vetted};
use crate::json_io::de_i64;

/// One interaction: a question, approval, plan review, elicitation or
/// browser-help request waiting on the person.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Interaction {
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub blocking: bool,
    pub request: InteractionRequest,
    pub state: String,
    #[serde(rename = "createdAt", deserialize_with = "de_i64")]
    pub created_at: i64,
    #[serde(default)]
    pub raw: Vec<RawPayload>,
    /// Item that prompted this interaction.
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "expirationReason", skip_serializing_if = "Option::is_none")]
    pub expiration_reason: Option<String>,
    #[serde(rename = "closedAt", skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<InteractionResolution>,
    /// Device that answered first.
    #[serde(rename = "resolvedBy", skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    /// Explicit canonical automatic review; absence means unknown.
    #[serde(rename = "autoReviewed", skip_serializing_if = "Option::is_none")]
    pub auto_reviewed: Option<bool>,
}

/// What the agent asks the person for.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum InteractionRequest {
    /// An approval with its options.
    #[serde(rename = "approval")]
    Approval {
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<ApprovalTarget>,
        title: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        options: Vec<ApprovalOption>,
        #[serde(rename = "defaultToNo", skip_serializing_if = "Option::is_none")]
        default_to_no: Option<bool>,
        #[serde(
            rename = "suppressAlwaysAllowRule",
            skip_serializing_if = "Option::is_none"
        )]
        suppress_always_allow_rule: Option<bool>,
        #[serde(rename = "mcpServer", skip_serializing_if = "Option::is_none")]
        mcp_server: Option<McpServer>,
        #[serde(rename = "permissionUpdates", skip_serializing_if = "Option::is_none")]
        permission_updates: Option<Vec<Vetted>>,
    },
    /// A question with its options.
    #[serde(rename = "question")]
    Question {
        questions: Vec<Question>,
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<ApprovalTarget>,
    },
    /// A plan to review.
    #[serde(rename = "plan_review")]
    PlanReview {
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
        markdown: String,
        #[serde(rename = "planPath", skip_serializing_if = "Option::is_none")]
        plan_path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todos: Option<Vec<crate::item_model::TodoEntry>>,
    },
    /// An elicitation: a form or a URL.
    #[serde(rename = "elicitation")]
    Elicitation {
        server: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        schema: Option<Vetted>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mode: Option<String>,
        #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
        native_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
    },
    /// The person helps in a browser tab, then says it is done.
    #[serde(rename = "browser_help")]
    BrowserHelp {
        #[serde(skip_serializing_if = "Option::is_none")]
        target: Option<ApprovalTarget>,
        #[serde(rename = "tabId")]
        tab_id: String,
        reason: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
}

/// The MCP server an approval names, with its passthrough extras kept.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub source: String,
    #[serde(flatten, default)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// One approval option.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// One question with its options.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    pub text: String,
    pub options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect", default)]
    pub multi_select: bool,
    #[serde(rename = "allowOther", default)]
    pub allow_other: bool,
    #[serde(default)]
    pub secret: bool,
}

/// One option of a question.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The target of an approval: the tool call it allows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalTarget {
    pub tool: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "riskClass", skip_serializing_if = "Option::is_none")]
    pub risk_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    pub access: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Vetted>,
}

/// How the person answered.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum InteractionResolution {
    /// An approval answer.
    #[serde(rename = "approval")]
    Approval {
        #[serde(rename = "optionId")]
        option_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    /// Answers to a question.
    #[serde(rename = "question")]
    Question {
        /// Question id to selected option ids, or free text.
        answers: serde_json::Map<String, serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        dismissed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    /// A plan review decision.
    #[serde(rename = "plan_review")]
    PlanReview {
        decision: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        feedback: Option<String>,
    },
    /// An elicitation action.
    #[serde(rename = "elicitation")]
    Elicitation {
        action: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        content: Option<Vetted>,
    },
    /// The person finished in the tab, or chose not to.
    #[serde(rename = "browser_help")]
    BrowserHelp { outcome: String },
}

/// Work that can outlive the turn that started it. Its JSON order is written in `item_json`.
#[derive(Debug, Clone, Deserialize)]
pub struct BackgroundTask {
    pub id: String,
    /// Agent that owns the task.
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub kind: String,
    /// Host-owned execution survives a provider session restarting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub title: String,
    /// `unknown`: ace lost track; shown as possibly running.
    pub status: String,
    /// Long-lived helpers never hold a thread open. The TypeScript never
    /// validates this field, so any JSON value survives verbatim.
    pub ambient: serde_json::Value,
    /// ace's own bookkeeping; never listed by clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal: Option<bool>,
    /// Whether ace can stop it individually.
    pub stoppable: bool,
    #[serde(rename = "startedAt", deserialize_with = "de_i64")]
    pub started_at: i64,
    #[serde(default)]
    pub raw: Vec<RawPayload>,
    /// Tool call that started it.
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// For `subagent` tasks: the agent doing the work.
    #[serde(rename = "childAgentId", skip_serializing_if = "Option::is_none")]
    pub child_agent_id: Option<String>,
    /// File the provider writes the task's output to, if any.
    #[serde(rename = "outputPath", skip_serializing_if = "Option::is_none")]
    pub output_path: Option<String>,
    /// The provider never resumes the agent when this task ends.
    #[serde(rename = "wakesAgent", skip_serializing_if = "Option::is_none")]
    pub wakes_agent: Option<bool>,
    /// The provider takes no new prompt while this runs.
    #[serde(rename = "blocksPrompts", skip_serializing_if = "Option::is_none")]
    pub blocks_prompts: Option<bool>,
    /// Ending its session ends it; nothing else can.
    #[serde(rename = "endsWithSession", skip_serializing_if = "Option::is_none")]
    pub ends_with_session: Option<bool>,
    /// TCP ports the task's processes listen on.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listening: Option<Vec<i64>>,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    /// Keys the fold added after the task was announced: JavaScript appends a new own key at
    /// the end, so they serialize last.
    #[serde(skip)]
    pub trailing: Vec<&'static str>,
}

impl BackgroundTask {
    /// Record a key the fold appended, as `task[key] = value` does for a new key.
    pub fn appended(&mut self, key: &'static str) {
        if !self.trailing.contains(&key) {
            self.trailing.push(key);
        }
    }
}
