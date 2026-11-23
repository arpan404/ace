// SPDX-License-Identifier: Apache-2.0
//! `Agent` as `JSON.stringify` writes it. `ensureAgent` builds the placeholder in one literal;
//! the fields a later fact fills in (`agent.seen`, `agent.linked`, a spawn link, an ended time)
//! are appended at the end of the object, in the order they first appear. That insertion order
//! is what a snapshot and a re-announced `agent.created` carry, so it is written here.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

use crate::state::Agent;

/// The optional fields a fold fills in after the placeholder, in their common first-set order.
const APPENDED: [&str; 8] = [
    "spawnedBy",
    "lineage",
    "name",
    "role",
    "model",
    "machine",
    "childThreadId",
    "endedAt",
];

fn write_appended<S: SerializeMap>(map: &mut S, agent: &Agent, key: &str) -> Result<(), S::Error> {
    match key {
        "spawnedBy" => match &agent.spawned_by {
            crate::json_io::Maybe::Value(value) => map.serialize_entry("spawnedBy", value)?,
            crate::json_io::Maybe::Null => {
                map.serialize_entry("spawnedBy", &Option::<String>::None)?
            }
            crate::json_io::Maybe::Missing => {}
        },
        "lineage" => {
            if let Some(value) = &agent.lineage {
                map.serialize_entry("lineage", value)?;
            }
        }
        "name" => {
            if let Some(value) = &agent.name {
                map.serialize_entry("name", value)?;
            }
        }
        "role" => {
            if let Some(value) = &agent.role {
                map.serialize_entry("role", value)?;
            }
        }
        "model" => {
            if let Some(value) = &agent.model {
                map.serialize_entry("model", value)?;
            }
        }
        "machine" => {
            if let Some(value) = &agent.machine {
                map.serialize_entry("machine", value)?;
            }
        }
        "childThreadId" => {
            if let Some(value) = &agent.child_thread_id {
                map.serialize_entry("childThreadId", value)?;
            }
        }
        "endedAt" => {
            if let Some(value) = &agent.ended_at {
                map.serialize_entry("endedAt", value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl Serialize for Agent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("id", &self.id)?;
        map.serialize_entry("threadId", &self.thread_id)?;
        map.serialize_entry("parentId", &self.parent_id)?;
        map.serialize_entry("origin", &self.origin)?;
        map.serialize_entry("native", &self.native)?;
        map.serialize_entry("fidelity", &self.fidelity)?;
        map.serialize_entry("cwd", &self.cwd)?;
        map.serialize_entry("status", &self.status)?;
        map.serialize_entry("background", &self.background)?;
        map.serialize_entry("createdAt", &self.created_at)?;
        for key in &self.appended {
            write_appended(&mut map, self, key)?;
        }
        // A restored agent does not know when each field appeared: keep every present field,
        // in the canonical order.
        for key in APPENDED {
            if !self.appended.contains(&key) {
                write_appended(&mut map, self, key)?;
            }
        }
        map.end()
    }
}
