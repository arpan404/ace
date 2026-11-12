//! When and where to compact a conversation, and how a summary is asked for and written. Pure:
//! the engine supplies the reported prompt size and runs the model call.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::context::{self, outcome_unknown};
use crate::event::{Event, Known};
use crate::tools::{CALL_TOOL, Registry, Risk, unwrap_call_tool};

/// Compact once the prompt reaches this share of the budget...
pub const HIGH: f64 = 0.75;
/// ...keeping recent turns worth about this share, so one compaction lasts many turns.
pub const LOW: f64 = 0.35;

/// The part of the conversation a compaction keeps word for word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// Index of the first event kept; always a message from the person sent while no tool call
    /// was waiting for its result, so no call is cut from its result.
    pub keep_from: usize,
}

/// Whether to compact now, and where to cut. `prompt_tokens` is what the endpoint reported for
/// the last call; `budget` is the smaller of the model's context and Spade's cap.
/// Too many images to show also compacts, whatever the size: that is the only point where which
/// older images are left out may change.
pub fn plan(events: &[Event], prompt_tokens: u32, budget: u32) -> Option<Plan> {
    let full = budget > 0 && f64::from(prompt_tokens) >= f64::from(budget) * HIGH;
    if !full && !context::too_many_images(events) {
        return None;
    }
    // `prompt_tokens` comes from the last step. If a compaction came after it, that size is from
    // before the compaction; wait for a step to report the new one.
    let last_step = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::StepFinished { .. })));
    let last_compaction = events
        .iter()
        .rposition(|e| matches!(e, Event::Known(Known::ContextCompacted { .. })));
    if let (Some(compacted), step) = (last_compaction, last_step)
        && step.is_none_or(|step| compacted > step)
    {
        return None;
    }
    let already = events.iter().rev().find_map(|event| match event {
        Event::Known(Known::ContextCompacted { keep_from, .. }) => Some(*keep_from),
        _ => None,
    });
    let starts = safe_starts(events, already);
    let last = *starts.last()?;
    // Size each candidate's kept part in proportion to the reported prompt, by text length.
    let sizes: Vec<usize> = events.iter().map(text_len).collect();
    let total: usize = sizes.iter().sum::<usize>().max(1);
    let target = f64::from(budget) * LOW;
    let keep_from = starts
        .iter()
        .copied()
        // A cut at the very start would summarise nothing.
        .filter(|&start| start > already.unwrap_or(0))
        .find(|&start| {
            let kept: usize = sizes[start..].iter().sum();
            f64::from(prompt_tokens) * (kept as f64 / total as f64) <= target
        })
        .unwrap_or(last);
    (keep_from > already.unwrap_or(0)).then_some(Plan { keep_from })
}

/// Where a compaction may cut: each message from the person, after `after`, sent while every
/// earlier tool call already had its result. Cutting at a message steered in while tools ran would
/// keep a result whose call was summarised away.
pub fn safe_starts(events: &[Event], after: Option<usize>) -> Vec<usize> {
    let mut open: Vec<&str> = Vec::new();
    let mut starts = Vec::new();
    for (at, event) in events.iter().enumerate() {
        let Event::Known(event) = event else { continue };
        match event {
            Known::StepFinished { calls, .. } => {
                open = calls.iter().map(|c| c.id.as_str()).collect();
            }
            Known::ToolFinished { call_id, .. } => open.retain(|id| id != call_id),
            Known::ReplyFinished { .. }
            | Known::ReplyStopped { .. }
            | Known::ReplyFailed { .. }
            | Known::ReplyInterrupted { .. } => open.clear(),
            Known::UserMessage { .. } if open.is_empty() && after.is_none_or(|k| at > k) => {
                starts.push(at);
            }
            _ => {}
        }
    }
    starts
}

fn text_len(event: &Event) -> usize {
    match event {
        Event::Known(known) => match known {
            Known::UserMessage { text, context, .. } => {
                text.len() + context.as_ref().map_or(0, String::len)
            }
            Known::StepFinished { text, calls, .. } => {
                text.len()
                    + calls
                        .iter()
                        .map(|c| c.arguments.to_string().len())
                        .sum::<usize>()
            }
            Known::ToolFinished { content, .. } => content.len(),
            Known::ContextCompacted { summary, .. } => summary.len(),
            _ => 0,
        },
        Event::Unknown(_) => 0,
    }
}

/// The summary asked of the model, as a JSON object in its reply.
#[derive(Debug, Clone, PartialEq, Deserialize, JsonSchema)]
pub struct Summary {
    /// What the conversation is for.
    pub goal: String,
    /// What the person and Spade agreed.
    pub decisions: Vec<String>,
    /// What was learned, each with where it came from.
    pub facts: Vec<String>,
    /// Open questions and the next steps.
    pub open: Vec<String>,
    /// Ids, links and file paths still needed.
    pub references: Vec<String>,
    /// Durable facts worth keeping beyond this conversation, saved as the bot's notes
    /// (ADR 0128). Missing from a reply that leaves them out.
    #[serde(default)]
    pub notes: Vec<String>,
}

