// SPDX-License-Identifier: Apache-2.0
//! The interaction and background-task rows of `entities.ts`: opening and
//! closing interactions, starting and ending background work, with the refine
//! path for work announced before its spawn is known.

use crate::emit::{Event, emit, get, put};
use crate::entity_model::{BackgroundTask, Interaction, InteractionRequest, InteractionResolution};
use crate::item_model::RawPayload;
use crate::items::Item;
use crate::state::{ApplyContext, ThreadState};

/// Open one interaction.
#[allow(clippy::too_many_arguments)]
pub fn open_interaction(
    state: &mut ThreadState,
    agent_key: &str,
    interaction_key: &str,
    blocking: bool,
    mut request: InteractionRequest,
    item_key: Option<&str>,
    raw: Vec<RawPayload>,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    // Redacted approvals replace their raw capture (which echoes the private
    // input) with a marker, exactly as the TypeScript fold does.
    let raw = if crate::ace_tools::redact_ace_approval(&mut request) {
        let mut marker = crate::json_io::Map::new();
        marker.insert("redacted".to_owned(), crate::json_io::Json::Bool(true));
        vec![RawPayload::Inline {
            payload_type: "ace.private-input".to_owned(),
            name: None,
            data: ace_json::Raw::from_value(&crate::json_io::Json::Object(marker)),
        }]
    } else {
        raw
    };
    if get(&state.interactions, interaction_key).is_some_and(|previous| previous.state == "pending")
    {
        return Some(());
    }
    if let Some(previous) = get(&state.interactions, interaction_key).cloned() {
        put(
            &mut state.interaction_history,
            previous.id.clone(),
            previous,
        );
    }
    let record_id = {
        let record = crate::tree::ensure_agent(state, agent_key, ctx, events)?;
        record.agent.id.clone()
    };
    let tool_call_id = match item_key {
        None => None,
        Some(item_key) => {
            let item = match get(&state.items, item_key) {
                Some(item) => item.id().to_owned(),
                None => {
                    let mut draft = crate::json_io::Map::new();
                    draft.insert(
                        "type".to_owned(),
                        crate::json_io::Json::from("tool_call".to_owned()),
                    );
                    let mut call = crate::json_io::Map::new();
                    call.insert(
                        "kind".to_owned(),
                        crate::json_io::Json::from("ask_user".to_owned()),
                    );
                    call.insert(
                        "title".to_owned(),
                        crate::json_io::Json::from("Awaiting input".to_owned()),
                    );
                    call.insert(
                        "status".to_owned(),
                        crate::json_io::Json::from("awaiting_approval".to_owned()),
                    );
                    let mut detail = crate::json_io::Map::new();
                    detail.insert(
                        "kind".to_owned(),
                        crate::json_io::Json::from("ask_user".to_owned()),
                    );
                    call.insert("detail".to_owned(), crate::json_io::Json::Object(detail));
                    draft.insert("call".to_owned(), crate::json_io::Json::Object(call));
                    crate::items::upsert_item(state, agent_key, item_key, &draft, ctx, events)?
                        .id()
                        .to_owned()
                }
            };
            Some(item)
        }
    };
    let id = ctx.ids.next("interaction")?;
    let interaction = Interaction {
        id: id.clone(),
        thread_id: state.thread_id.clone(),
        agent_id: record_id,
        tool_call_id,
        blocking,
        request,
        state: "pending".to_owned(),
        expiration_reason: None,
        resolution: None,
        resolved_by: None,
        auto_reviewed: None,
        created_at: ctx.now,
        closed_at: None,
        raw,
    };
    put(
        &mut state.interactions,
        interaction_key.to_owned(),
        interaction.clone(),
    );
    crate::indexes::refresh_interaction_index(state, interaction_key);
    emit(events, Event::InteractionOpened { interaction });
    Some(())
}

