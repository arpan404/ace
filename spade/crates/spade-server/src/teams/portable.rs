//! A bot as a file (ADR 0132): export, import, and duplicate (an export imported at once, with
//! the same model). The file holds what makes the bot: name, task, face, model, routines,
//! connector choices and its own notes. Never a key, token, webhook secret or conversation.

use std::collections::BTreeSet;
use std::sync::Arc;

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_connect::{Access, Connectors};
use spade_core::routine::Trigger;
use spade_store::{HEARTBEAT, Notes, ROUTINE};

use super::templates::templates;
use crate::engine::{AgentError, AgentInput, AgentView, AvatarInput, Engine, NoteScope};
use crate::routines::{self, By, HeartbeatInput, RoutineInput};

/// What one file may bring; anything past it is left out and said so.
const MOST_FILE_ROUTINES: usize = routines::MOST_ROUTINES + 1;
const MOST_FILE_NOTES: usize = 200;
const MOST_FILE_CONNECTORS: usize = 64;
const MOST_LEFT_OUT: usize = 20;

pub const FORMAT: &str = "spade-bot";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotFile {
    pub format: String,
    pub version: u32,
    pub name: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub avatar: Option<Value>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub routines: Vec<FileRoutine>,
    #[serde(default)]
    pub connectors: Option<FileConnectors>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRoutine {
    #[serde(default = "routine_kind")]
    pub kind: String,
    pub name: String,
    pub instruction: String,
    pub trigger: Value,
    #[serde(default)]
    pub time_zone: Option<String>,
    #[serde(default)]
    pub paused: bool,
}

fn routine_kind() -> String {
    ROUTINE.to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileConnectors {
    pub all: bool,
    #[serde(default)]
    pub connectors: Vec<String>,
}

/// A bot made from a file, and what of the file this machine couldn't take.
#[derive(Debug)]
pub struct Imported {
    pub agent: AgentView,
    pub left_out: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PortableError {
    #[error("no such agent")]
    NotFound,
    #[error("{0}")]
    Invalid(String),
    #[error(transparent)]
    Agent(#[from] AgentError),
    #[error("{0}")]
    Failed(String),
}

/// The bot `id` as a file.
pub fn export(
    engine: &Engine,
    connectors: Option<&Connectors>,
    id: &str,
) -> Result<BotFile, PortableError> {
    let fail = |e: &dyn std::fmt::Display| PortableError::Failed(e.to_string());
    let agent = engine
        .store()
        .agent(id)
        .map_err(|e| fail(&e))?
        .ok_or(PortableError::NotFound)?;
    let stored: Value = serde_json::from_str(&agent.avatar).unwrap_or(Value::Null);
    let avatar = match stored["kind"].as_str() {
        Some("image") => stored["sha256"]
            .as_str()
            .and_then(|sha| engine.image(sha))
            .map(|(bytes, media)| {
                let data = base64::engine::general_purpose::STANDARD.encode(bytes);
                json!({ "kind": "image", "data": format!("data:{media};base64,{data}") })
            }),
        Some("generated") => Some(json!({ "kind": "generated", "color": stored["color"] })),
        _ => None,
    };
    let mut kept = Vec::new();
    for kind in [ROUTINE, HEARTBEAT] {
        for r in engine.store().routines_of(id, kind).map_err(|e| fail(&e))? {
            kept.push(FileRoutine {
                kind: r.kind.clone(),
                name: r.name.clone(),
                instruction: r.instruction.clone(),
                trigger: serde_json::from_str(&r.trigger).unwrap_or(Value::Null),
                time_zone: Some(r.time_zone.clone()),
                paused: r.paused,
            });
        }
    }
    let connectors =
        connectors.map(
            |hub| match hub.access(id, agent.kind == crate::engine::MAIN) {
                Access::All => FileConnectors {
                    all: true,
                    connectors: Vec::new(),
                },
                Access::Only(ids) => FileConnectors {
                    all: false,
                    connectors: ids.into_iter().collect(),
                },
            },
        );
    let notes = engine
        .store()
        .notes(Notes::Own(id))
        .map_err(|e| fail(&e))?
        .into_iter()
        .filter(|n| !n.suggested)
        .map(|n| n.text)
        .collect();
    Ok(BotFile {
        format: FORMAT.to_owned(),
        version: VERSION,
        name: agent.name,
        task: agent.task,
        avatar,
        model: Some(agent.model),
        routines: kept,
        connectors,
        notes,
    })
}

/// Makes a new bot from a file.
pub fn import(
    engine: &Engine,
    connectors: Option<&Connectors>,
    file: BotFile,
) -> Result<Imported, PortableError> {
    if file.format != FORMAT || file.version != VERSION {
        return Err(PortableError::Invalid(
            "this is not a Spade bot file this version reads".to_owned(),
        ));
    }
    let mut left_out = Vec::new();
    let avatar = match &file.avatar {
        Some(a) if a["kind"] == "image" => match a["data"].as_str().map(crate::images::decode) {
            Some(Ok(bytes)) => Some(AvatarInput::Image(bytes)),
            _ => {
                left_out
                    .push("The picture couldn't be read; the bot has initials instead.".to_owned());
                None
            }
        },
        Some(a) if a["kind"] == "generated" => Some(AvatarInput::Generated(
            a["color"].as_str().map(str::to_owned),
        )),
        _ => None,
    };
    let default = engine.default_model();
    let wanted = file.model.clone().unwrap_or_else(|| default.clone());
    let input = |model: String| AgentInput {
        name: file.name.clone(),
        task: file.task.clone(),
        model,
        avatar: avatar.clone(),
    };
    let model = if wanted == default || engine.model_usable(&wanted) {
        wanted
    } else {
        let shown: String = wanted.chars().take(120).collect();
        left_out.push(format!(
            "The model {shown} isn't on this machine; the bot uses {default}."
        ));
        default
    };
    let agent = match engine.create_agent(input(model.clone())) {
        Err(AgentError::Image(_)) => {
            left_out.push(
                "The picture isn't an image Spade takes; the bot has initials instead.".to_owned(),
            );
            engine.create_agent(AgentInput {
                avatar: None,
                ..input(model)
            })?
        }
        made => made?,
    };
    let id = agent.agent.id.clone();
    for r in file.routines.iter().take(MOST_FILE_ROUTINES) {
        if let Err(why) = add_routine(engine, &id, r) {
            let name: String = r.name.chars().take(60).collect();
            left_out.push(format!("The routine {name:?} wasn't added: {why}"));
        }
    }
    if file.routines.len() > MOST_FILE_ROUTINES {
        left_out.push(format!(
            "{} routines past the first {MOST_FILE_ROUTINES} were left out.",
            file.routines.len() - MOST_FILE_ROUTINES
        ));
    }
    if let (Some(hub), Some(choice)) = (connectors, &file.connectors) {
        let access = if choice.all {
            Access::All
        } else {
            let here: BTreeSet<String> = hub.list().into_iter().map(|v| v.id).collect();
            let (kept, missing): (Vec<&String>, Vec<&String>) = choice
                .connectors
                .iter()
                .take(MOST_FILE_CONNECTORS)
                .partition(|c| here.contains(*c));
            for c in missing {
                let c: String = c.chars().take(64).collect();
                left_out.push(format!(
                    "The connector {c} isn't connected on this machine."
                ));
            }
            Access::Only(kept.into_iter().cloned().collect())
        };
        if let Err(why) = hub.set_access(&id, access) {
            left_out.push(format!("The connector choices weren't kept: {why}"));
        }
    } else if file.connectors.is_some() {
        left_out.push("Connectors aren't set up on this machine.".to_owned());
    }
    for note in file.notes.iter().take(MOST_FILE_NOTES) {
        if let Err(why) = engine.add_note(&NoteScope::Agent(id.clone()), note) {
            left_out.push(format!("A note wasn't kept: {why}"));
        }
    }
    if file.notes.len() > MOST_FILE_NOTES {
        left_out.push(format!(
            "{} notes past the first {MOST_FILE_NOTES} were left out.",
            file.notes.len() - MOST_FILE_NOTES
        ));
    }
    if left_out.len() > MOST_LEFT_OUT {
        let more = left_out.len() - MOST_LEFT_OUT + 1;
        left_out.truncate(MOST_LEFT_OUT - 1);
        left_out.push(format!("…and {more} more."));
    }
    let agent = engine
        .agent_view(&id)
        .map_err(|e| PortableError::Failed(e.to_string()))?
        .ok_or(PortableError::NotFound)?;
    Ok(Imported { agent, left_out })
}

fn add_routine(engine: &Engine, agent: &str, r: &FileRoutine) -> Result<(), String> {
    let trigger: Trigger = serde_json::from_value(r.trigger.clone()).map_err(|e| e.to_string())?;
    if let Trigger::Heartbeat {
        every_minutes,
        quiet,
    } = trigger
    {
        routines::set_heartbeat(
            engine,
            agent,
            HeartbeatInput {
                enabled: Some(!r.paused),
                every_minutes: Some(every_minutes),
                checklist: Some(r.instruction.clone()),
                quiet: Some(quiet),
                time_zone: r.time_zone.clone(),
            },
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    routines::create(
        engine,
        agent,
        RoutineInput {
            name: Some(r.name.clone()),
            instruction: Some(r.instruction.clone()),
            trigger: Some(trigger),
            time_zone: r.time_zone.clone(),
            paused: Some(r.paused),
        },
        By::Person,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// A new bot like `id`: task, face, model, routines, connector choices and notes, never its
/// conversation. Named `name`, else `<name> copy`.
pub fn duplicate(
    engine: &Engine,
    connectors: Option<&Connectors>,
    id: &str,
    name: Option<String>,
) -> Result<AgentView, PortableError> {
    let mut file = export(engine, connectors, id)?;
    file.name = match name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()) {
        Some(name) => name,
        None => copy_name(&file.name),
    };
    let imported = import(engine, connectors, file)?;
    if !imported.left_out.is_empty() {
        tracing::warn!(left_out = ?imported.left_out, "a duplicate left something out");
    }
    Ok(imported.agent)
}

fn copy_name(name: &str) -> String {
    let suffix = " copy";
    let room = crate::engine::NAME_CHARS.saturating_sub(suffix.len());
    let base: String = name.chars().take(room).collect();
    format!("{base}{suffix}")
}

/// A bot from template `template`: its name, task and colour unless the person gave their own,
/// the fast model for a fast template, and its routines in `time_zone`.
pub fn from_template(
    engine: &Engine,
    template: &str,
    mut input: AgentInput,
    named: bool,
    time_zone: Option<String>,
) -> Result<Imported, PortableError> {
    let template = templates()
        .iter()
        .find(|t| t.id == template)
        .ok_or(PortableError::NotFound)?;
    if !named {
        input.name = template.name.clone();
    }
    if input.task.trim().is_empty() {
        input.task = template.task.clone();
    }
    if input.avatar.is_none() {
        input.avatar = Some(AvatarInput::Generated(Some(template.color.clone())));
    }
    let agent = engine.create_agent(input)?;
    let id = agent.agent.id.clone();
    let mut left_out = Vec::new();
    for r in &template.routines {
        let made = routines::create(
            engine,
            &id,
            RoutineInput {
                name: Some(r.name.clone()),
                instruction: Some(r.instruction.clone()),
                trigger: Some(Trigger::Schedule {
                    schedule: r.schedule.clone(),
                }),
                time_zone: time_zone.clone(),
                paused: Some(false),
            },
            By::Person,
        );
        if let Err(why) = made {
            left_out.push(format!("The routine {:?} wasn't added: {why}", r.name));
        }
    }
    let agent = engine
        .agent_view(&id)
        .map_err(|e| PortableError::Failed(e.to_string()))?
        .ok_or(PortableError::NotFound)?;
    Ok(Imported { agent, left_out })
}

/// The model a template suggests: the person's fast model for a fast template, else the default.
pub fn template_model(engine: &Arc<Engine>, template: &str) -> Option<String> {
    let template = templates().iter().find(|t| t.id == template)?;
    if template.model_kind == "fast"
        && let Ok(Some(fast)) = engine.fast_model()
    {
        return Some(fast);
    }
    Some(engine.default_model())
}
