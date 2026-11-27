// SPDX-License-Identifier: Apache-2.0
//! Tool call display details (`native-content.ts`: detail). The detail names
//! the tool's kind; a shell also carries its output.

use crate::translate::state::{ChangeKind, FileChange};
use crate::translate::tool::ToolInput;
use serde::Serialize;

/// A tool call's display detail, by native tool name.
#[derive(Serialize)]
#[serde(tag = "kind")]
pub(crate) enum Detail<'a> {
    #[serde(rename = "shell")]
    Shell { command: &'a str, output: String },
    #[serde(rename = "agent.spawn")]
    AgentSpawn {
        prompt: &'a ace_json::JsString,
        #[serde(rename = "agentType")]
        agent_type: &'a ace_json::JsString,
    },
    #[serde(rename = "file.read")]
    FileRead { path: &'a str },
    #[serde(rename = "file.edit")]
    FileEdit { changes: Vec<FileChange> },
    #[serde(rename = "custom")]
    Custom {},
}

pub(crate) fn detail<'a>(
    name: &str,
    input: &'a ToolInput<'_>,
    changes: Option<Vec<FileChange>>,
) -> Detail<'a> {
    if name == "shell" {
        return Detail::Shell {
            command: input.command.unwrap_or(""),
            output: String::new(),
        };
    }
    if name == "subagent" {
        return Detail::AgentSpawn {
            prompt: &input.prompt,
            agent_type: &input.agent,
        };
    }
    if name == "read" {
        return Detail::FileRead {
            path: input.file_path.unwrap_or(""),
        };
    }
    if name == "edit" || name == "write" {
        return Detail::FileEdit {
            changes: changes.unwrap_or_else(|| {
                vec![FileChange {
                    path: input.file_path.unwrap_or("").to_owned(),
                    kind: ChangeKind::Update,
                    diff: None,
                }]
            }),
        };
    }
    Detail::Custom {}
}