/// Close one interaction.
#[allow(clippy::too_many_arguments)]
pub fn close_interaction(
    state: &mut ThreadState,
    interaction_key: &str,
    close_state: String,
    resolution: Option<InteractionResolution>,
    resolved_by: Option<String>,
    auto_reviewed: Option<bool>,
    now: i64,
    events: &mut Vec<Event>,
) -> Option<()> {
    let pending = get(&state.interactions, interaction_key)
        .is_some_and(|interaction| interaction.state == "pending");
    if !pending {
        return Some(());
    }
    if let Some(interaction) = state.interactions.get_mut(interaction_key) {
        interaction.state = close_state.clone();
        interaction.closed_at = Some(now);
        if let Some(resolution) = resolution.clone() {
            interaction.resolution = Some(resolution);
        }
        if let Some(resolved_by) = resolved_by.clone() {
            interaction.resolved_by = Some(resolved_by);
        }
        if let Some(auto_reviewed) = auto_reviewed {
            interaction.auto_reviewed = Some(auto_reviewed);
        }
    }
    crate::indexes::refresh_interaction_index(state, interaction_key);
    let interaction = get(&state.interactions, interaction_key)?;
    emit(
        events,
        Event::InteractionClosed {
            interaction_id: interaction.id.clone(),
            state: close_state,
            closed_at: now,
            resolution,
            resolved_by,
            auto_reviewed,
        },
    );
    Some(())
}

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
                }
                if let Some(Item::ToolCall { call, .. }) = state.items.get_mut(item_key)
                    && let Some(task_id) = get(&state.tasks, fact.task).map(|task| task.id.clone())
                {
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

/// The ports a running task's processes listen on now.
pub fn listen_background(
    state: &mut ThreadState,
    task_key: &str,
    ports: Vec<i64>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let running = get(&state.tasks, task_key).is_some_and(|task| task.status == "running");
    if !running {
        return Some(());
    }
    let mut ports = ports;
    ports.sort_unstable();
    ports.dedup();
    let known: Vec<i64> = get(&state.tasks, task_key)
        .and_then(|task| task.listening.clone())
        .unwrap_or_default();
    if ports.len() == known.len() && ports.iter().zip(known.iter()).all(|(a, b)| a == b) {
        return Some(());
    }
    if let Some(task) = state.tasks.get_mut(task_key) {
        if ports.is_empty() {
            task.listening = None;
        } else {
            task.listening = Some(ports);
        }
    }
    if let Some(task) = get(&state.tasks, task_key) {
        emit(events, Event::BackgroundTaskStarted { task: task.clone() });
    }
    Some(())
}

/// Only ace's own running task waits on the person.
pub fn wait_background(state: &mut ThreadState, task_key: &str, waiting: bool) {
    let ace_owned = get(&state.tasks, task_key)
        .is_some_and(|task| task.status == "running" && task.owner.as_deref() == Some("ace"));
    if !ace_owned {
        return;
    }
    if waiting {
        let people = state.person_tasks.get_or_insert_with(Default::default);
        put(people, task_key.to_owned(), true);
    } else if let Some(people) = state.person_tasks.as_mut() {
        people.shift_remove(task_key);
    }
}

/// End one background task.
pub fn end_background(
    state: &mut ThreadState,
    task_key: &str,
    status: &str,
    uncertain: bool,
    now: i64,
    events: &mut Vec<Event>,
) -> Option<()> {
    if get(&state.tasks, task_key).is_none() {
        return Some(());
    }
    let task = get(&state.tasks, task_key)?.clone();
    let flagged = task.status == "unknown"
        && state
            .uncertain_tasks
            .get(task_key)
            .is_some_and(|held| *held);
    // A task ace lost track of takes later terminal evidence; its end time
    // stays when it was lost.
    let lost = task.status == "unknown" && !flagged && status != "unknown";
    if task.status != "running" && !flagged && !lost {
        return Some(());
    }
    if let Some(people) = state.person_tasks.as_mut() {
        people.shift_remove(task_key);
    }
    if uncertain {
        put(&mut state.uncertain_tasks, task_key.to_owned(), true);
    } else {
        state.uncertain_tasks.shift_remove(task_key);
    }
    let ended_at = if lost { task.ended_at } else { Some(now) };
    if let Some(task) = state.tasks.get_mut(task_key) {
        task.status = status.to_owned();
        task.ended_at = ended_at;
    }
    crate::indexes::refresh_task_index(state, task_key);
    if let Some(task) = get(&state.tasks, task_key) {
        let id = task.id.clone();
        emit(
            events,
            Event::BackgroundTaskUpdated {
                task_id: id,
                status: status.to_owned(),
                ended_at,
            },
        );
    }
    Some(())
}
