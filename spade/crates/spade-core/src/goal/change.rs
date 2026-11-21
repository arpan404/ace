//! What a `task_goal` or `task_plan` call stores (ADR 0159), or why it is refused. The engine
//! answers these calls itself: the events to store and the call's result come from here, so the
//! bot is told exactly why a change didn't take.

use serde::Deserialize;
use serde_json::Value;

use super::{Author, Change, Criterion, Evidence, ItemStatus, NewItem, Task, resolved};
use crate::event::{Event, Known};
use crate::task::TASK_STATUS;

/// The longest goal title, criterion and item text.
const TEXT_CHARS: usize = 500;
/// The most criteria a goal has.
const MOST_CRITERIA: usize = 20;

/// What to store for an accepted call, and what the bot reads back.
#[derive(Debug, Clone, PartialEq)]
pub struct Accepted {
    pub events: Vec<Known>,
    pub result: String,
}

#[derive(Deserialize)]
struct GoalArgs {
    title: String,
    criteria: Vec<String>,
}

/// The bot drafts the goal. Refused while a goal is open: only the person changes that one.
/// `words` is what the person asked (their latest message, or the bot's task). `required` are
/// the package's `criterion` checks (ADR 0204 §3), which join the bot's criteria after them.
pub fn goal(
    events: &[Event],
    arguments: &Value,
    words: Option<&str>,
    required: &[String],
) -> Result<Accepted, String> {
    let args: GoalArgs = serde_json::from_value(arguments.clone())
        .map_err(|e| format!("task_goal needs a title and criteria: {e}"))?;
    let task = Task::fold(events);
    if let Some(open) = task.as_ref().filter(|t| t.goal.closed.is_none()) {
        return Err(format!(
            "A goal is already open (\"{}\") and only the person can change it. Work to its \
             criteria; if they no longer fit, tell the person.",
            open.goal.title
        ));
    }
    let title = text(&args.title, "the title")?;
    let criteria = criteria(&joined(&args.criteria, required))?;
    let id = format!("g{}", task.map_or(0, |t| t.goals) + 1);
    let text = words
        .map(str::trim)
        .filter(|w| !w.is_empty())
        .unwrap_or(&title)
        .to_owned();
    let listed: Vec<String> = criteria
        .iter()
        .map(|c| format!("{}. {}", c.id, c.text))
        .collect();
    Ok(Accepted {
        result: format!(
            "Goal set: {title}\nDone when:\n{}\nOnly the person can change these now. Plan the \
             work with task_plan; close each item with evidence. When you set task_status done, \
             a separate check reads your evidence against these criteria.",
            listed.join("\n")
        ),
        events: vec![Known::GoalSet {
            goal: id,
            title,
            text,
            criteria,
            by: Author::Bot,
            verifier: None,
            run: None,
        }],
    })
}

/// What a run of a routine whose trigger says `"verify": true` opens (ADR 0204 §3): a goal from
/// the routine's instruction with the package's `criterion` checks as its criteria (or, with
/// none, that the instruction was carried out), tied to run `run`, and the note the routine's
/// message carries so the bot knows. `None` while a goal is open: only the person replaces one.
pub fn routine_goal(
    events: &[Event],
    name: &str,
    instruction: &str,
    required: &[String],
    run: &str,
) -> Option<(Known, String)> {
    let task = Task::fold(events);
    if task.as_ref().is_some_and(|t| t.goal.closed.is_none()) {
        return None;
    }
    let lines: Vec<String> = if required.is_empty() {
        let asked: String = instruction.trim().chars().take(TEXT_CHARS - 40).collect();
        vec![format!("It did what the routine asks: {asked}")]
    } else {
        required.to_vec()
    };
    let criteria = criteria(&lines).ok()?;
    let listed: Vec<String> = criteria
        .iter()
        .map(|c| format!("{}. {}", c.id, c.text))
        .collect();
    let note = format!(
        "<goal>This run counts as done only once a separate check agrees. Done when:\n{}\nPlan \
         the work with task_plan, close each item with evidence, then set task_status done.</goal>",
        listed.join("\n")
    );
    let title: String = name.trim().chars().take(TEXT_CHARS).collect();
    let text: String = instruction.trim().chars().take(TEXT_CHARS).collect();
    Some((
        Known::GoalSet {
            goal: format!("g{}", task.map_or(0, |t| t.goals) + 1),
            title,
            text,
            criteria,
            by: Author::Bot,
            verifier: None,
            run: Some(run.to_owned()),
        },
        note,
    ))
}

