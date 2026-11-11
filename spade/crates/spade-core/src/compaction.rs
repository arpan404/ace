//! When and where to compact a conversation, and how a summary is asked for and written. Pure:
//! the engine supplies the reported prompt size and runs the model call.

use schemars::JsonSchema;
use serde::Deserialize;

use crate::event::{Event, Known};
use serde_json::Value;

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
pub fn plan(events: &[Event], prompt_tokens: u32, budget: u32) -> Option<Plan> {
    if budget == 0 || f64::from(prompt_tokens) < f64::from(budget) * HIGH {
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
            Known::UserMessage { text, context } => {
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
         open and references (arrays of strings)."
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

/// Writes and destructive calls carried out before `keep_from`, each with its call id and exact
/// arguments, taken from the events rather than any summary. A background write counts once its
/// job finished without error; one still running (or never reported) is listed as such, since
/// repeating it would act twice.
pub fn carried_out(events: &[Event], keep_from: usize, registry: &Registry) -> Vec<String> {
    let calls: std::collections::HashMap<&str, Value> = events
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::StepFinished { calls, .. }) => Some(calls),
            _ => None,
        })
        .flatten()
        .map(|call| {
            let arguments = match call.name.as_str() {
                CALL_TOOL => unwrap_call_tool(&call.arguments).map(|(_, inner)| inner),
                _ => None,
            };
            (
                call.id.as_str(),
                arguments.unwrap_or_else(|| call.arguments.clone()),
            )
        })
        .collect();
    let arguments = |id: &str| calls.get(id).map_or_else(String::new, Value::to_string);
    let changes = |name: &str| registry.get(name).is_some_and(|t| t.risk != Risk::Read);
    let background = |name: &str| registry.get(name).is_some_and(|t| t.background);
    let finished_job = |job: &str| {
        events.iter().find_map(|event| match event {
            Event::Known(Known::JobFinished {
                job: j, is_error, ..
            }) if j == job => Some(*is_error),
            _ => None,
        })
    };
    events[..keep_from.min(events.len())]
        .iter()
        .filter_map(|event| match event {
            Event::Known(Known::ToolFinished {
                name,
                is_error: false,
                call_id,
                ..
            }) if changes(name) && !background(name) => Some(
                format!("{name} (call {call_id}) {}", arguments(call_id))
                    .trim_end()
                    .to_owned(),
            ),
            Event::Known(Known::JobFinished {
                job,
                name,
                is_error: false,
                ..
            }) if changes(name) => Some(
                format!("{name} (job {job}) {}", arguments(job))
                    .trim_end()
                    .to_owned(),
            ),
            Event::Known(Known::JobStarted { job, name, .. })
                if changes(name) && finished_job(job).is_none() =>
            {
                Some(format!(
                    "{} (job {job}) {}, still running in the background; its result has not arrived",
                    name,
                    arguments(job)
                ))
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests;
