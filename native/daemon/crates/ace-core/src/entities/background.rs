// SPDX-License-Identifier: Apache-2.0
//! Background-task creation and refinement after its first provider report.

use crate::emit::{Event, emit, get, put};
use crate::entity_model::BackgroundTask;
use crate::item_model::RawPayload;
use crate::items::Item;
use crate::state::{ApplyContext, ThreadState};

/// The fields of one `background.started` fact.
pub struct BackgroundStarted<'a> {
    pub owner: Option<&'a str>,
    pub agent: &'a str,
    pub task: &'a str,
    pub kind: &'a str,
    pub title: &'a str,
    pub item: Option<&'a str>,
    pub child_agent: Option<&'a str>,
    pub ambient: Option<serde_json::Value>,
    pub internal: Option<bool>,
    pub stoppable: bool,
    pub output_path: Option<&'a str>,
    pub wakes_agent: Option<bool>,
    pub blocks_prompts: Option<bool>,
    pub ends_with_session: Option<bool>,
    pub raw: Vec<RawPayload>,
}

/// Start one background task, refining running work announced early.
#[allow(clippy::too_many_arguments)]
pub fn start_background(
    state: &mut ThreadState,
    fact: BackgroundStarted<'_>,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    if let Some(previous) = get(&state.tasks, fact.task)
        && previous.status == "running"
    {
        return refine_background(state, fact, ctx, events);
    }
    if fact.kind == "shell"
        && let Some(item_key) = fact.item
        && get(&state.items, item_key).is_some_and(|item| item.complete())
    {
        return Some(());
    }
    if let Some(previous) = get(&state.tasks, fact.task).cloned() {
        put(&mut state.task_history, previous.id.clone(), previous);
    }
    let record_id = {
        let record = crate::tree::ensure_agent(state, fact.agent, ctx, events)?;
        record.agent.id.clone()
    };
    let child_id = match fact.child_agent {
        Some(child) => {
            let record = crate::tree::ensure_agent(state, child, ctx, events)?;
            Some(record.agent.id.clone())
        }
        None => None,
    };
    let tool_call_id = match fact.item {
        None => None,
        Some(item_key) => {
            let item = match get(&state.items, item_key) {
                Some(item) => item.id().to_owned(),
                None => {
                    let draft = placeholder_tool_draft(fact.title, fact.kind, fact.child_agent);
                    crate::items::upsert_item(state, fact.agent, item_key, &draft, ctx, events)?
                        .id()
                        .to_owned()
                }
            };
            Some(item)
        }
    };
    let id = ctx.ids.next("task")?;
    let ambient = fact.ambient.unwrap_or(serde_json::Value::Bool(false));
    let task = BackgroundTask {
        id: id.clone(),
        agent_id: record_id,
        owner: fact.owner.map(str::to_owned),
        kind: fact.kind.to_owned(),
        title: fact.title.to_owned(),
        status: "running".to_owned(),
        ambient,
        internal: fact.internal,
        listening: None,
        blocks_prompts: fact.blocks_prompts,
        ends_with_session: fact.ends_with_session,
        wakes_agent: fact.wakes_agent,
        output_path: fact.output_path.map(str::to_owned),
        tool_call_id: tool_call_id.clone(),
        child_agent_id: child_id.clone(),
        stoppable: fact.stoppable,
        started_at: ctx.now,
        ended_at: None,
        raw: fact.raw,
        trailing: Vec::new(),
        extra: Default::default(),
    };
    state.uncertain_tasks.shift_remove(fact.task);
    put(&mut state.tasks, fact.task.to_owned(), task.clone());
    crate::indexes::refresh_task_index(state, fact.task);
    emit(events, Event::BackgroundTaskStarted { task: task.clone() });
    if let Some(tool_call_id) = tool_call_id
        && let Some(item) = state
            .items
            .values_mut()
            .find(|item| item.id() == tool_call_id)
    {
        if let Item::ToolCall { call, .. } = item {
            if call.background_task_id.is_none() {
                call.appended("backgroundTaskId");
            }
            call.background_task_id = Some(id);
        }
        let updated = item.clone();
        emit(events, Event::ItemUpdated { item: updated });
    }
    if let Some(child) = fact.child_agent {
        crate::tree::link_agent(
            state,
            &crate::facts::Fact::AgentLinked {
                agent: child.to_owned(),
                parent: Some(fact.agent.to_owned()),
                spawned_by: fact.item.map(str::to_owned),
                background: None,
                name: None,
                model: None,
            },
            ctx,
            events,
        )?;
    }
    Some(())
}

