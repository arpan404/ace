// SPDX-License-Identifier: Apache-2.0
//! Restart evidence and its rules (E5.8). A daemon stop, a crash or a provider exit can cut a
//! turn short; this module decides what was lost, whether startup may continue it by itself,
//! and keeps the two durable ledgers behind that decision: the streak of automatic restarts in
//! a row (`restart-resume.ts`) and the capture a shutdown took (`restart-captures.ts`).
//!
//! The rules are pure: they read a decoded thread state and the durable queue record. Only the
//! ledgers touch the store, and they take it as their argument, so no state holds a connection.

use ace_core::entity_model::InteractionRequest;
use ace_core::state::ThreadState;
use ace_core::status::is_settled;
use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::EngineError;
use crate::repository::residency::{cell_int, cell_text};

/// `maxRestartResumes` (`restart-resume.ts:11`): automatic continuations in a row before the
/// interrupted turn is left to the person.
pub const MAX_RESTART_RESUMES: i64 = 3;
/// The most background-work lines a continuation or its notice names (`lost-work.ts:19`).
const MAX_LOST_LINES: usize = 64;
/// The bound on a continuation's text: a `.slice(0, 16384)` in UTF-16 units
/// (`restart-resume.ts:66`-`:69`), not the code-point Zod bound of the queue's stored record
/// (`queue-store.ts:25`).
const CONTINUATION_UNITS: usize = 16_384;

// ---------------------------------------------------------------------------------------------
// What was lost (`lost-work.ts`)
// ---------------------------------------------------------------------------------------------

/// The background work a stopped provider took with it, or `None` when nothing was live: no
/// turn, provider queue, wake window, running task, subagent or open request.
pub fn lost_work_lines(
    state: &ThreadState,
    pending_native_inputs: usize,
    now: i64,
) -> Option<Vec<String>> {
    if state.runs.is_empty() {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    for key in state.indexes.running_tasks.keys() {
        let Some(task) = state.tasks.get(key) else {
            continue;
        };
        if task.status != "running" {
            continue;
        }
        if lines.len() < MAX_LOST_LINES {
            lines.push(format!(
                "{}: {} [{}]",
                task.kind,
                units(&task.title, 160),
                units(&task.id, 128)
            ));
        }
    }
    let mut active = state.queue_sources.provider > 0 || pending_native_inputs > 0;
    for record in state.agents.values() {
        if record.external_status.is_some() {
            continue;
        }
        active = active
            || record.active_run.is_some()
            || record.wake_until.is_some_and(|until| until > now);
        if record.agent.origin == "root" || is_settled(&record.agent.status) {
            continue;
        }
        if lines.len() < MAX_LOST_LINES {
            let name = record
                .agent
                .name
                .clone()
                .unwrap_or_else(|| record.agent.id.clone());
            lines.push(format!("subagent: {}", units(&name, 160)));
        }
    }
    if !active && lines.is_empty() && state.indexes.pending_interactions.is_empty() {
        return None;
    }
    Some(lines)
}

/// The continuation text a restart sends, naming the background work that died
/// (`lost-work.ts:33`): Cursor SDK work stays uncertain until checkpoint reconciliation, so it
/// says so, and every other provider names what stopped.
pub fn lost_work(
    state: &ThreadState,
    pending_native_inputs: usize,
    backend: Option<&str>,
    now: i64,
) -> Option<String> {
    let lines = lost_work_lines(state, pending_native_inputs, now)?;
    let cursor = backend == Some("cursor-sdk");
    let instruction = if cursor {
        "ace restarted. The previous Cursor SDK host is unavailable. Native run, child and tool \
         outcomes remain uncertain until checkpoint reconciliation. Continue only after recovery \
         confirms safe native continuation; never replay possibly delivered input."
    } else {
        "ace restarted. The previous provider process stopped. Continue the interrupted task from \
         native history. Recheck unfinished tools and expired approvals before relying on their \
         results."
    };
    let heading = if cursor {
        "The following background work is unresolved:"
    } else {
        "The following background work died or became unreachable:"
    };
    let body = if lines.is_empty() {
        "No known background work was live.".to_owned()
    } else {
        format!(
            "{heading}\n{}\nRecheck it before restarting. This list is limited to 64 entries.",
            lines.join("\n")
        )
    };
    Some(units(&format!("{instruction}\n{body}"), CONTINUATION_UNITS).to_owned())
}

// ---------------------------------------------------------------------------------------------
// The open request a capture names (`restart-captures.ts`)
// ---------------------------------------------------------------------------------------------

/// One line naming what the agent's open request asks the person, if it has one.
pub fn open_request_line(state: &ThreadState) -> Option<String> {
    for key in state.indexes.pending_interactions.keys() {
        // A stale index entry (a snapshot another build wrote) is skipped, not fatal to the
        // capture: the next pending request still names what the agent waits on.
        let Some(interaction) = state.interactions.get(key) else {
            continue;
        };
        if interaction.state == "pending" {
            return Some(request_line(&interaction.request));
        }
    }
    None
}

/// The request's first non-blank line, or its kind with underscores read as spaces.
fn request_line(request: &InteractionRequest) -> String {
    let text = match request {
        InteractionRequest::Question { questions, .. } => {
            questions.first().map(|question| question.text.as_str())
        }
        InteractionRequest::Approval { title, .. } => Some(title.as_str()),
        InteractionRequest::PlanReview { title, .. } => title.as_deref(),
        InteractionRequest::Elicitation { title, .. } => title.as_deref(),
        InteractionRequest::BrowserHelp { title, .. } => title.as_deref(),
    };
    if let Some(line) = text.and_then(|text| text.lines().find(|part| !part.trim().is_empty())) {
        return line.trim().to_owned();
    }
    kind_of(request).replace('_', " ")
}

fn kind_of(request: &InteractionRequest) -> &'static str {
    match request {
        InteractionRequest::Approval { .. } => "approval",
        InteractionRequest::Question { .. } => "question",
        InteractionRequest::PlanReview { .. } => "plan_review",
        InteractionRequest::Elicitation { .. } => "elicitation",
        InteractionRequest::BrowserHelp { .. } => "browser_help",
    }
}

