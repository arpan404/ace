// SPDX-License-Identifier: Apache-2.0
//! What a device tools install is asked for, and what it answers
//! (`packages/devices/src/device-tools-wire.ts`).
//!
//! The request's shape is `serve_sim::InstallRequest` (D3.1) and its answer is
//! `serve_sim::ToolsInstalled`; this module owns the bounds the TypeScript's
//! schemas put on both, which the internal process message must still keep.

use crate::platform::serve_sim::{Artifact, InstallRequest, ServeSimCommand, ToolsInstalled};

/// An artifact name's cap (`device-tools-wire.ts:5`).
pub const MAX_ARTIFACT_NAME: usize = 214;
/// An artifact version's cap.
pub const MAX_ARTIFACT_VERSION: usize = 64;
/// A directory or a Node path: 1 to 4,096.
pub const MAX_PATH: usize = 4_096;
/// serve-sim's own arguments (`ToolsReply`).
pub const MAX_ARGS: usize = 8;
/// Every integrity string is a registry `sha512-` digest.
pub const INTEGRITY_PREFIX: &str = "sha512-";

/// One field the wire refuses, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Issue {
    pub field: &'static str,
    pub message: String,
}

fn too_long(field: &'static str, max: usize) -> Issue {
    Issue {
        field,
        message: format!("{field} must be at most {max} characters"),
    }
}

fn empty(field: &'static str) -> Issue {
    Issue {
        field,
        message: format!("{field} must not be empty"),
    }
}

/// `Artifact`: a name, a version, an absolute URL and a `sha512-` integrity.
pub fn check_artifact(prefix: &'static str, artifact: &Artifact) -> Result<(), Issue> {
    if artifact.name.is_empty() {
        return Err(empty(prefix));
    }
    if artifact.name.chars().count() > MAX_ARTIFACT_NAME {
        return Err(too_long(prefix, MAX_ARTIFACT_NAME));
    }
    if artifact.version.is_empty() {
        return Err(empty("version"));
    }
    if artifact.version.chars().count() > MAX_ARTIFACT_VERSION {
        return Err(too_long("version", MAX_ARTIFACT_VERSION));
    }
    let absolute = url::Url::parse(&artifact.url)
        .ok()
        .is_some_and(|url| !url.scheme().is_empty());
    if !absolute {
        return Err(Issue {
            field: "url",
            message: String::from("url must be an absolute URL"),
        });
    }
    if !artifact.integrity.starts_with(INTEGRITY_PREFIX) {
        return Err(Issue {
            field: "integrity",
            message: format!("integrity must start with {INTEGRITY_PREFIX}"),
        });
    }
    Ok(())
}

/// `ToolsRequest`: ace's tools directory and Node, and the artifacts when the
/// caller substitutes its own.
pub fn check_request(request: &InstallRequest) -> Result<(), Issue> {
    if request.directory.is_empty() {
        return Err(empty("directory"));
    }
    if request.directory.chars().count() > MAX_PATH {
        return Err(too_long("directory", MAX_PATH));
    }
    if request.node.is_empty() {
        return Err(empty("node"));
    }
    if request.node.chars().count() > MAX_PATH {
        return Err(too_long("node", MAX_PATH));
    }
    if let Some(artifacts) = &request.artifacts {
        check_artifact("serveSim.name", &artifacts.serve_sim)?;
        check_artifact("ws.name", &artifacts.ws)?;
    }
    Ok(())
}

/// `ToolsReply`: a serve-sim command when there is one, and a scrcpy path that is
/// not blank.
pub fn check_installed(installed: &ToolsInstalled) -> Result<(), Issue> {
    if let Some(command) = &installed.serve_sim {
        check_command(command)?;
    }
    if installed.scrcpy.as_deref() == Some("") {
        return Err(empty("scrcpy"));
    }
    Ok(())
}

/// `ToolsReply`'s serve-sim command: a non-empty command and at most eight
/// arguments.
pub fn check_command(command: &ServeSimCommand) -> Result<(), Issue> {
    if command.command.is_empty() {
        return Err(empty("serveSim.command"));
    }
    if command.args.len() > MAX_ARGS {
        return Err(Issue {
            field: "serveSim.args",
            message: format!("serveSim.args must have at most {MAX_ARGS} items"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