/// A placeholder tool call for a background task announced before its tool.
fn placeholder_tool_draft(
    title: &str,
    kind: &str,
    child_agent: Option<&str>,
) -> crate::json_io::Map {
    use crate::json_io::{Json, Map};
    let mut call = Map::new();
    call.insert("title".to_owned(), Json::from(title.to_owned()));
    call.insert("status".to_owned(), Json::from("running".to_owned()));
    if kind == "shell" {
        call.insert("kind".to_owned(), Json::from("shell".to_owned()));
        let mut detail = Map::new();
        detail.insert("kind".to_owned(), Json::from("shell".to_owned()));
        detail.insert("command".to_owned(), Json::from(String::new()));
        call.insert("detail".to_owned(), Json::Object(detail));
    } else if child_agent.is_some() {
        call.insert("kind".to_owned(), Json::from("agent.spawn".to_owned()));
        let mut detail = Map::new();
        detail.insert("kind".to_owned(), Json::from("agent.spawn".to_owned()));
        if let Some(child) = child_agent {
            detail.insert("childAgent".to_owned(), Json::from(child.to_owned()));
        }
        call.insert("detail".to_owned(), Json::Object(detail));
    } else {
        call.insert("kind".to_owned(), Json::from("custom".to_owned()));
        let mut detail = Map::new();
        detail.insert("kind".to_owned(), Json::from("custom".to_owned()));
        call.insert("detail".to_owned(), Json::Object(detail));
    }
    let mut draft = Map::new();
    draft.insert("type".to_owned(), Json::from("tool_call".to_owned()));
    draft.insert("call".to_owned(), Json::Object(call));
    draft
}

/// Re-announcing running work never restarts it.
fn refine_background(
    state: &mut ThreadState,
    fact: BackgroundStarted<'_>,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let record_id = {
        let record = crate::tree::ensure_agent(state, fact.agent, ctx, events)?;
        record.agent.id.clone()
    };
    let mut changed = false;
    if let Some(task) = state.tasks.get_mut(fact.task)
        && task.agent_id != record_id
    {
        task.agent_id = record_id;
        changed = true;
    }
    if let Some(child) = fact.child_agent {
        let child_id = {
            let record = crate::tree::ensure_agent(state, child, ctx, events)?;
            record.agent.id.clone()
        };
        if let Some(task) = state.tasks.get_mut(fact.task)
            && task.child_agent_id.is_none()
        {
            task.child_agent_id = Some(child_id);
            task.appended("childAgentId");
            changed = true;
        }
    }
    if let Some(item_key) = fact.item
        && let Some(item) = get(&state.items, item_key)
    {
        let item_id = item.id().to_owned();
        let is_tool = matches!(item, Item::ToolCall { .. });
        if is_tool {
            let needs_link = get(&state.tasks, fact.task)
                .and_then(|task| task.tool_call_id.clone())
                .is_none();
            if needs_link {
                if let Some(task) = state.tasks.get_mut(fact.task) {
                    task.tool_call_id = Some(item_id.clone());
                    task.appended("toolCallId");
                }
                if let Some(Item::ToolCall { call, .. }) = state.items.get_mut(item_key)
                    && let Some(task_id) = get(&state.tasks, fact.task).map(|task| task.id.clone())
                {
                    if call.background_task_id.is_none() {
                        call.appended("backgroundTaskId");
                    }
                    call.background_task_id = Some(task_id);
                }
                if let Some(item) = get(&state.items, item_key) {
                    emit(events, Event::ItemUpdated { item: item.clone() });
                }
                changed = true;
            }
        }
    }
    if let Some(output_path) = fact.output_path {
        let missing = get(&state.tasks, fact.task)
            .and_then(|task| task.output_path.clone())
            .is_none();
        if missing {
            if let Some(task) = state.tasks.get_mut(fact.task) {
                task.output_path = Some(output_path.to_owned());
                task.appended("outputPath");
            }
            changed = true;
        }
    }
    if fact.wakes_agent == Some(false) {
        let missing = get(&state.tasks, fact.task)
            .and_then(|task| task.wakes_agent)
            .is_none();
        if missing {
            if let Some(task) = state.tasks.get_mut(fact.task) {
                task.wakes_agent = Some(false);
                task.appended("wakesAgent");
            }
            changed = true;
        }
    }
    if fact.blocks_prompts == Some(true) {
        let missing = get(&state.tasks, fact.task)
            .and_then(|task| task.blocks_prompts)
            .is_none();
        if missing {
            if let Some(task) = state.tasks.get_mut(fact.task) {
                task.blocks_prompts = Some(true);
                task.appended("blocksPrompts");
            }
            changed = true;
        }
    }
    if fact.ends_with_session == Some(true) {
        let missing = get(&state.tasks, fact.task)
            .and_then(|task| task.ends_with_session)
            .is_none();
        if missing {
            if let Some(task) = state.tasks.get_mut(fact.task) {
                task.ends_with_session = Some(true);
                task.appended("endsWithSession");
            }
            changed = true;
        }
    }
    if !changed {
        return Some(());
    }
    if let Some(task) = get(&state.tasks, fact.task) {
        emit(events, Event::BackgroundTaskStarted { task: task.clone() });
    }
    if let Some(child) = fact.child_agent {
        crate::tree::link_agent(
            state,
            &crate::facts::Fact::AgentLinked {
                agent: child.to_owned(),
                parent: Some(fact.agent.to_owned()),
                spawned_by: fact.item.map(str::to_owned),
                background: None,
                name: None,
                model: None,
            },
            ctx,
            events,
        )?;
    }
    Some(())
}