/// The request appended to the conversation's own prompt, so its input is mostly cache reads.
pub fn request(focus: Option<&str>) -> String {
    let focus = focus
        .filter(|f| !f.trim().is_empty())
        .map(|f| format!(" Keep in particular: {f}."))
        .unwrap_or_default();
    format!(
        "Summarise this conversation so far so it can continue without the earlier messages. \
         Be specific and brief: the goal, decisions made, facts learned with their sources, open \
         questions and next steps, and ids, links and paths still needed.{focus} Do not call any \
         tool. Reply with only a JSON object with the keys goal (a string) and decisions, facts, \
         open, references and notes (arrays of strings). notes holds what is worth remembering \
         beyond this conversation: facts about the person, their standing preferences and lasting \
         decisions, one short self-contained sentence each, leaving out what your notes already \
         say and anything only this task needs."
    )
}

/// The summary in the model's reply, if it wrote one: the JSON object, with or without a code
/// fence around it.
pub fn parse_summary(text: &str) -> Option<Summary> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    serde_json::from_str(text.get(start..=end)?).ok()
}

/// The summary as the model will read it, with every action already carried out listed from the
/// events themselves, so the summary can never lose one and Spade never repeats it.
pub fn render(summary: &Summary, carried_out: &[String]) -> String {
    let mut out = format!(
        "Summary of the earlier conversation\n\nGoal: {}\n",
        summary.goal
    );
    for (title, items) in [
        ("Decisions", &summary.decisions),
        ("Facts", &summary.facts),
        ("Open", &summary.open),
        ("References", &summary.references),
    ] {
        if !items.is_empty() {
            out.push_str(&format!("\n{title}:\n"));
            for item in items {
                out.push_str(&format!("- {item}\n"));
            }
        }
    }
    if !carried_out.is_empty() {
        out.push_str("\nAlready carried out (do not repeat):\n");
        for action in carried_out {
            out.push_str(&format!("- {action}\n"));
        }
    }
    out
}

/// The note for a write whose outcome is unknown.
const MAYBE: &str = ", may have taken effect; check before trying it again";

/// What became of a write made before the cut, for the summary's "already carried out" list.
fn outcome(events: &[Event], call_id: &str, background: bool) -> Option<&'static str> {
    if background {
        let ended = events.iter().find_map(|event| match event {
            Event::Known(Known::JobFinished {
                job,
                is_error,
                uncertain,
                content,
                ..
            }) if job == call_id => Some(ended(*is_error, *uncertain, content)),
            _ => None,
        });
        return match ended {
            Some(note) => note,
            None if started_job(events, call_id) => {
                Some(", still running in the background; its result has not arrived")
            }
            None => None,
        };
    }
    let finished = events.iter().find_map(|event| match event {
        Event::Known(Known::ToolFinished {
            call_id: c,
            is_error,
            uncertain,
            content,
            ..
        }) if c == call_id => Some(ended(*is_error, *uncertain, content)),
        _ => None,
    });
    match finished {
        Some(note) => note,
        None if started(events, call_id).is_some() => Some(MAYBE),
        None => None,
    }
}

/// The note for a write that has a stored result: done, unknown, or failed (left out).
fn ended(is_error: bool, uncertain: bool, content: &str) -> Option<&'static str> {
    if outcome_unknown(is_error, uncertain, content) {
        Some(MAYBE)
    } else if is_error {
        None
    } else {
        Some("")
    }
}

fn started_job(events: &[Event], job: &str) -> bool {
    events
        .iter()
        .any(|e| matches!(e, Event::Known(Known::JobStarted { job: j, .. }) if j == job))
}

/// The call's stored start: the risk and background flag it was recorded with, if any.
fn started(events: &[Event], call_id: &str) -> Option<Option<(Risk, bool)>> {
    events.iter().find_map(|event| match event {
        Event::Known(Known::ToolStarted {
            call_id: c,
            risk,
            background,
            ..
        }) if c == call_id => Some(risk.map(|risk| (risk, *background))),
        _ => None,
    })
}

/// Writes and destructive calls made before `keep_from`, each with its call id and exact
/// arguments taken from the step, never from a summary. A write counts when it finished without
/// error, wherever in the conversation that happened; one whose outcome is unknown (cut off, or a
/// background job stopped or lost) or still running is listed as such, since repeating it could
/// act twice. Failed writes are left out. A call's risk is the one stored when it ran; only events
/// from before that was recorded fall back to `registry`.
pub fn carried_out(events: &[Event], keep_from: usize, registry: &Registry) -> Vec<String> {
    let mut out = Vec::new();
    for event in &events[..keep_from.min(events.len())] {
        let Event::Known(Known::StepFinished { calls, .. }) = event else {
            continue;
        };
        for call in calls {
            let (name, arguments) = match call.name.as_str() {
                CALL_TOOL => unwrap_call_tool(&call.arguments)
                    .unwrap_or_else(|| (call.name.clone(), call.arguments.clone())),
                _ => (call.name.clone(), call.arguments.clone()),
            };
            let recorded = started(events, &call.id).flatten();
            let facts =
                recorded.or_else(|| registry.get(&name).map(|tool| (tool.risk, tool.background)));
            let Some((_, background)) =
                facts.filter(|(risk, _)| !matches!(risk, Risk::Read | Risk::Memory))
            else {
                continue;
            };
            if let Some(note) = outcome(events, &call.id, background) {
                out.push(format!("{name} (call {}) {arguments}{note}", call.id));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
