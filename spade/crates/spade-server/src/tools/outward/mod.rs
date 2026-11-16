//! Spade's typed outward tools (ADR 0171 decision 2): `git_push`, `pr_comment`, `issue_comment`
//! and `send_message`. Credentials never enter the sandbox, so what leaves the box with the
//! person's sign-in goes through one of these, outside it, with structured arguments. Each
//! declares `send_as_person` (`spade_core::effect`), so the gate sends it to the person unless a
//! grant of its own kind or their Always allow covers it.

mod git;
mod github;
pub mod host;
mod messages;

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};
use spade_core::effect::{GIT_PUSH, ISSUE_COMMENT, PR_COMMENT, SEND_MESSAGE};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::workspace::Workspaces;
pub use git::{SandboxStage, Stage, StageFuture, Staged, Staging};
pub use host::{Host, HostError, HostFuture, HostRan, Launch, SystemHost};

/// What the outward tools share.
#[derive(Clone)]
struct Outward {
    host: Arc<dyn Host>,
    /// Bundles a push inside the bot's sandbox.
    stage: Arc<dyn Stage>,
    workspaces: Workspaces,
    bots: EngineHandle,
    /// Spade's folder for the clean repositories and scripts each call makes.
    scratch: PathBuf,
}

/// The four tools, started through `host`, a push staged through `stage`.
pub fn outward_tools(
    workspaces: Workspaces,
    bots: EngineHandle,
    host: Arc<dyn Host>,
    stage: Arc<dyn Stage>,
    scratch: PathBuf,
) -> Vec<Arc<dyn Tool>> {
    let shared = Outward {
        host,
        stage,
        workspaces,
        bots,
        scratch,
    };
    [GIT_PUSH, PR_COMMENT, ISSUE_COMMENT, SEND_MESSAGE]
        .into_iter()
        .map(|name| {
            Arc::new(OutwardTool {
                name,
                shared: shared.clone(),
            }) as Arc<dyn Tool>
        })
        .collect()
}

struct OutwardTool {
    name: &'static str,
    shared: Outward,
}

fn spec(name: &str) -> (&'static str, Value) {
    match name {
        GIT_PUSH => (
            "Pushes one branch of a git repository in your workspace to its remote, with the \
             person's sign-in (commands in the sandbox can't). repo is the remote's \
             host/owner/name (owner/name for GitHub), which the remote's URL must match; remote \
             defaults to origin; path is the repository's folder in your workspace. The person decides unless they granted \
             pushes to that branch. Never force-pushes.",
            json!({ "type": "object",
                    "properties": {
                        "repo": { "type": "string", "description": "host/owner/name, or owner/name on GitHub" },
                        "branch": { "type": "string" },
                        "remote": { "type": "string" },
                        "path": { "type": "string" } },
                    "required": ["repo", "branch"] }),
        ),
        PR_COMMENT | ISSUE_COMMENT => (
            if name == PR_COMMENT {
                "Comments on a GitHub pull request in the person's name. The person decides \
                 unless they granted comments on that repository."
            } else {
                "Comments on a GitHub issue in the person's name. The person decides."
            },
            json!({ "type": "object",
                    "properties": {
                        "repo": { "type": "string", "description": "host/owner/name, or owner/name on GitHub" },
                        "number": { "type": "integer", "minimum": 1 },
                        "body": { "type": "string" } },
                    "required": ["repo", "number", "body"] }),
        ),
        _ => (
            "Sends a message from the person's Messages (to a phone number, email or handle) or \
             Mail (to an email address, with a subject) on this Mac. The person decides.",
            json!({ "type": "object",
                    "properties": {
                        "app": { "type": "string", "enum": ["messages", "mail"] },
                        "to": { "type": "string" },
                        "body": { "type": "string" },
                        "subject": { "type": "string" } },
                    "required": ["app", "to", "body"] }),
        ),
    }
}

impl Tool for OutwardTool {
    fn def(&self) -> ToolDef {
        let (description, schema) = spec(self.name);
        ToolDef {
            spec: ToolSpec {
                name: self.name.to_owned(),
                description: description.to_owned(),
                schema,
            },
            risk: Risk::Write,
            untrusted_output: false,
            deferred: true,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (shared, name, key) = (self.shared.clone(), self.name, key.to_owned());
        Box::pin(async move {
            let host = shared.host.as_ref();
            match name {
                GIT_PUSH => {
                    let args = match parse(arguments) {
                        Ok(args) => args,
                        Err(output) => return output,
                    };
                    let workspace = shared
                        .bots
                        .agent_for_key(&key)
                        .ok_or_else(|| "This conversation has no bot, so no workspace.".to_owned())
                        .and_then(|bot| shared.workspaces.of(&bot).map_err(|e| e.to_string()))
                        .and_then(|workspace| workspace.path().map_err(|e| e.to_string()));
                    match workspace {
                        Ok(workspace) => {
                            let stage = shared.stage.as_ref();
                            git::push(host, stage, &workspace, &shared.scratch, args).await
                        }
                        Err(why) => ToolOutput::error(why),
                    }
                }
                PR_COMMENT | ISSUE_COMMENT => {
                    let on = if name == PR_COMMENT {
                        github::On::PullRequest
                    } else {
                        github::On::Issue
                    };
                    match parse(arguments) {
                        Ok(args) => github::comment(host, &shared.scratch, on, args).await,
                        Err(output) => output,
                    }
                }
                _ => match parse(arguments) {
                    Ok(args) => messages::send(host, &shared.scratch, args).await,
                    Err(output) => output,
                },
            }
        })
    }
}

#[cfg(test)]
mod tests;
