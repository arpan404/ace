//! The files a bot made while answering a group (ADR 0132), for the group's Library: what its
//! replies to that group's asks wrote in its workspace. Pure, over the bot's own conversation.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::activity::Stored;
use crate::event::{Event, Known};

/// The tools that write a workspace file, by its `path`.
const WRITES: [&str; 2] = ["workspace_write", "workspace_edit"];

/// A file a bot made in a group: its workspace path and when it was last written there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MadeFile {
    pub path: String,
    pub at: i64,
}

/// Every file the bot's replies to `group` wrote (a tool that ran without error) or kept (a
/// background job's report), once each, newest first. A reply counts when a message from the
/// group started it or steered it.
pub fn made_for<'a>(group: &str, events: impl IntoIterator<Item = Stored<'a>>) -> Vec<MadeFile> {
    let mut theirs: HashSet<String> = HashSet::new();
    let mut open: Option<String> = None;
    let mut next_is_theirs = false;
    let mut writes: HashMap<String, String> = HashMap::new();
    let mut jobs: HashSet<String> = HashSet::new();
    let mut made: HashMap<String, i64> = HashMap::new();
    for stored in events {
        let Event::Known(event) = stored.event else {
            continue;
        };
        match event {
            Known::UserMessage { from_group, .. } => {
                let from_here = from_group.as_ref().is_some_and(|g| g.id == group);
                if from_here && let Some(reply) = &open {
                    theirs.insert(reply.clone());
                }
                next_is_theirs = from_here;
            }
            Known::ReplyStarted { reply, .. } => {
                if next_is_theirs {
                    theirs.insert(reply.clone());
                }
                next_is_theirs = false;
                open = Some(reply.clone());
            }
            Known::ReplyFinished { reply, .. }
            | Known::ReplyStopped { reply, .. }
            | Known::ReplyFailed { reply, .. }
            | Known::ReplyInterrupted { reply, .. }
                if open.as_ref() == Some(reply) =>
            {
                open = None;
            }
            Known::StepFinished { reply, calls, .. } if theirs.contains(reply) => {
                for call in calls {
                    if let Some(path) = written_path(&call.name, &call.arguments) {
                        writes.insert(call.id.clone(), path);
                    }
                }
            }
            Known::ToolFinished {
                call_id, is_error, ..
            } => {
                if let Some(path) = writes.remove(call_id)
                    && !is_error
                {
                    made.insert(path, stored.at);
                }
            }
            Known::JobStarted { reply, job, .. } if theirs.contains(reply) => {
                jobs.insert(job.clone());
            }
            Known::JobFinished {
                job,
                files,
                is_error: false,
                ..
            } if jobs.remove(job) => {
                for path in files {
                    made.insert(path.clone(), stored.at);
                }
            }
            _ => {}
        }
    }
    let mut files: Vec<MadeFile> = made
        .into_iter()
        .map(|(path, at)| MadeFile { path, at })
        .collect();
    files.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.path.cmp(&b.path)));
    files
}

fn written_path(name: &str, arguments: &Value) -> Option<String> {
    if !WRITES.contains(&name) {
        return None;
    }
    arguments
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::event::{Call, FromGroup, Tokens};

    fn k(known: Known) -> Event {
        Event::Known(known)
    }

    fn asked(group: Option<&str>) -> Event {
        k(Known::UserMessage {
            text: "Draft it".into(),
            context: None,
            images: Vec::new(),
            documents: Vec::new(),
            voice: None,
            from_agent: None,
            from_routine: None,
            from_group: group.map(|id| {
                Box::new(FromGroup {
                    id: id.into(),
                    name: "Launch".into(),
                    run: "run1".into(),
                    ask: "ask1".into(),
                    machine: None,
                    untrusted: false,
                })
            }),
        })
    }

    fn writes(reply: &str, call: &str, path: &str) -> [Event; 2] {
        [
            k(Known::StepFinished {
                reply: reply.into(),
                text: String::new(),
                calls: vec![Call {
                    id: call.into(),
                    name: "workspace_write".into(),
                    arguments: json!({ "path": path, "content": "x" }),
                }],
                thoughts: Vec::new(),
                usage: Tokens::default(),
                cost_micros: 0,
                seen: None,
            }),
            k(Known::ToolFinished {
                reply: reply.into(),
                call_id: call.into(),
                name: "workspace_write".into(),
                content: "written".into(),
                is_error: false,
                uncertain: false,
                images: Vec::new(),
                untrusted: false,
            }),
        ]
    }

    fn finished(reply: &str) -> Event {
        k(Known::ReplyFinished {
            reply: reply.into(),
            text: "Done".into(),
            input_tokens: None,
            output_tokens: None,
            cost_micros: 0,
        })
    }

    fn files(events: &[Event]) -> Vec<(String, i64)> {
        let stored = events.iter().enumerate().map(|(i, event)| Stored {
            seq: i as i64 + 1,
            at: 100 * (i as i64 + 1),
            event,
        });
        made_for("g1", stored)
            .into_iter()
            .map(|f| (f.path, f.at))
            .collect()
    }

    #[test]
    fn only_the_replies_a_group_started_or_steered_count_and_each_file_once() {
        let mut events = vec![asked(None), Event::reply_started("r1", "e/m")];
        events.extend(writes("r1", "c1", "own.md"));
        events.push(asked(Some("g1")));
        // Steered by the group: what it writes from here on counts.
        events.extend(writes("r1", "c2", "plan.md"));
        events.push(finished("r1"));
        events.push(asked(Some("other")));
        events.push(Event::reply_started("r2", "e/m"));
        events.extend(writes("r2", "c3", "elsewhere.md"));
        events.push(finished("r2"));
        events.push(asked(Some("g1")));
        events.push(Event::reply_started("r3", "e/m"));
        events.extend(writes("r3", "c4", "plan.md"));
        events.extend(writes("r3", "c5", "notes/brief.md"));
        events.push(finished("r3"));
        let made = files(&events);
        let paths: Vec<&str> = made.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(paths, ["notes/brief.md", "plan.md"]);
        assert!(made.windows(2).all(|w| w[0].1 >= w[1].1), "newest first");
    }

    #[test]
    fn a_write_that_failed_made_nothing() {
        let mut events = vec![asked(Some("g1")), Event::reply_started("r1", "e/m")];
        let [step, done] = writes("r1", "c1", "plan.md");
        let failed = match done {
            Event::Known(Known::ToolFinished {
                reply,
                call_id,
                name,
                content,
                ..
            }) => k(Known::ToolFinished {
                reply,
                call_id,
                name,
                content,
                is_error: true,
                uncertain: false,
                images: Vec::new(),
                untrusted: false,
            }),
            other => other,
        };
        events.extend([step, failed, finished("r1")]);
        assert!(files(&events).is_empty());
    }
}
