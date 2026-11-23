// SPDX-License-Identifier: Apache-2.0
//! Tool calls (`native-content.ts`: tools). A tool seen running after its
//! execution ended is held as bookkeeping work until it settles.

use crate::translate::content::{ItemReconciled, edit_changes, tool_key};
use crate::translate::data::{
    RawPayload, arr, fields, get, n_in_fb, raw, s_in, slice_units, utf16_len,
};
use crate::translate::detail::{Detail, detail};
use crate::translate::state::{FileChange, NativeState, Out, StateError, Tool};
use serde::Serialize;
use serde_json::value::RawValue;
use serde_json::{Map, Value};

/// The exact command, path, and display fields a tool ran with.
#[derive(Serialize)]
pub(crate) struct ToolInput<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) command: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "filePath")]
    pub(crate) file_path: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workdir: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) cwd: Option<&'a str>,
    pub(crate) prompt: &'a str,
    pub(crate) agent: &'a str,
    pub(crate) background: bool,
}

/// A tool call's draft: what it ran, whether it finished, and its evidence.
#[derive(Serialize)]
struct ToolCall<'a> {
    kind: &'a str,
    title: &'a str,
    status: &'static str,
    detail: Detail<'a>,
    raw: Vec<RawPayload<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct ToolDraft<'a> {
    #[serde(rename = "type")]
    typ: &'static str,
    complete: bool,
    call: ToolCall<'a>,
}

