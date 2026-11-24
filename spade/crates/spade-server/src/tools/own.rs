//! Spade's own tools: the ones the service builds before the engine exists, as opposed to the
//! ones [`super::with_engine_tools`] adds. One list, so `spade --tool-tokens` measures exactly
//! what a model is offered (spade/docs/harness.md, Tools).

use std::path::PathBuf;
use std::sync::Arc;

use spade_fetch::Fetcher;
use spade_search::Search;

use super::outward::{self, Host, Stage};
use super::{
    Asks, CardShow, DecisionLog, EngineHandle, SkillLibrary, SkillLoad, SkillSearch, TaskGoal,
    TaskPlan, TaskStatus, Todo, Tool, WebFetch, WebSearch,
};
use crate::learning::{Learning, SkillFeedback, SkillPropose};
use crate::media;
use crate::research::{LiveWeb, ResearchTool};
use crate::services::Services;
use crate::workspace::{Commands, Workspaces, workspace_tools};

/// What Spade's own tools are built from.
pub struct Own {
    pub search: Arc<Search>,
    pub fetcher: Arc<Fetcher>,
    pub workspaces: Workspaces,
    /// The engine, once it exists, for tools that reach it.
    pub bots: EngineHandle,
    /// Where a bot's commands run: its computer's terminal, or one at a time.
    pub commands: Commands,
    pub services: Arc<Services>,
    /// Where a push or a message is staged, outside the workspace (ADR 0171).
    pub outward_scratch: PathBuf,
    pub host: Arc<dyn Host>,
    pub stage: Arc<dyn Stage>,
    pub library: Arc<dyn SkillLibrary>,
    pub learning: Arc<Learning>,
}

/// Every tool Spade builds itself, in no particular order (the registry sorts by name).
pub fn own_tools(own: Own) -> Vec<Arc<dyn Tool>> {
    let Own {
        search,
        fetcher,
        workspaces,
        bots,
        commands,
        services,
        outward_scratch,
        host,
        stage,
        library,
        learning,
    } = own;
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(WebSearch {
            search: search.clone(),
            bots: bots.clone(),
        }),
        Arc::new(WebFetch::new(fetcher.clone()).with_workspaces(workspaces.clone(), bots.clone())),
        Arc::new(Todo),
        Arc::new(TaskStatus),
        Arc::new(TaskGoal),
        Arc::new(TaskPlan),
        Arc::new(DecisionLog),
        Arc::new(Asks),
        // Deep research (ADR 0135), reading through the same backends and fetcher.
        Arc::new(ResearchTool::new(
            Arc::new(LiveWeb {
                search: search.clone(),
                fetcher,
            }),
            workspaces.clone(),
            bots.clone(),
        )),
    ];
    tools.extend(workspace_tools(workspaces.clone(), bots.clone(), commands));
    // Bots' owned services (ADR 0160), through the same shell rules as `shell`.
    tools.extend(super::service_tools(&services));
    // Pushes, comments and messages with the person's sign-ins, outside the sandbox (ADR 0171).
    tools.extend(outward::outward_tools(
        workspaces.clone(),
        bots.clone(),
        host,
        stage,
        outward_scratch,
    ));
    tools.extend(media::tools::all(workspaces.clone(), bots.clone()));
    // Cards (ADR 0200 §5.1), whose image blocks name files in the bot's workspace.
    tools.push(Arc::new(CardShow::new(
        bots.clone(),
        Some(workspaces.clone()),
    )));
    tools.push(Arc::new(
        SkillSearch::new(library.clone()).with_uses(bots.clone()),
    ));
    tools.push(Arc::new(
        SkillLoad::new(library.clone())
            .with_notes(learning.clone(), bots.clone())
            .with_workspaces(workspaces, bots.clone()),
    ));
    tools.push(Arc::new(SkillPropose {
        learning: learning.clone(),
        bots: bots.clone(),
    }));
    tools.push(Arc::new(SkillFeedback { learning, bots }));
    tools
}