/// The bot's criteria, then each of the package's it didn't already write.
pub fn joined(criteria: &[String], required: &[String]) -> Vec<String> {
    let mut all: Vec<String> = criteria.to_vec();
    for line in required {
        if !all.iter().any(|c| c.trim() == line.trim()) {
            all.push(line.clone());
        }
    }
    all
}

/// Criteria as the person or the bot wrote them, numbered.
pub fn criteria(texts: &[String]) -> Result<Vec<Criterion>, String> {
    if texts.is_empty() {
        return Err("A goal needs at least one criterion for done.".to_owned());
    }
    if texts.len() > MOST_CRITERIA {
        return Err(format!("A goal has at most {MOST_CRITERIA} criteria."));
    }
    texts
        .iter()
        .enumerate()
        .map(|(n, t)| {
            Ok(Criterion {
                id: (n + 1).to_string(),
                text: text(t, "a criterion")?,
            })
        })
        .collect()
}

fn text(raw: &str, what: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{what} is empty."));
    }
    if trimmed.chars().count() > TEXT_CHARS {
        return Err(format!("{what} is longer than {TEXT_CHARS} characters."));
    }
    Ok(trimmed.to_owned())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum PlanArgs {
    Add {
        text: String,
        #[serde(default)]
        parent: Option<String>,
    },
    Split {
        item: String,
        into: Vec<String>,
    },
    Start {
        item: String,
    },
    Done {
        item: String,
        #[serde(default)]
        evidence: Vec<Evidence>,
    },
    Blocked {
        item: String,
        #[serde(default)]
        reason: String,
    },
}

/// A change to the open goal's plan.
pub fn plan(events: &[Event], arguments: &Value) -> Result<Accepted, String> {
    let args: PlanArgs = serde_json::from_value(arguments.clone()).map_err(|e| {
        format!("task_plan needs op (add, split, start, done or blocked) and its fields: {e}")
    })?;
    let Some(task) = Task::fold(events).filter(|t| t.goal.closed.is_none()) else {
        return Err("There is no open goal: set one with task_goal first.".to_owned());
    };
    let goal = task.goal.id.clone();
    let change = match args {
        PlanArgs::Add { text: t, parent } => {
            if let Some(p) = &parent {
                existing(&task, p)?;
            }
            Change::Add {
                item: next_id(&task, parent.as_deref()),
                text: text(&t, "the item")?,
                parent,
            }
        }
        PlanArgs::Split { item, into } => {
            let parent = open_leaf(&task, &item)?;
            if into.len() < 2 {
                return Err("Split an item into at least two.".to_owned());
            }
            let mut made = Vec::new();
            let base = children(&task, &parent.id);
            for (n, t) in into.iter().enumerate() {
                made.push(NewItem {
                    item: format!("{}.{}", parent.id, base + n + 1),
                    text: text(t, "an item")?,
                });
            }
            Change::Split { item, into: made }
        }
        PlanArgs::Start { item } => {
            open_leaf(&task, &item)?;
            Change::Start { item }
        }
        PlanArgs::Blocked { item, reason } => {
            open_leaf(&task, &item)?;
            Change::Blocked {
                item,
                reason: text(&reason, "the reason it is blocked")?,
            }
        }
        PlanArgs::Done { item, evidence } => {
            open_leaf(&task, &item)?;
            if evidence.is_empty() {
                return Err(format!(
                    "Item {item} closes only with evidence: the id of a call whose result shows \
                     it (output), a file a call wrote or read (file), or a link (url)."
                ));
            }
            for e in &evidence {
                backed(events, e)?;
            }
            Change::Done { item, evidence }
        }
    };
    let mut after = task.clone();
    after.apply(&change);
    let mut events_out = vec![Known::PlanChanged {
        goal: goal.clone(),
        change: change.clone(),
    }];
    if let Change::Done { item, .. } = &change {
        let (total, closed, _) = after.counts();
        events_out.push(Known::PlanCheckpoint {
            goal,
            item: item.clone(),
            done: closed,
            total,
        });
    }
    Ok(Accepted {
        result: format!("Plan saved.\n{}", super::view::plan_lines(&after)),
        events: events_out,
    })
}

fn existing<'a>(task: &'a Task, id: &str) -> Result<&'a super::Item, String> {
    task.item(id)
        .ok_or_else(|| format!("There is no item {id} in the plan."))
}

/// An item that is the work itself and isn't done.
fn open_leaf<'a>(task: &'a Task, id: &str) -> Result<&'a super::Item, String> {
    let item = existing(task, id)?;
    if item.split {
        return Err(format!(
            "Item {id} was split; work on its parts, it closes with them."
        ));
    }
    if item.status == ItemStatus::Done {
        return Err(format!("Item {id} is already done."));
    }
    Ok(item)
}

