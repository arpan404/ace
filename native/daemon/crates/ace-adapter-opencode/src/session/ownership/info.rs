// SPDX-License-Identifier: Apache-2.0
//! `SessionInfo` (`boundaries.ts:23`-`:31`): the snapshot fields a session proves
//! its ancestry with. zod's bounds count code points (rule 17), and a field that
//! is present but wrong fails the whole snapshot.

use ace_json::Value;

use crate::translate::data::{fields, get, truthy};

/// A validated `SessionInfo` (`boundaries.ts:23`-`:31`), borrowed from the value.
#[derive(Debug, Clone, Copy)]
pub struct Info<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub directory: &'a str,
    /// `""` when the session has no parent.
    pub parent_id: &'a str,
    /// `info.fork`'s JavaScript truthiness: any other value is a fork.
    pub fork: bool,
}

/// `SessionInfo.parse`: `None` where `safeParse` fails.
pub fn parse_info(value: &Value) -> Option<Info<'_>> {
    parse_info_as(value, None)
}

/// `SessionInfo.safeParse({ ...p, id: p.sessionID })` (`ownership.ts:119`), where
/// `p` is the envelope's `data`: the event's session id stands in for the
/// snapshot's own.
pub fn parse_session_info(value: &Value) -> Option<Info<'_>> {
    parse_info_as(get(fields(value), "data"), Some("sessionID"))
}

/// A snapshot's bounded fields; zod's bounds count code points (rule 17).
fn parse_info_as<'a>(value: &'a Value, id_field: Option<&str>) -> Option<Info<'a>> {
    let map = fields(value);
    let id = match id_field {
        Some(field) => match map.get(field) {
            Some(Value::String(id)) => id.as_str(),
            _ => return None,
        },
        None => match map.get("id") {
            Some(Value::String(id)) => id.as_str(),
            _ => return None,
        },
    };
    if id.is_empty() || points(id) > 512 {
        return None;
    }
    let project_id = match map.get("projectID") {
        Some(Value::String(project)) if points(project) <= 512 => project.as_str(),
        _ => return None,
    };
    let location = fields(get(map, "location"));
    let directory = match location.get("directory") {
        Some(Value::String(directory)) if !directory.is_empty() && points(directory) <= 4096 => {
            directory.as_str()
        }
        _ => return None,
    };
    let parent_id = match map.get("parentID") {
        // `z.string().max(512).optional()`: absent is a root, but a null is
        // not a string and fails the check (a ZodError in the TypeScript).
        None => "",
        Some(Value::String(parent)) if points(parent) <= 512 => parent.as_str(),
        _ => return None,
    };
    Some(Info {
        id,
        project_id,
        directory,
        parent_id,
        fork: map.get("fork").is_some_and(truthy),
    })
}

/// Code points, the way zod's patched bounds count (rule 17).
fn points(text: &str) -> usize {
    text.chars().count()
}
