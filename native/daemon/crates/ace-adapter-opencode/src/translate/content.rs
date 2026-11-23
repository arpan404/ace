// SPDX-License-Identifier: Apache-2.0
//! Native content mapping (`packages/adapter-opencode/src/native-content.ts`).
//! Deltas stream into items; snapshots reconcile them. A tool seen running
//! after its execution ended is held as bookkeeping work until it settles.

use crate::translate::data::{arr_in, fields, get, n_in, num_str, s_in, utf16_len};
use crate::translate::state::{ChangeKind, FileChange};
use serde::Serialize;
use ace_json::{Map, Value};

/// The native key of a tool call: its session, message, and native id.
pub fn tool_key(session: &str, message: &str, id: &str) -> String {
    format!("tool:{session}:{message}:{id}")
}

/// The native key of a text or reasoning block.
pub fn content_key(p: &Map) -> String {
    format!(
        "{}:{}:{}",
        s_in(p, "sessionID"),
        s_in(p, "assistantMessageID"),
        num_str(n_in(p, "ordinal"))
    )
}

/// A patch larger than this is left out rather than kept in tool state.
const MAX_PATCH: usize = 1 << 20;

fn patch_of(value: &Value) -> Option<&str> {
    match value {
        Value::String(patch) if !patch.is_empty() && utf16_len(patch) <= MAX_PATCH => Some(patch),
        _ => None,
    }
}

fn change_kind(status: &str) -> ChangeKind {
    if status == "added" {
        ChangeKind::Add
    } else if status == "deleted" {
        ChangeKind::Delete
    } else {
        ChangeKind::Update
    }
}

/// The patches OpenCode reports once an edit or write ran.
pub fn edit_changes(path: &str, meta: &Map) -> Option<Vec<FileChange>> {
    let files = arr_in(meta, "files");
    let changes: Vec<FileChange> = files
        .iter()
        .filter_map(|file| {
            let entry = fields(file);
            let diff = patch_of(get(entry, "patch"))?;
            let named = s_in(entry, "file");
            let named = if named.is_empty() { path } else { named };
            if named.is_empty() {
                return None;
            }
            Some(FileChange {
                path: named.to_owned(),
                kind: change_kind(s_in(entry, "status")),
                diff: Some(diff.to_owned()),
            })
        })
        .collect();
    if !changes.is_empty() {
        return Some(changes);
    }
    let diff = patch_of(get(meta, "diff"))?;
    if path.is_empty() {
        return None;
    }
    Some(vec![FileChange {
        path: path.to_owned(),
        kind: ChangeKind::Update,
        diff: Some(diff.to_owned()),
    }])
}

#[cfg(test)]
mod tests {
    use super::edit_changes;
    use crate::translate::state::{ChangeKind, FileChange};
    use ace_json::{Map, Value, json};

    fn record(value: Value) -> Map {
        match value {
            Value::Object(map) => map,
            _ => Map::new(),
        }
    }

    /// The one patch an older OpenCode reports as metadata.diff.
    #[test]
    fn carries_the_one_patch_an_older_opencode_reports() {
        let patch = "--- a.ts\n+++ a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";
        let meta = record(json!({ "diff": patch }));
        assert_eq!(
            edit_changes("a.ts", &meta),
            Some(vec![FileChange {
                path: String::from("a.ts"),
                kind: ChangeKind::Update,
                diff: Some(patch.to_owned()),
            }])
        );
    }

    /// A file the write created is marked as added.
    #[test]
    fn marks_a_file_the_write_created_as_added() {
        let patch = "--- a.ts\n+++ a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";
        let meta =
            record(json!({ "files": [{ "file": "a.ts", "patch": patch, "status": "added" }] }));
        assert_eq!(
            edit_changes("a.ts", &meta),
            Some(vec![FileChange {
                path: String::from("a.ts"),
                kind: ChangeKind::Add,
                diff: Some(patch.to_owned()),
            }])
        );
    }

    /// Each file is named by its own entry when one call reports several.
    #[test]
    fn names_each_file_by_its_own_entry() {
        let patch = "--- a.ts\n+++ a.ts\n@@ -1,1 +1,2 @@\n a\n+b\n";
        let files = [
            json!({ "file": "a.ts", "patch": patch, "status": "modified" }),
            json!({ "file": "b.ts", "patch": patch, "status": "deleted" }),
        ];
        let meta = record(json!({ "files": files }));
        assert_eq!(
            edit_changes("a.ts", &meta),
            Some(vec![
                FileChange {
                    path: String::from("a.ts"),
                    kind: ChangeKind::Update,
                    diff: Some(patch.to_owned()),
                },
                FileChange {
                    path: String::from("b.ts"),
                    kind: ChangeKind::Delete,
                    diff: Some(patch.to_owned()),
                },
            ])
        );
    }

    /// Left to the path alone when OpenCode sent no patch.
    #[test]
    fn falls_back_to_the_path_alone_without_a_patch() {
        let meta = record(json!({ "truncated": false }));
        assert_eq!(edit_changes("a.ts", &meta), None);
    }
}

#[derive(Serialize)]
pub struct ItemReconciled<'a, D: Serialize> {
    #[serde(rename = "type")]
    pub(crate) typ: &'static str,
    pub(crate) agent: &'a str,
    pub(crate) item: String,
    pub(crate) draft: D,
}