fn children(task: &Task, parent: &str) -> usize {
    task.items
        .iter()
        .filter(|i| i.parent.as_deref() == Some(parent))
        .count()
}

fn next_id(task: &Task, parent: Option<&str>) -> String {
    match parent {
        Some(p) => format!("{p}.{}", children(task, p) + 1),
        None => (task.items.iter().filter(|i| i.parent.is_none()).count() + 1).to_string(),
    }
}

/// Evidence names something this conversation really has.
fn backed(events: &[Event], evidence: &Evidence) -> Result<(), String> {
    match evidence {
        Evidence::Output { call } => match result_of(events, call) {
            Found::Result(_) => Ok(()),
            Found::Running => Err(format!(
                "Call {call} has no result yet; name it once its result is in."
            )),
            Found::PlanCall => Err(format!(
                "Call {call} changed the plan or the task; evidence is a call whose result shows \
                 the work."
            )),
            Found::Missing => Err(format!("There is no call {call} in this conversation.")),
        },
        Evidence::File { path } => {
            if touching(events, path).next().is_some() {
                Ok(())
            } else {
                Err(format!(
                    "No call in this conversation wrote or read {path}. Read it back first, then \
                     name it."
                ))
            }
        }
        Evidence::Url { url } => {
            if url.starts_with("https://") || url.starts_with("http://") {
                Ok(())
            } else {
                Err(format!("{url} is not a web link."))
            }
        }
    }
}

/// What a call id refers to.
pub(crate) enum Found<'a> {
    /// The call's tool name and its stored result (a background job's own result).
    Result(Output<'a>),
    Running,
    PlanCall,
    Missing,
}

pub(crate) struct Output<'a> {
    pub name: &'a str,
    pub content: &'a str,
    pub is_error: bool,
}

/// The stored result of call `id`: a background job's own result when it moved to one.
pub(crate) fn result_of<'a>(events: &'a [Event], id: &str) -> Found<'a> {
    let mut tool: Option<Output<'a>> = None;
    let mut job_started = false;
    let mut job: Option<Output<'a>> = None;
    let mut called: Option<String> = None;
    for event in events {
        let Event::Known(known) = event else { continue };
        match known {
            Known::StepFinished { calls, .. } => {
                if let Some(c) = calls.iter().find(|c| c.id == id) {
                    called = Some(resolved(&c.name, &c.arguments).0);
                }
            }
            Known::ToolFinished {
                call_id,
                name,
                content,
                is_error,
                ..
            } if call_id == id => {
                tool = Some(Output {
                    name,
                    content,
                    is_error: *is_error,
                });
            }
            Known::JobStarted { job: j, .. } if j == id => job_started = true,
            Known::JobFinished {
                job: j,
                name,
                content,
                is_error,
                ..
            } if j == id => {
                job = Some(Output {
                    name,
                    content,
                    is_error: *is_error,
                });
            }
            _ => {}
        }
    }
    if let Some(name) = &called
        && (super::is_tool(name) || name == TASK_STATUS || name == "todo")
    {
        return Found::PlanCall;
    }
    match (job_started, job, tool) {
        (true, Some(job), _) => Found::Result(job),
        (true, None, _) => Found::Running,
        (false, _, Some(tool)) => Found::Result(tool),
        (false, _, None) if called.is_some() => Found::Running,
        _ => Found::Missing,
    }
}

/// The ids of calls whose arguments name `path` as one of their values, oldest first.
pub(crate) fn touching<'a>(events: &'a [Event], path: &'a str) -> impl Iterator<Item = &'a str> {
    events.iter().flat_map(move |event| {
        let calls: &[crate::event::Call] = match event {
            Event::Known(Known::StepFinished { calls, .. }) => calls,
            _ => &[],
        };
        calls.iter().filter_map(move |c| {
            let (name, arguments) = resolved(&c.name, &c.arguments);
            // A plan call naming the file is the claim, not the work.
            let work = !super::is_tool(&name) && name != TASK_STATUS && name != "todo";
            (work && names(&arguments, path)).then_some(c.id.as_str())
        })
    })
}

fn names(arguments: &Value, path: &str) -> bool {
    match arguments {
        Value::String(s) => s == path,
        Value::Array(values) => values.iter().any(|v| names(v, path)),
        Value::Object(map) => map.values().any(|v| names(v, path)),
        _ => false,
    }
}