/// Reconcile a tool call, holding it as work past its execution when live.
pub fn tool(
    state: &mut NativeState,
    typ: &str,
    session: &str,
    message: &str,
    p: &Map<String, Value>,
    evidence: &Value,
    out: &mut Out<'_>,
) -> Result<(), StateError> {
    let item = tool_key(session, message, s_in(p, "id"));
    let previous = match state.tools.get(&item) {
        Some(tool) => Some((tool.name.clone(), tool.created, tool.live)),
        None => state
            .recent_tools
            .get(&item)
            .map(|tool| (tool.name.clone(), tool.created, tool.live)),
    };
    let previous_input = match state.tools.get(&item) {
        Some(tool) => Some(tool.input.clone()),
        None => state.recent_tools.get(&item).map(|tool| tool.input.clone()),
    };
    let native = fields(get(p, "state"));
    let meta_value = match p.get("metadata") {
        Some(meta) if !matches!(meta, Value::Null) => meta.clone(),
        _ => get(native, "metadata").clone(),
    };
    let meta = fields(&meta_value);
    let name = if s_in(p, "name").is_empty() {
        previous
            .as_ref()
            .map(|(name, _, _)| name.clone())
            .unwrap_or_else(|| String::from("unknown"))
    } else {
        s_in(p, "name").to_owned()
    };
    let mut ended_input: Option<Value> = None;
    if typ == "session.tool.input.ended"
        && let Value::String(text) = get(p, "text")
        && !text.is_empty()
        && utf16_len(text) <= 65536
    {
        ended_input = serde_json::from_str(text).ok();
    }
    let supplied: Option<&Value> = p
        .get("input")
        .or_else(|| native.get("input"))
        .or(ended_input.as_ref());
    // The stored input: the previous one when nothing new arrived, else the
    // exact command, path, and display fields the tool ran with.
    let stored: String = match supplied {
        None => match previous_input {
            Some(input) => input.get().to_owned(),
            None => String::from("{}"),
        },
        Some(supplied) => {
            let source = fields(supplied);
            let command = match source.get("command") {
                Some(Value::String(command)) if utf16_len(command) <= 8192 => {
                    Some(command.as_str())
                }
                _ => None,
            };
            let path = s_in(source, "path");
            let resolved_path = if path.is_empty() {
                s_in(source, "filePath")
            } else {
                path
            };
            let file_path = if utf16_len(resolved_path) <= 4096 {
                Some(resolved_path)
            } else {
                None
            };
            let workdir = match source.get("workdir") {
                Some(Value::String(workdir)) => Some(workdir.as_str()),
                _ => None,
            };
            let cwd = match source.get("cwd") {
                Some(Value::String(cwd)) => Some(cwd.as_str()),
                _ => None,
            };
            let built = ToolInput {
                command,
                file_path,
                workdir,
                cwd,
                prompt: slice_units(s_in(source, "prompt"), 8192),
                agent: slice_units(s_in(source, "agent"), 256),
                background: matches!(source.get("background"), Some(Value::Bool(true))),
            };
            serde_json::to_string(&built)?
        }
    };
    let failed = typ.ends_with("failed") || s_in(native, "status") == "error";
    let complete = failed || typ == "session.tool.success" || s_in(native, "status") == "completed";
    if let Some((_, _, live)) = previous
        && !live
        && !complete
    {
        return Ok(());
    }
    let previous_created = previous.map(|(_, created, _)| created);
    let time = fields(get(p, "time"));
    let evidence_fields = fields(evidence);
    let created = previous_created.unwrap_or_else(|| {
        let evidence_created = n_in_fb(evidence_fields, "created", 9_007_199_254_740_991.0);
        n_in_fb(time, "created", evidence_created)
    });
    // A later frame without the metadata keeps the patches already seen.
    let previous_changes: Option<Vec<FileChange>> = state
        .tools
        .get(&item)
        .and_then(|tool| tool.changes.clone())
        .or_else(|| {
            state
                .recent_tools
                .get(&item)
                .and_then(|tool| tool.changes.clone())
        });
    let stored_fields_value: Value = serde_json::from_str(&stored).unwrap_or(Value::Null);
    let stored_fields = fields(&stored_fields_value);
    let changes = if name == "edit" || name == "write" {
        edit_changes(s_in(stored_fields, "filePath"), meta).or(previous_changes)
    } else {
        None
    };
    let current = Tool {
        session: session.to_owned(),
        message: message.to_owned(),
        name: name.clone(),
        input: match serde_json::from_str::<Box<RawValue>>(&stored) {
            Ok(input) => input,
            Err(_) => return Err(StateError::Emit),
        },
        live: !complete,
        created,
        changes: changes.clone(),
    };
    state.track_tool(&item, current)?;
    // The content lives on the event or its state, not both.
    let output = {
        let direct = get(p, "content");
        let blocks = if matches!(direct, Value::Null) {
            get(native, "content")
        } else {
            direct
        };
        arr(blocks)
            .iter()
            .map(|block| s_in(fields(block), "text"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let input_value: Value = serde_json::from_str(&stored).unwrap_or(Value::Null);
    let input_view = fields(&input_value);
    let tool_input = ToolInput {
        command: match input_view.get("command") {
            Some(Value::String(command)) => Some(command.as_str()),
            _ => None,
        },
        file_path: match input_view.get("filePath") {
            Some(Value::String(path)) => Some(path.as_str()),
            _ => None,
        },
        workdir: match input_view.get("workdir") {
            Some(Value::String(workdir)) => Some(workdir.as_str()),
            _ => None,
        },
        cwd: match input_view.get("cwd") {
            Some(Value::String(cwd)) => Some(cwd.as_str()),
            _ => None,
        },
        prompt: s_in(input_view, "prompt"),
        agent: s_in(input_view, "agent"),
        background: matches!(input_view.get("background"), Some(Value::Bool(true))),
    };
    let mut call_detail = detail(&name, &tool_input, changes);
    if matches!(call_detail, Detail::Shell { .. }) {
        call_detail = Detail::Shell {
            command: tool_input.command.unwrap_or(""),
            output,
        };
    }
    let failed_error = if failed {
        let from_p = get(p, "error");
        let from_native = get(native, "error");
        let error_value = if matches!(from_p, Value::Null) {
            from_native
        } else {
            from_p
        };
        let message = s_in(fields(error_value), "message");
        Some(if message.is_empty() {
            String::from("Tool failed")
        } else {
            message.to_owned()
        })
    } else {
        None
    };
    let (kind, status) = match &call_detail {
        Detail::Shell { .. } => ("shell", status_of(complete, failed, typ)),
        Detail::AgentSpawn { .. } => ("agent.spawn", status_of(complete, failed, typ)),
        Detail::FileRead { .. } => ("file.read", status_of(complete, failed, typ)),
        Detail::FileEdit { .. } => ("file.edit", status_of(complete, failed, typ)),
        Detail::Custom {} => ("custom", status_of(complete, failed, typ)),
    };
    let agent = state.key(session).to_owned();
    out.fact(&ItemReconciled {
        typ: "item.reconciled",
        agent: &agent,
        item: item.clone(),
        draft: ToolDraft {
            typ: "tool_call",
            complete,
            call: ToolCall {
                kind,
                title: &name,
                status,
                detail: call_detail,
                raw: vec![raw(typ, evidence, Some(&name))],
                error: failed_error,
            },
        },
    })?;
    // A tool seen running after its execution ended is held until it settles;
    // a tool inside a live execution is the execution's own work.
    if !complete && !state.active.contains_key(session) {
        state.tool_tail(&item, session, out)?;
    } else if complete {
        state.finish_background(
            &format!("work:{item}"),
            if failed { "failed" } else { "completed" },
            out,
        )?;
    }
    let child = s_in(meta, "sessionID").to_owned();
    if name == "subagent" && !child.is_empty() && !state.agents.contains_key(&child) {
        if state.child_claims.len() >= 1024 && !state.child_claims.contains_key(&child) {
            return Err(StateError::Limit("child evidence"));
        }
        state.child_claims.insert(
            child.clone(),
            crate::translate::state::ChildClaim {
                session: session.to_owned(),
                item: item.clone(),
                background: tool_input.background,
                created,
            },
        );
        state.background(
            &format!("proof:{child}"),
            session,
            "other",
            Some(&item),
            out,
        )?;
    }
    if name == "subagent"
        && !child.is_empty()
        && state
            .agents
            .get(&child)
            .is_some_and(|meta| meta.parent == session)
    {
        let agent = state.key(&child).to_owned();
        let parent = state.key(session).to_owned();
        out.fact(&crate::translate::agents::AgentLinked {
            typ: "agent.linked",
            agent: &agent,
            parent: Some(&parent),
            spawned_by: Some(&item),
            background: Some(tool_input.background),
            model: None,
        })?;
        if tool_input.background {
            state.child_dispatch(&child, session, &item, created, out)?;
        }
    }
    let shell = s_in(meta, "shellID");
    if name == "shell"
        && !shell.is_empty()
        && !(typ == "snapshot.tool" && complete && !state.shells.contains_key(shell))
    {
        if state.shells.len() >= 2048 && !state.shells.contains_key(shell) {
            return Err(StateError::Limit("shell"));
        }
        state.shells.insert(shell.to_owned(), session.to_owned());
        if tool_input.background || s_in(meta, "status") == "running" {
            state.wake_shells.insert(shell.to_owned());
        }
        state.background(
            &format!("shell:{shell}"),
            session,
            "shell",
            Some(&item),
            out,
        )?;
    }
    Ok(())
}

fn status_of(complete: bool, failed: bool, typ: &str) -> &'static str {
    if complete {
        if failed { "failed" } else { "succeeded" }
    } else if typ.ends_with("input.started") {
        "pending"
    } else {
        "running"
    }
}
