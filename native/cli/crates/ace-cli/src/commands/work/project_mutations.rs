// SPDX-License-Identifier: Apache-2.0
//! `ace project add|rename|remove` in Rust: durable workspace commands.
//!
//! Only `cli.request`/`projects.request` plus the durable outbox; thread lists (client
//! selections) never come near these. `--remote` stays on the bundle, as do all other work ids.

use std::io::Write;

use cli_out::{ErrorCode, Failure, Out, Outcome};
use cli_parse::Parsed;
use serde::Deserialize;

use super::common::{mode, timeout_duration, wire_failure};
use super::durable::{durable_command, emit_receipt, idempotency_key};
use crate::run::fail;

#[derive(Deserialize)]
struct ProjectsEnvelope<'a> {
    #[serde(borrow)]
    result: &'a serde_json::value::RawValue,
}

#[derive(Clone, Debug)]
struct Project {
    id: String,
    name: String,
    path: String,
}

pub fn run_add<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let mode = mode(parsed);
    // The folder; this one when omitted, as `projectPath()` does.
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let given = parsed.words.first().copied();
    let path = resolve_add_path(given, &cwd);
    let key = match idempotency_key(&parsed.flags) {
        Ok(key) => key,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let payload = serde_json::json!({"type": "workspace.add", "path": path});
    match durable_command(&parsed.flags, &payload, "project.add", timeout) {
        Ok(receipt) => {
            if receipt.get("workspace").is_none() {
                let mut admission = receipt.clone();
                if let Some(map) = admission.as_object_mut() {
                    map.insert(
                        "idempotencyKey".to_owned(),
                        serde_json::Value::String(key.clone()),
                    );
                }
                let mut failure = Failure::new(
                    Outcome::Uncertain,
                    "Project registration returned no identity",
                )
                .with_code(ErrorCode::Uncertain)
                .with_command("project.add");
                failure.admission = Some(admission);
                return fail(out, err, Some(&parsed.flags), &failure);
            }
            let workspace = receipt.get("workspace");
            let human = match workspace {
                Some(value) => {
                    let name = value
                        .get("name")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let at = value
                        .get("path")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    if name.is_empty() && at.is_empty() {
                        vec!["Added.".to_owned()]
                    } else {
                        vec![format!("Added {name} ({at}).")]
                    }
                }
                None => vec!["Added.".to_owned()],
            };
            match emit_receipt(out, mode, receipt, &key, None, &human, "project.add") {
                Ok(outcome) => outcome,
                Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
            }
        }
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

fn resolve_add_path(given: Option<&str>, cwd: &std::path::Path) -> String {
    match given {
        Some(value) => {
            let path = std::path::Path::new(value);
            if path.is_absolute() {
                value.to_owned()
            } else {
                cwd.join(path).to_string_lossy().into_owned()
            }
        }
        None => cwd.to_string_lossy().into_owned(),
    }
}

pub fn run_rename<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let mode = mode(parsed);
    let given = parsed.words.first().copied().unwrap_or("");
    let name = parsed.words.get(1).copied().unwrap_or("");
    if let Err(failure) = check_project_name(name) {
        return fail(out, err, Some(&parsed.flags), &failure);
    }
    let mut conn = match super::common::connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let projects = match read_projects(&mut conn, timeout) {
        Ok(projects) => projects,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let project = match find_project(&projects, given, &cwd) {
        Ok(project) => project,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    drop(conn);
    let payload =
        serde_json::json!({"type": "workspace.rename", "workspaceId": project.id, "name": name});
    let key = match idempotency_key(&parsed.flags) {
        Ok(key) => key,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    match durable_command(&parsed.flags, &payload, "project.rename", timeout) {
        Ok(receipt) => {
            let human = vec![format!("Renamed {} to {name}.", project.name)];
            match emit_receipt(out, mode, receipt, &key, None, &human, "project.rename") {
                Ok(outcome) => outcome,
                Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
            }
        }
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

pub fn run_remove<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    let timeout = match timeout_duration(&parsed.flags) {
        Ok(timeout) => timeout,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let mode = mode(parsed);
    let given = parsed.words.first().copied().unwrap_or("");
    let mut conn = match super::common::connect(&parsed.flags, timeout) {
        Ok(conn) => conn,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let projects = match read_projects(&mut conn, timeout) {
        Ok(projects) => projects,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let project = match find_project(&projects, given, &cwd) {
        Ok(project) => project,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    drop(conn);
    let stop = parsed.flags.on("stop-threads");
    let payload = serde_json::json!({
        "type": "workspace.remove",
        "workspaceId": project.id,
        "stopRunning": stop,
    });
    let key = match idempotency_key(&parsed.flags) {
        Ok(key) => key,
        Err(failure) => return fail(out, err, Some(&parsed.flags), &failure),
    };
    match durable_command(&parsed.flags, &payload, "project.remove", timeout) {
        Ok(receipt) => {
            let human = vec![format!(
                "Stopped tracking {}; its files stay in {}.",
                project.name, project.path
            )];
            match emit_receipt(out, mode, receipt, &key, None, &human, "project.remove") {
                Ok(outcome) => outcome,
                Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
            }
        }
        Err(failure) => fail(out, err, Some(&parsed.flags), &failure),
    }
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn check_project_name(name: &str) -> Result<(), Failure<'static>> {
    if name.is_empty()
        || name.len() > 256
        || name.bytes().any(|b| matches!(b, b'/' | b'\\') || b < 0x20)
        || name.trim() != name
        || name == "."
        || name == ".."
        || name.ends_with('.')
    {
        return Err(Failure::usage(
            "An argument isn't in the form ace expects: a project name is one folder name.",
        )
        .with_code(ErrorCode::BadArgument)
        .with_argument("NAME")
        .with_hint("See ace help project rename."));
    }
    Ok(())
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn read_projects(
    conn: &mut cli_wire::Connection,
    timeout: std::time::Duration,
) -> Result<Vec<Project>, Failure<'static>> {
    let mut projects = Vec::new();
    let mut after: Option<String> = None;
    for _ in 0..5 {
        let page = project_page(conn, timeout, after.as_deref())?;
        for entry in page.projects {
            projects.push(entry);
        }
        if let Some(next) = page.next {
            after = Some(next);
        } else {
            break;
        }
    }
    Ok(projects)
}

struct ProjectPage {
    projects: Vec<Project>,
    next: Option<String>,
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn project_page(
    conn: &mut cli_wire::Connection,
    timeout: std::time::Duration,
    after: Option<&str>,
) -> Result<ProjectPage, Failure<'static>> {
    #[derive(serde::Serialize)]
    struct Operation<'a> {
        op: &'static str,
        limit: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        after: Option<&'a str>,
    }
    #[derive(serde::Serialize)]
    struct ProjectsRequest<'a> {
        #[serde(rename = "type")]
        msg_type: &'static str,
        operation: Operation<'a>,
    }
    let request = ProjectsRequest {
        msg_type: "projects.request",
        operation: Operation {
            op: "workspace.list",
            limit: 100,
            after,
        },
    };
    let reply = conn
        .request_with_timeout(&request, timeout)
        .map_err(|err| wire_failure(&err, None))?;
    let envelope: ProjectsEnvelope<'_> = reply.decode().map_err(|err| wire_failure(&err, None))?;
    let value: serde_json::Value =
        serde_json::from_str(envelope.result.get()).map_err(|_| project_unavailable())?;
    if value.get("kind").and_then(serde_json::Value::as_str) != Some("projects") {
        if value.get("kind").and_then(serde_json::Value::as_str) == Some("error") {
            let code = value
                .get("code")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if code == "forbidden" {
                return Err(Failure::new(
                    Outcome::Refused,
                    "This device may not read the project list.",
                )
                .with_code(ErrorCode::Forbidden));
            }
        }
        return Err(project_unavailable());
    }
    let empty = Vec::new();
    let list = value
        .get("projects")
        .and_then(serde_json::Value::as_array)
        .unwrap_or(&empty);
    let mut projects = Vec::with_capacity(list.len());
    for entry in list {
        let (Some(id), Some(name), Some(path)) = (
            entry.get("id").and_then(serde_json::Value::as_str),
            entry.get("name").and_then(serde_json::Value::as_str),
            entry.get("path").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        projects.push(Project {
            id: id.to_owned(),
            name: name.to_owned(),
            path: path.to_owned(),
        });
    }
    let next = value
        .get("next")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    Ok(ProjectPage { projects, next })
}

fn project_unavailable() -> Failure<'static> {
    Failure::new(Outcome::Refused, "Project list unavailable").with_code(ErrorCode::Refused)
}

/// A project by id, name or path, exactly as `findProject` in `daemon.ts`.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn find_project(
    projects: &[Project],
    item: &str,
    cwd: &std::path::Path,
) -> Result<Project, Failure<'static>> {
    if let Some(found) = projects.iter().find(|project| project.id == item) {
        return Ok(found.clone());
    }
    let looks_like_path =
        item.starts_with('.') || item.starts_with('~') || item.contains(['/', '\\']);
    let resolved = if std::path::Path::new(item).is_absolute() {
        item.to_owned()
    } else {
        cwd.join(item).to_string_lossy().into_owned()
    };
    if let Some(found) = projects.iter().find(|project| project.path == resolved) {
        return Ok(found.clone());
    }
    if !looks_like_path {
        let named: Vec<&Project> = projects
            .iter()
            .filter(|project| project.name.to_lowercase() == item.to_lowercase())
            .collect();
        if named.len() == 1
            && let Some(only) = named.first()
        {
            return Ok((*only).clone());
        }
        if named.len() > 1 {
            let ids = named
                .iter()
                .map(|project| format!("{} ({})", project.id, project.path))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(
                Failure::usage(format!("{} projects are named {item}.", named.len()))
                    .with_code(ErrorCode::Ambiguous)
                    .with_argument("PROJECT")
                    .with_hint(format!("Use its id: {ids}.")),
            );
        }
    }
    Err(Failure::new(
        Outcome::Refused,
        format!(
            "No project {} {item}.",
            if looks_like_path { "at" } else { "named" }
        ),
    )
    .with_code(ErrorCode::NotFound)
    .with_argument("PROJECT")
    .with_hint("See your projects with ace project list, or add this folder with ace project add."))
}