// ---------------------------------------------------------------------------------------------
// Whether startup continues it (`restart-resume.ts`)
// ---------------------------------------------------------------------------------------------

/// What startup knows about one thread whose provider work a restart may have cut short.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestartFacts {
    /// A turn, background shell, subagent or provider queue was live when ace stopped.
    pub was_running: bool,
    /// Something already held the queue before this restart: a Stop, a pause, a limit, an
    /// earlier hold.
    pub held_before: bool,
    pub settled: bool,
    pub archived: bool,
    /// A request the agent was waiting on the person to answer, if any.
    pub waiting_on_person: bool,
    /// Input whose delivery a crash left uncertain; the person reviews it first.
    pub uncertain: bool,
    /// The provider can reopen the same native session.
    pub can_continue: bool,
    /// Automatic restart continuations in a row, without a completed turn or new input between.
    pub streak: i64,
}

/// Why a restart left the turn to the person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartHold {
    /// The agent was waiting for the person's answer.
    Person,
    /// A message's delivery was uncertain.
    Uncertain,
    /// The provider cannot pick the session back up by itself.
    Unsupported,
    /// It kept dying across restarts.
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartDecision {
    /// Nothing to continue.
    None,
    /// Continue it by itself.
    Resume,
    /// Hold it for the person, for this reason.
    Hold(RestartHold),
}

/// Continue the interrupted work by itself only when that is safe and wanted.
pub fn restart_decision(facts: &RestartFacts) -> RestartDecision {
    if !facts.was_running || facts.held_before || facts.settled || facts.archived {
        return RestartDecision::None;
    }
    if facts.waiting_on_person {
        return RestartDecision::Hold(RestartHold::Person);
    }
    if facts.uncertain {
        return RestartDecision::Hold(RestartHold::Uncertain);
    }
    if !facts.can_continue {
        return RestartDecision::Hold(RestartHold::Unsupported);
    }
    if facts.streak >= MAX_RESTART_RESUMES {
        return RestartDecision::Hold(RestartHold::Loop);
    }
    RestartDecision::Resume
}

/// The transcript notice for a decision; every restart that interrupted work writes one.
pub fn restart_notice_text(decision: RestartDecision, request: Option<&str>) -> String {
    let RestartDecision::Hold(why) = decision else {
        return "Interrupted by a restart. Continuing.".to_owned();
    };
    match why {
        RestartHold::Person => match request {
            Some(request) => format!(
                "Interrupted by a restart while waiting for your answer to \"{}\". Continue and \
                 the agent asks again.",
                units(request, 160)
            ),
            None => "Interrupted by a restart while waiting for your answer. Continue and the \
                     agent asks again."
                .to_owned(),
        },
        RestartHold::Uncertain => {
            "Interrupted by a restart while a message was being sent. Review it, then continue."
                .to_owned()
        }
        RestartHold::Unsupported => "Interrupted by a restart. This agent can't pick its session \
                                     back up by itself; send a message to carry on."
            .to_owned(),
        RestartHold::Loop => format!(
            "Interrupted by a restart {MAX_RESTART_RESUMES} times in a row, so ace stopped \
             continuing it by itself. Continue when ready."
        ),
    }
}

/// The input a restart continuation sends, naming the background work that died
/// (`restart-resume.ts:56`).
pub fn restart_continuation(lost: &[String]) -> String {
    const INSTRUCTION: &str = "ace restarted while you were working, so your turn was cut \
        short. Background shell commands, monitors and subagents you started have stopped, and \
        any request you were waiting on has expired. Check the state of your work (files, git \
        status, delegated agents, anything you were waiting on), rerun what was cut short \
        instead of assuming it finished, then continue the task.";
    let lines = &lost[..lost.len().min(MAX_LOST_LINES)];
    let tail = if lines.is_empty() {
        String::new()
    } else {
        format!(
            "\nThese were running and have stopped:\n{}",
            lines.join("\n")
        )
    };
    units(&format!("{INSTRUCTION}{tail}"), CONTINUATION_UNITS).to_owned()
}

