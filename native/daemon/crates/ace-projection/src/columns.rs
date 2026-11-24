// SPDX-License-Identifier: Apache-2.0
//! The thread columns and their encodings, ported from `apps/daemon/src/thread-columns.ts`
//! (porting guide 5.3b). A column stores JavaScript text, a number or NULL; every value is
//! built with `ace-json`, so key order, number printing and lone surrogates are JavaScript's.
//!
//! Zod validation stays TypeScript: a value the table can't shape is written unchanged, and
//! `rebuildThread` rejects it inside the same transaction as today.

use std::fmt;

use crate::strip::strip;
use ace_json::{JsString, Map};
use ace_protocol::shapes::{THREAD_CLIENT_COLUMN, THREAD_DETAILS, THREAD_PROVIDER_METADATA};

mod support;

pub use support::print_number;
use support::{columns_equal, json_text, picked, shaped, simple, truthy};

/// Every column `engine.ts` writes from the folded thread, in the table's order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Column {
    Id,
    WorkspaceId,
    Title,
    Provider,
    CreatedAt,
    UpdatedAt,
    ArchivedAt,
    Imported,
    RootAgentId,
    Status,
    Client,
    Details,
    Transitions,
    ProviderMetadata,
    Capabilities,
    Acp,
}

/// The part of a rebuilt thread a column belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Base,
    Status,
    Client,
    Details,
    Transitions,
    Metadata,
    Capabilities,
    Acp,
}

impl Column {
    /// The table's order.
    pub const ALL: [Column; 16] = [
        Column::Id,
        Column::WorkspaceId,
        Column::Title,
        Column::Provider,
        Column::CreatedAt,
        Column::UpdatedAt,
        Column::ArchivedAt,
        Column::Imported,
        Column::RootAgentId,
        Column::Status,
        Column::Client,
        Column::Details,
        Column::Transitions,
        Column::ProviderMetadata,
        Column::Capabilities,
        Column::Acp,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Column::Id => "id",
            Column::WorkspaceId => "workspace_id",
            Column::Title => "title",
            Column::Provider => "provider",
            Column::CreatedAt => "created_at",
            Column::UpdatedAt => "updated_at",
            Column::ArchivedAt => "archived_at",
            Column::Imported => "imported",
            Column::RootAgentId => "root_agent_id",
            Column::Status => "status",
            Column::Client => "client",
            Column::Details => "details",
            Column::Transitions => "transitions",
            Column::ProviderMetadata => "provider_metadata",
            Column::Capabilities => "capabilities",
            Column::Acp => "acp",
        }
    }

    pub fn from_name(name: &str) -> Option<Column> {
        Column::ALL.into_iter().find(|column| column.name() == name)
    }

    pub fn part(self) -> Part {
        match self {
            Column::Id
            | Column::WorkspaceId
            | Column::Title
            | Column::Provider
            | Column::CreatedAt
            | Column::UpdatedAt
            | Column::ArchivedAt
            | Column::Imported
            | Column::RootAgentId => Part::Base,
            Column::Status => Part::Status,
            Column::Client => Part::Client,
            Column::Details => Part::Details,
            Column::Transitions => Part::Transitions,
            Column::ProviderMetadata => Part::Metadata,
            Column::Capabilities => Part::Capabilities,
            Column::Acp => Part::Acp,
        }
    }

    /// Columns of the large, rarely changing values kept in `thread_cold`.
    pub fn is_cold(self) -> bool {
        matches!(self, Column::Details | Column::Capabilities)
    }

    /// The thread field a simple column reads; the JSON columns build their own.
    fn field(self) -> &'static str {
        match self {
            Column::Id => "id",
            Column::WorkspaceId => "workspaceId",
            Column::Title => "title",
            Column::Provider => "provider",
            Column::CreatedAt => "createdAt",
            Column::UpdatedAt => "updatedAt",
            Column::ArchivedAt => "archivedAt",
            Column::RootAgentId => "rootAgentId",
            _ => "",
        }
    }

    /// `?? null`: an absent field is stored as NULL.
    fn coalesces(self) -> bool {
        matches!(self, Column::ArchivedAt | Column::RootAgentId)
    }
}

impl Part {
    pub fn name(self) -> &'static str {
        match self {
            Part::Base => "base",
            Part::Status => "status",
            Part::Client => "client",
            Part::Details => "details",
            Part::Transitions => "transitions",
            Part::Metadata => "metadata",
            Part::Capabilities => "capabilities",
            Part::Acp => "acp",
        }
    }
}

/// What a column stores: a JavaScript string, number or null.
#[derive(Clone, Debug, PartialEq)]
pub enum ColumnValue {
    Text(JsString),
    Number(f64),
    Null,
}

/// A column that SQLite could not bind: the TypeScript fails at the bind instead.
#[derive(Debug, PartialEq)]
pub enum ColumnError {
    NotStorable(Column),
}

impl fmt::Display for ColumnError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ColumnError::NotStorable(column) => {
                write!(
                    formatter,
                    "thread column {} cannot be stored",
                    column.name()
                )
            }
        }
    }
}

impl std::error::Error for ColumnError {}

/// What one writeThread changed and what it re-reads.
#[derive(Debug)]
pub struct ColumnChanges {
    /// In `row`'s insertion order.
    pub row: Vec<(Column, ColumnValue)>,
    pub hot: Vec<(Column, ColumnValue)>,
    pub cold: Vec<(Column, ColumnValue)>,
    /// Insertion order, no repeats.
    pub parts: Vec<Part>,
}

