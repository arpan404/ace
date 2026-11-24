//! Portable starting knowledge and model choices. These carry no source records or credentials.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    knowledge,
    routine::INSTRUCTION_CHARS,
    routing::Role,
    rule::{self, Problem},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Page {
    pub topic: String,
    pub title: String,
    pub body: String,
    pub kind: PageKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PageKind {
    Playbook,
    Lesson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelClass {
    Fast,
    Capable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Heartbeat {
    pub every_minutes: u32,
    pub checklist: String,
}

fn field<T: serde::de::DeserializeOwned>(
    fields: &serde_json::Map<String, Value>,
    name: &str,
    valid: impl FnOnce(&T) -> bool,
    problems: &mut Vec<Problem>,
) -> Option<T> {
    let value = fields.get(name)?;
    match serde_json::from_value::<T>(value.clone()) {
        Ok(value) if valid(&value) => Some(value),
        _ => {
            problems.push(Problem::new(
                rule::FIELD,
                format!("{name} does not fit the package format"),
            ));
            None
        }
    }
}

pub(super) fn pages(
    fields: &serde_json::Map<String, Value>,
    problems: &mut Vec<Problem>,
) -> Vec<Page> {
    field(
        fields,
        "knowledge",
        |pages: &Vec<Page>| {
            pages.len() <= 32
                && pages.iter().all(|page| {
                    knowledge::topic(&page.topic).as_deref() == Some(&page.topic)
                        && !page.title.contains(['\r', '\n'])
                        && knowledge::title(&page.title).is_some()
                        && knowledge::body(&page.body).is_some()
                })
        },
        problems,
    )
    .unwrap_or_default()
}

pub(super) fn roles(
    fields: &serde_json::Map<String, Value>,
    problems: &mut Vec<Problem>,
) -> BTreeMap<String, ModelClass> {
    field(
        fields,
        "model_roles",
        |roles: &BTreeMap<String, ModelClass>| {
            roles.keys().all(|role| {
                Role::parse(role).is_some_and(|parsed| parsed.routed() && parsed.name() == role)
            })
        },
        problems,
    )
    .unwrap_or_default()
}

pub(super) fn commands(
    fields: &serde_json::Map<String, Value>,
    problems: &mut Vec<Problem>,
) -> BTreeMap<String, Vec<String>> {
    field(
        fields,
        "plugin_commands",
        |commands: &BTreeMap<String, Vec<String>>| {
            let plugins = fields.get("plugins").and_then(Value::as_array);
            commands.len() <= 16
                && commands.iter().all(|(name, commands)| {
                    name.starts_with("spade-plugin/")
                        && plugins.is_some_and(|items| items.iter().any(|item| item == name))
                        && commands.len() <= 64
                        && commands
                            .iter()
                            .all(|command| !command.trim().is_empty() && command.len() <= 120)
                })
        },
        problems,
    )
    .unwrap_or_default()
}

pub(super) fn heartbeat(
    fields: &serde_json::Map<String, Value>,
    problems: &mut Vec<Problem>,
) -> Option<Heartbeat> {
    field(
        fields,
        "heartbeat",
        |heartbeat: &Heartbeat| {
            (5..=1440).contains(&heartbeat.every_minutes)
                && !heartbeat.checklist.trim().is_empty()
                && heartbeat.checklist.chars().count() <= INSTRUCTION_CHARS
        },
        problems,
    )
}