// ---------------------------------------------------------------------------------------------
// The ledgers (`restart-resume.ts:76`, `restart-captures.ts:20`)
// ---------------------------------------------------------------------------------------------

/// `engine_restart_resumes`' DDL, byte for byte the TypeScript's (`restart-resume.ts:78`-`:81`):
/// SQLite keeps the text in `sqlite_master`, so both daemons must leave identical schema text.
/// `ace-engine::open` runs it at open, in the TypeScript opener's order; `Engine::new` never
/// does open-time DDL (E5.4 decision 8 as amended 2026-11-26).
pub const RESTART_RESUMES_DDL: &str = "CREATE TABLE IF NOT EXISTS engine_restart_resumes (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        streak INTEGER NOT NULL
      )";

/// `engine_restart_captures`' DDL, byte for byte the TypeScript's (`restart-captures.ts:23`-`:27`).
pub const RESTART_CAPTURES_DDL: &str = "CREATE TABLE IF NOT EXISTS engine_restart_captures (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        waiting_on TEXT
      )";

/// Creates both ledgers from the consts above. `ace-engine::open` calls this at open; tests that
/// drive the ledgers over a bare connection call it too. `Engine::new` must not: open-time DDL
/// has one owner.
pub fn ensure_ledgers(conn: &Arc<ace_store::Connection>) -> Result<(), EngineError> {
    conn.exec(RESTART_RESUMES_DDL)?;
    conn.exec(RESTART_CAPTURES_DDL)?;
    Ok(())
}

const STREAK: &str = "SELECT streak FROM engine_restart_resumes WHERE thread_id=?";
const INCREMENT_STREAK: &str = "INSERT INTO engine_restart_resumes(thread_id,streak) VALUES (?,1) ON CONFLICT(thread_id) DO UPDATE SET streak=streak+1";

/// Automatic restart continuations in a row for this thread (`RestartStreaks.get`).
pub fn streak(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<i64, EngineError> {
    let row = stmt_cache::get_row(conn, STREAK, vec![Value::Text(thread.to_owned())])?;
    Ok(row
        .and_then(|row| row.get("streak").and_then(cell_int))
        .unwrap_or(0))
}

/// One more automatic continuation, as `RestartStreaks.increment` writes it.
pub fn increment_streak(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<(), EngineError> {
    stmt_cache::run(conn, INCREMENT_STREAK, vec![Value::Text(thread.to_owned())])?;
    Ok(())
}

/// A completed turn or new input from someone ends the run of restarts.
pub fn clear_streak(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    crate::queue::admission::clear_restart_streak(conn, thread)
}

const RECORD_CAPTURE: &str = "INSERT INTO engine_restart_captures(thread_id,waiting_on) VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET waiting_on=excluded.waiting_on";
const HAS_CAPTURE: &str = "SELECT 1 FROM engine_restart_captures WHERE thread_id=?";
const TAKE_CAPTURE: &str = "SELECT waiting_on FROM engine_restart_captures WHERE thread_id=?";
const CLEAR_CAPTURE: &str = "DELETE FROM engine_restart_captures WHERE thread_id=?";

/// What a restart capture saw when it recorded the continuation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestartCapture {
    /// The request the agent was waiting on the person to answer, if any.
    pub waiting_on: Option<String>,
}

/// Records the evidence behind a restart continuation, saved with it (`RestartCaptures.record`).
pub fn record_capture(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    capture: &RestartCapture,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        RECORD_CAPTURE,
        vec![
            Value::Text(thread.to_owned()),
            capture.waiting_on.clone().map_or(Value::Null, Value::Text),
        ],
    )?;
    Ok(())
}

/// Whether the thread has a capture a later startup has not read yet.
pub fn has_capture(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(conn, HAS_CAPTURE, vec![Value::Text(thread.to_owned())])?.is_some())
}

/// Reads and removes the record: each capture informs one startup decision.
pub fn take_capture(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
) -> Result<Option<RestartCapture>, EngineError> {
    let row = stmt_cache::get_row(conn, TAKE_CAPTURE, vec![Value::Text(thread.to_owned())])?;
    let Some(row) = row else {
        return Ok(None);
    };
    clear_capture(conn, thread)?;
    Ok(Some(RestartCapture {
        waiting_on: row.get("waiting_on").and_then(cell_text).map(str::to_owned),
    }))
}

/// Drops the record without reading it: the capture no longer applies.
pub fn clear_capture(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<(), EngineError> {
    stmt_cache::run(conn, CLEAR_CAPTURE, vec![Value::Text(thread.to_owned())])?;
    Ok(())
}

/// JavaScript's `String.prototype.slice(0, max)`, which counts UTF-16 units (rule 17). A Rust
/// `String` cannot hold the lone surrogate `.slice` leaves when a cut splits a pair, so this cuts
/// before the pair instead: the count is the TypeScript's, and the text differs by that one half
/// character (`docs/engine/behaviour.md`, section 13).
fn units(text: &str, max: usize) -> &str {
    if text.encode_utf16().count() <= max {
        return text;
    }
    let mut taken = 0;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if taken + width > max {
            return &text[..index];
        }
        taken += width;
    }
    text
}

#[cfg(test)]
mod tests;
