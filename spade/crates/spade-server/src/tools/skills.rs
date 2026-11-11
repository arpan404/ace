//! The person's skill library (ace's, through spade-ace) as two tools: `skill_search` and
//! `skill_load`. The library is reached through [`SkillLibrary`] so tests can supply their own.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_ace::AceSkills;
use spade_core::skills::{self, SkillEntry};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, parse};

pub type LibraryFuture<T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send>>;

/// Where skills come from.
pub trait SkillLibrary: Send + Sync {
    /// Every skill, with its id.
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>>;
    /// The full SKILL.md text of the skill with `id`.
    fn read(&self, id: &str) -> LibraryFuture<String>;
}

/// ace's skill library: personal, plugin and builtin skills.
pub struct AceLibrary(pub Arc<AceSkills>);

impl SkillLibrary for AceLibrary {
    fn list(&self) -> LibraryFuture<Vec<SkillEntry>> {
        let skills = self.0.clone();
        Box::pin(async move {
            let list = skills.list(None).await.map_err(|e| e.to_string())?;
            Ok(list
                .skills
                .into_iter()
                .map(|s| SkillEntry {
                    id: s.id,
                    name: s.name,
                    description: s.description,
                    manual: s.manual,
                })
                .collect())
        })
    }

    fn read(&self, id: &str) -> LibraryFuture<String> {
        let (skills, id) = (self.0.clone(), id.to_owned());
        Box::pin(async move {
            skills
                .read(&id, None)
                .await
                .map(|s| s.text)
                .map_err(|e| e.to_string())
        })
    }
}

pub struct SkillSearch(pub Arc<dyn SkillLibrary>);
pub struct SkillLoad(pub Arc<dyn SkillLibrary>);

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

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let library = self.0.clone();
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
            let found = skills::search(&all, &args.query, 8);
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
            "Load a skill's full instructions by its name, then follow them.",
            "name",
        )
    }

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let library = self.0.clone();
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
            match library.read(&skill.id).await {
                Ok(text) => {
                    ToolOutput::ok(format!("<skill name=\"{}\">\n{text}\n</skill>", skill.name))
                }
                Err(error) => ToolOutput::error(format!("Could not load {}: {error}", skill.name)),
            }
        })
    }
}
