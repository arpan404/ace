//! The tools the engine adds to every bot's list, whatever it was given: the person's bots,
//! typed calls between them, a bot's own task, name and face, cards and notices, its notes,
//! knowledge and past episodes, routines, wakes, crews, workers and task lanes.
//!
//! Kept apart from `Engine::open` so the default bot's tool list can be built, and measured,
//! without an engine (spade/docs/harness.md, Tools).

use std::sync::Arc;

use super::{
    BotMessage, BotsList, CardShow, ClubAdd, ContractCall, ContractReturn, ContractsFind,
    EngineHandle, HelperTool, KnowledgeTool, MemoryTool, Notify, PackageSuggest, PanelUpdate,
    ProfileUpdate, TaskUpdate, Toolbox,
};

/// `tools` plus the engine's own tools, all keyed on `handle` (the engine, once it exists).
pub fn with_engine_tools(mut tools: Toolbox, handle: &EngineHandle) -> Toolbox {
    tools = tools
        .with_tool(Arc::new(BotsList(handle.clone())))
        .with_tool(Arc::new(BotMessage(handle.clone())))
        // Typed calls between the person's bots (ADR 0200 §7).
        .with_tool(Arc::new(ContractsFind(handle.clone())))
        .with_tool(Arc::new(ContractCall(handle.clone())))
        .with_tool(Arc::new(ContractReturn(handle.clone())))
        .with_tool(Arc::new(HelperTool(handle.clone())))
        // A bot's own task, name and face.
        .with_tool(Arc::new(TaskUpdate(handle.clone())))
        .with_tool(Arc::new(ProfileUpdate(handle.clone())))
        .with_tool(Arc::new(ClubAdd(handle.clone())));
    // `card_show` (ADR 0200 §5.1), unless Spade gave one that keeps images from workspaces.
    if tools.get(spade_core::card::CARD_SHOW).is_none() {
        tools = tools.with_tool(Arc::new(CardShow::new(handle.clone(), None)));
    }
    // `notify` and `package_suggest` (ADR 0200 §4.2, §8).
    tools = tools
        .with_tool(Arc::new(Notify(handle.clone())))
        .with_tool(Arc::new(PackageSuggest));
    // `panel_update` (ADR 0200 §5.2): the state a packaged bot's panel shows.
    tools = tools.with_tool(Arc::new(PanelUpdate(handle.clone())));
    for tool in MemoryTool::all(handle) {
        tools = tools.with_tool(tool);
    }
    // A bot's knowledge base and its past episodes (ADR 0164).
    for tool in KnowledgeTool::all(handle) {
        tools = tools.with_tool(tool);
    }
    let tools = crate::routines::with_tools(tools, handle);
    // `sleep_until`, `wait_for` and `wake_cancel` (ADR 0160).
    let tools = crate::tools::with_wake_tools(tools, handle);
    let tools = crate::teams::with_tools(tools, handle);
    // A bot's tools for its workers (ADR 0161).
    let tools = crate::tools::with_worker_tools(tools, handle);
    // Main's tools for its task lanes (ADR 0217).
    crate::tools::with_task_tools(tools, handle)
}