/// The stored value of one column of `thread`.
pub fn column_value(thread: &Map, column: Column) -> Result<ColumnValue, ColumnError> {
    match column {
        Column::Id
        | Column::WorkspaceId
        | Column::Title
        | Column::Provider
        | Column::CreatedAt
        | Column::UpdatedAt
        | Column::ArchivedAt
        | Column::RootAgentId => simple(thread, column),
        Column::Imported => match thread.get("imported") {
            Some(value) if truthy(value) => Ok(json_text(value)),
            _ => Ok(ColumnValue::Null),
        },
        Column::Status => match thread.get("status") {
            Some(value) => Ok(json_text(value)),
            None => Err(ColumnError::NotStorable(column)),
        },
        Column::Client => Ok(json_text(&shaped(thread, &THREAD_CLIENT_COLUMN))),
        Column::Details => match thread.get("details") {
            None => Ok(ColumnValue::Null),
            Some(value) => Ok(json_text(&strip(&THREAD_DETAILS, value))),
        },
        Column::Transitions => Ok(json_text(&picked(
            thread,
            &[
                "lineage",
                "delegatedBy",
                "delegatedFrom",
                "startedBy",
                "startedByClient",
                "treeRootId",
                "queuedLaunch",
                "execution",
                "switch",
            ],
        ))),
        Column::ProviderMetadata => Ok(json_text(&picked(
            thread,
            &[
                "backend",
                "handoff",
                "permission",
                "titleSource",
                "queue",
                "goal",
            ],
        ))),
        Column::Capabilities => match thread.get("capabilities") {
            Some(value) => Ok(json_text(value)),
            None => Ok(ColumnValue::Null),
        },
        Column::Acp => Ok(json_text(&shaped(thread, &THREAD_PROVIDER_METADATA))),
    }
}

/// The columns of `wanted` whose stored value would change from `previous` to `next`, plus the
/// rest of each changed part.
pub fn column_changes(
    previous: Option<&Map>,
    next: &Map,
    wanted: &[Column],
) -> Result<ColumnChanges, ColumnError> {
    let mut changes = ColumnChanges {
        row: Vec::new(),
        hot: Vec::new(),
        cold: Vec::new(),
        parts: Vec::new(),
    };
    for &column in wanted {
        if let Some(previous) = previous
            && columns_equal(previous, next, column)
        {
            continue;
        }
        let value = column_value(next, column)?;
        // A new thread without a cold value needs no cold row: a missing one reads the same.
        if previous.is_none() && column.is_cold() && value == ColumnValue::Null {
            continue;
        }
        let part = column.part();
        if !changes.parts.contains(&part) {
            changes.parts.push(part);
        }
        if column.is_cold() {
            changes.cold.push((column, value.clone()));
        } else {
            changes.hot.push((column, value.clone()));
        }
        changes.row.push((column, value));
    }
    // A changed part is decoded again from all of its columns, written or not.
    for column in Column::ALL {
        if changes.parts.contains(&column.part())
            && !changes.row.iter().any(|(written, _)| *written == column)
        {
            let source = previous.unwrap_or(next);
            changes.row.push((column, column_value(source, column)?));
        }
    }
    Ok(changes)
}

/// What `writeThread`'s cold upsert binds after `thread_id`: details, then capabilities.
pub fn cold_row_values(
    previous: Option<&Map>,
    changes: &ColumnChanges,
) -> Result<[ColumnValue; 2], ColumnError> {
    Ok([
        cold_value(previous, changes, Column::Details)?,
        cold_value(previous, changes, Column::Capabilities)?,
    ])
}

fn cold_value(
    previous: Option<&Map>,
    changes: &ColumnChanges,
    column: Column,
) -> Result<ColumnValue, ColumnError> {
    if let Some((_, value)) = changes.cold.iter().find(|(changed, _)| *changed == column) {
        return Ok(value.clone());
    }
    match previous {
        Some(previous) => column_value(previous, column),
        None => Ok(ColumnValue::Null),
    }
}

#[cfg(test)]
mod tests {
    use ace_json::{JsString, Map, Value};

    use super::{Column, ColumnValue, column_value};

    fn thread(pairs: &[(&str, Value)]) -> Map {
        let mut map = Map::new();
        for (key, value) in pairs {
            map.insert(*key, value.clone());
        }
        map
    }

    #[test]
    fn imported_is_text_only_when_truthy() {
        let mut map = thread(&[("id", Value::String(JsString::from("t")))]);
        assert_eq!(column_value(&map, Column::Imported), Ok(ColumnValue::Null));
        map.insert("imported", Value::Bool(false));
        assert_eq!(column_value(&map, Column::Imported), Ok(ColumnValue::Null));
        map.insert("imported", Value::Object(Map::new()));
        assert_eq!(
            column_value(&map, Column::Imported),
            Ok(ColumnValue::Text(JsString::from("{}")))
        );
    }

    #[test]
    fn an_absent_simple_field_is_not_storable() {
        let map = thread(&[]);
        assert!(column_value(&map, Column::Title).is_err());
        assert_eq!(
            column_value(&map, Column::ArchivedAt),
            Ok(ColumnValue::Null)
        );
    }
}
