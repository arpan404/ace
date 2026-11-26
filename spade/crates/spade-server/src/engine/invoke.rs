//! The composer's `/` menu: the skills and commands a bot may be told to use, and a message that
//! starts one. Starting one is checked against what that bot may use now (a plugin's only if the
//! person turned it on for the bot), and its text is fixed in the stored message.

use serde::{Deserialize, Serialize};
use spade_core::event::Invoked;
use spade_core::invoke::{self, COMMAND, LONGEST_ARGS, SKILL};

use super::Engine;
use crate::tools::body_of;

/// A skill or command to start with a message, as the API takes it.
#[derive(Debug, Clone, Deserialize)]
pub struct InvokeRequest {
    /// `skill` or `command`.
    pub kind: String,
    /// Its id in the skill store.
    pub id: String,
    /// What the person wrote after it; the message's words when absent.
    #[serde(default)]
    pub args: Option<String>,
}

/// One row of the menu.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Invocable {
    pub kind: &'static str,
    pub id: String,
    pub name: String,
    pub description: String,
    /// Where it comes from: a plugin's name, `Spade`, `ace` or `Store`.
    pub source: String,
}

#[derive(Debug, thiserror::Error)]
pub enum InvokeError {
    #[error("no such conversation")]
    NotFound,
    #[error("{0}")]
    Refused(String),
    #[error("the skills could not be read: {0}")]
    Library(String),
}

impl Engine {
    /// The skills and commands the bot of conversation `id` may use now, skills first, each by
    /// name. Commands are the manual skills; a bot never loads those itself.
    pub async fn invocables(&self, id: &str) -> Result<Vec<Invocable>, InvokeError> {
        let agent = self.agent_of(id).ok_or(InvokeError::NotFound)?;
        let Some(library) = &self.skills else {
            return Ok(Vec::new());
        };
        let mut all = library
            .list_for(Some(&agent))
            .await
            .map_err(InvokeError::Library)?;
        all.sort_by(|a, b| a.name.cmp(&b.name));
        let row = |manual: bool| {
            all.iter()
                .filter(move |skill| skill.manual == manual)
                .map(move |skill| Invocable {
                    kind: if manual { COMMAND } else { SKILL },
                    id: skill.id.clone(),
                    name: skill.name.clone(),
                    description: skill.description.clone(),
                    source: library.origin_of(&skill.id).unwrap_or_default(),
                })
        };
        Ok(row(false).chain(row(true)).collect())
    }

    /// The skill or command `request` names, as the message will store it, refused unless the
    /// bot of conversation `id` may use it now.
    pub async fn resolve_invoke(
        &self,
        id: &str,
        request: &InvokeRequest,
        words: &str,
    ) -> Result<Invoked, InvokeError> {
        let manual = match request.kind.as_str() {
            COMMAND => true,
            SKILL => false,
            other => {
                return Err(InvokeError::Refused(format!(
                    "{other} is not a skill or command"
                )));
            }
        };
        let agent = self.agent_of(id).ok_or(InvokeError::NotFound)?;
        let library = self
            .skills
            .as_ref()
            .ok_or_else(|| InvokeError::Refused("this Spade keeps no skills".to_owned()))?;
        let all = library
            .list_for(Some(&agent))
            .await
            .map_err(InvokeError::Library)?;
        let skill = all
            .iter()
            .find(|skill| skill.id == request.id && skill.manual == manual)
            .ok_or_else(|| {
                InvokeError::Refused(format!(
                    "this bot may not use a {} with that id",
                    request.kind
                ))
            })?;
        let args = request.args.as_deref().unwrap_or(words).trim().to_owned();
        if args.chars().count() > LONGEST_ARGS {
            return Err(InvokeError::Refused(
                "the arguments are too long".to_owned(),
            ));
        }
        let text = library
            .read(&skill.id)
            .await
            .map_err(InvokeError::Library)?;
        let root = match (manual, library.origin_of(&skill.id), self.plugins()) {
            (true, Some(plugin), Some(plugins)) => plugins
                .for_agent(&agent)
                .into_iter()
                .find(|found| found.install.name == plugin)
                .map(|found| found.root.clone()),
            _ => None,
        };
        Ok(Invoked {
            kind: request.kind.clone(),
            id: skill.id.clone(),
            name: skill.name.clone(),
            args: (!args.is_empty()).then_some(args.clone()),
            text: invoke::render(&request.kind, body_of(&text), Some(&args), root.as_deref()),
        })
    }
}
