// SPDX-License-Identifier: Apache-2.0
//! The lease operations the binding exposes, as one place the shell's JSON
//! arguments are read and its JSON answers built. No logic here: each call is
//! the `ace-git` module it names.

use ace_json::{JsString, Map, Value};

use crate::core::error::{GitError, GitErrorCode};
use crate::core::lease::admission::{assert_available, clear_stale_leases, mutation_state};
use crate::core::lease::heal::{HEAL_GRACE_MS, heal_repositories, heal_repository};
use crate::core::lease::journal::LeaseRecord;
use crate::core::lease::mutation::recover_mutation_leases;
use crate::core::lease::state::MutationState;
use crate::core::lease::{LeasePorts, LeaseRegistry};

/// One answer object, built in the TypeScript's field order.
struct Frame(Map);

impl Frame {
    fn new() -> Self {
        Self(Map::new())
    }

    fn text(mut self, key: &str, value: &str) -> Self {
        self.0.insert(JsString::from(key), Value::from(value));
        self
    }

    fn set(mut self, key: &str, value: Value) -> Self {
        self.0.insert(JsString::from(key), value);
        self
    }

    fn build(self) -> Value {
        Value::Object(self.0)
    }

    fn json(self) -> String {
        ace_json::to_string(&self.build())
    }
}

/// Runs one lease operation, named as `GitService`'s method.
pub async fn run(
    op: &str,
    args: &Map,
    ports: &dyn LeasePorts,
    registry: &LeaseRegistry,
) -> Result<String, GitError> {
    match op {
        "mutationState" => {
            let path = path_arg(args)?;
            Ok(mutation_state(&path, ports, registry).await?.to_json())
        }
        "assertMutationAvailable" => {
            let path = path_arg(args)?;
            assert_available(&path, ports, registry, &Default::default()).await?;
            Ok("null".to_owned())
        }
        "clearStaleLeases" => {
            let path = path_arg(args)?;
            let (retired, state, message) = clear_stale_leases(&path, ports, registry).await?;
            let mut frame = Frame::new()
                .set("retired", records_value(&retired))
                .set("state", state_value(&state));
            if let Some(message) = message {
                frame = frame.text("message", &message);
            }
            Ok(frame.json())
        }
        "heal" => {
            let path = path_arg(args)?;
            let removed = heal_repository(&path, ports, registry, HEAL_GRACE_MS).await?;
            Ok(Frame::new().set("removed", strings_value(&removed)).json())
        }
        "healAll" => {
            let paths = path_list(args)?;
            let mut failures: Vec<(String, GitError)> = Vec::new();
            let removed = {
                let mut failed = |path: &str, error: &GitError| {
                    failures.push((path.to_owned(), error.clone()));
                };
                let collector: &mut (dyn FnMut(&str, &GitError) + Send) = &mut failed;
                heal_repositories(&paths, ports, registry, collector, HEAL_GRACE_MS).await?
            };
            let failed: Vec<Value> = failures
                .into_iter()
                .map(|(path, error)| {
                    Frame::new()
                        .text("path", &path)
                        .text("code", error.code.as_str())
                        .text("message", &error.message)
                        .set("details", Value::Object((*error.details).clone()))
                        .build()
                })
                .collect();
            Ok(Frame::new()
                .set("removed", strings_value(&removed))
                .set("failed", Value::Array(failed.into()))
                .json())
        }
        "recoverCleanup" => {
            let path = path_arg(args)?;
            Ok(recover_mutation_leases(&path, ports, registry)
                .await?
                .to_json())
        }
        other => Err(GitError::new(
            GitErrorCode::InvalidArgument,
            format!("unknown lease operation: {other}"),
        )),
    }
}

fn path_arg(args: &Map) -> Result<String, GitError> {
    match args.get("path") {
        Some(Value::String(path)) => Ok(path.to_string_lossy().into_owned()),
        _ => Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "a lease operation needs a path",
        )),
    }
}

fn path_list(args: &Map) -> Result<Vec<String>, GitError> {
    match args.get("paths") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(path) => Ok(path.to_string_lossy().into_owned()),
                _ => Err(GitError::new(
                    GitErrorCode::InvalidArgument,
                    "a lease operation needs paths",
                )),
            })
            .collect(),
        _ => Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "a lease operation needs paths",
        )),
    }
}

fn records_value(records: &[LeaseRecord]) -> Value {
    Value::Array(records.iter().map(LeaseRecord::to_value).collect())
}

fn state_value(state: &MutationState) -> Value {
    let mut map = Map::new();
    map.insert(JsString::from("status"), Value::from(state.status));
    map.insert(JsString::from("leases"), records_value(&state.leases));
    Value::Object(map)
}

fn strings_value(items: &[String]) -> Value {
    Value::Array(
        items
            .iter()
            .map(|item| Value::from(item.as_str()))
            .collect(),
    )
}
