//! `skill_search` and `skill_load` over a [`SkillLibrary`] (ADR 0130, ADR 0151). Search ranks by
//! text and by the calling bot's use; loading a skill puts its files in the bot's workspace.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::skills;
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::skills::SkillLibrary;
use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::learning::Learning;
use crate::workspace::Workspaces;

/// Finds skills by describing a task, best first for the calling bot.
pub struct SkillSearch {
    library: Arc<dyn SkillLibrary>,
    bots: Option<EngineHandle>,
}

impl SkillSearch {
    pub fn new(library: Arc<dyn SkillLibrary>) -> Self {
        Self {
            library,
            bots: None,
        }
    }

    /// Breaks ties by how the calling bot used each skill.
    #[must_use]
    pub fn with_uses(mut self, bots: EngineHandle) -> Self {
        self.bots = Some(bots);
        self
    }
}

/// Loads a skill, with the calling bot's own note on it when it left one (ADR 0130), and puts its
/// files in the bot's workspace (ADR 0151).
pub struct SkillLoad {
    library: Arc<dyn SkillLibrary>,
    notes: Option<Arc<Learning>>,
    workspaces: Option<Workspaces>,
    bots: Option<EngineHandle>,
}

impl SkillLoad {
    pub fn new(library: Arc<dyn SkillLibrary>) -> Self {
        Self {
            library,
            notes: None,
            workspaces: None,
            bots: None,
        }
    }

    /// Shows each bot its notes from `skill_feedback` with the skills it loads.
    #[must_use]
    pub fn with_notes(mut self, learning: Arc<Learning>, bots: EngineHandle) -> Self {
        self.notes = Some(learning);
        self.bots = Some(bots);
        self
    }

    /// Puts a loaded skill's files in the calling bot's workspace, at `skills/<name>/`.
    #[must_use]
    pub fn with_workspaces(mut self, workspaces: Workspaces, bots: EngineHandle) -> Self {
        self.workspaces = Some(workspaces);
        self.bots = Some(bots);
        self
    }
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
}

#[derive(Deserialize)]
struct LoadArgs {
    name: String,
}

fn def(name: &str, description: &str, field: &str) -> ToolDef {
    ToolDef {
        spec: ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema: json!({ "type": "object",
                            "properties": { field: { "type": "string" } },
                            "required": [field] }),
        },
        risk: Risk::Read,
        untrusted_output: false,
        deferred: false,
        background: false,
    }
}

impl Tool for SkillSearch {
    fn def(&self) -> ToolDef {
        def(
            "skill_search",
            "Find skills (instructions for particular tasks) by describing the task. Returns names \
             and descriptions; load one with skill_load.",
            "query",
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let library = self.library.clone();
        let agent = self.bots.as_ref().and_then(|bots| bots.agent_for_key(key));
        Box::pin(async move {
            let args: SearchArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let all = match library.list().await {
                Ok(all) => all,
                Err(error) => {
                    return ToolOutput::error(format!("The skill library is unavailable: {error}"));
                }
            };
            let uses = agent.map(|a| library.uses(&a)).unwrap_or_default();
            let found = skills::search(&all, &args.query, 8, &uses);
            if found.is_empty() {
                return ToolOutput::ok("No skills matched. Try other words.");
            }
            let lines: Vec<String> = found
                .iter()
                .map(|s| format!("{}: {}", s.name, s.description))
                .collect();
            ToolOutput::ok(lines.join("\n"))
        })
    }
}

impl Tool for SkillLoad {
    fn def(&self) -> ToolDef {
        def(
            "skill_load",
            "Load a skill's full instructions by its name, then follow them. A skill's other \
             files (references, templates, scripts) are put in your workspace; the answer says \
             where.",
            "name",
        )
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let library = self.library.clone();
        let agent = self.bots.as_ref().and_then(|bots| bots.agent_for_key(key));
        let notes = self.notes.clone();
        let workspaces = self.workspaces.clone();
        Box::pin(async move {
            let args: LoadArgs = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let all = match library.list().await {
                Ok(all) => all,
                Err(error) => {
                    return ToolOutput::error(format!("The skill library is unavailable: {error}"));
                }
            };
            let Some(skill) = skills::find(&all, &args.name) else {
                return ToolOutput::error(format!(
                    "There is no skill named {}. Find skills with skill_search.",
                    args.name
                ));
            };
            let text = match library.read(&skill.id).await {
                Ok(text) => text,
                Err(error) => {
                    return ToolOutput::error(format!("Could not load {}: {error}", skill.name));
                }
            };
            let mut shown = format!("<skill name=\"{}\">\n{text}\n</skill>", skill.name);
            if let (Some(workspaces), Some(agent)) = (&workspaces, &agent) {
                shown.push_str(
                    &place_files(&*library, workspaces, agent, &skill.id, &skill.name).await,
                );
            }
            let note = notes
                .zip(agent.as_ref())
                .and_then(|(learning, agent)| learning.note_on(agent, &skill.name));
            // A note written after reading untrusted content brings it along.
            let untrusted = note.as_ref().is_some_and(|note| note.source.is_some());
            if let Some(note) = &note {
                shown.push_str(&note_line(note));
            }
            if let Some(agent) = &agent {
                library.record_load(agent, &skill.name);
            }
            let output = ToolOutput::ok(shown);
            if untrusted {
                output.untrusted()
            } else {
                output
            }
        })
    }
}

/// Puts the skill's files in the bot's workspace and answers what to tell the model about them:
/// nothing when the skill has none.
async fn place_files(
    library: &dyn SkillLibrary,
    workspaces: &Workspaces,
    agent: &str,
    id: &str,
    name: &str,
) -> String {
    let files = match library.files(id).await {
        Ok(files) if files.is_empty() => return String::new(),
        Ok(files) => files,
        Err(error) => return format!("\nIts other files could not be read: {error}"),
    };
    let (workspaces, agent, name) = (workspaces.clone(), agent.to_owned(), name.to_owned());
    let listed: Vec<String> = files
        .iter()
        .map(|f| {
            let runs = if f.executable { ", runnable" } else { "" };
            format!("- {} ({} bytes{runs})", f.path, f.bytes.len())
        })
        .collect();
    let placed = tokio::task::spawn_blocking(move || {
        workspaces
            .of(&agent)
            .and_then(|workspace| workspace.place_skill(&name, &files))
    })
    .await;
    match placed {
        Ok(Ok(folder)) => format!(
            "\nIts other files are in {folder}/ in your workspace, read only. Read them with \
             workspace_read; run its scripts with shell.\n{}",
            listed.join("\n")
        ),
        Ok(Err(error)) => format!("\nIts other files could not be put in your workspace: {error}"),
        Err(_) => "\nIts other files could not be put in your workspace.".to_owned(),
    }
}

/// The bot's own note on a skill, after the skill.
fn note_line(note: &crate::learning::Note) -> String {
    let said = if note.note.is_empty() {
        String::new()
    } else {
        format!(": {}", note.note)
    };
    match note.verdict {
        crate::learning::Verdict::Helpful => format!("\nYour note on it: helpful{said}"),
        crate::learning::Verdict::Outdated => format!(
            "\nYour note on it: outdated{said}. Mind that, and propose an edit with \
             skill_propose if you can fix it."
        ),
    }
}
