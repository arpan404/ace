// SPDX-License-Identifier: Apache-2.0
//! The inventory's rows: one owned group leader (or Windows tree member) as
//! JSON, byte-for-byte today's. POSIX entries keep the platform's key order;
//! only kernel identities and non-secret labels persist.

use crate::errors::SupervisorError;
use serde_json::{Map, Value};

/// The most processes one journal records.
pub const INVENTORY_CAPACITY: i64 = 4_096;

/// An owner's identity: numeric uid on POSIX, SID string on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerValue {
    Uid(u32),
    Sid(String),
}

/// One recorded process: its kernel identity, its owner, a label.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: u32,
    pub start: String,
    pub owner: OwnerValue,
    pub group: u32,
    pub owner_pid: u32,
    pub owner_start: String,
    pub name: String,
    pub cwd: Option<String>,
    pub created_at: u64,
    /// Windows only: the tree this member was proven into.
    pub tree: Option<String>,
}

/// The platform that wrote the row: key order follows the TypeScript that
/// built it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryPlatform {
    Linux,
    Macos,
    Windows,
}

impl EntryPlatform {
    /// The current platform's order.
    pub fn current() -> Self {
        #[cfg(target_os = "macos")]
        return Self::Macos;
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        return Self::Linux;
    }
}

fn put(map: &mut Map<String, Value>, key: &str, value: Value) {
    map.insert(key.to_owned(), value);
}

/// Serializes one entry exactly as the TypeScript journal row.
pub fn entry_json(entry: &ProcessEntry, platform: EntryPlatform) -> String {
    let mut map = Map::new();
    let owner = match &entry.owner {
        OwnerValue::Uid(uid) => Value::from(*uid),
        OwnerValue::Sid(sid) => Value::from(sid.clone()),
    };
    // macOS builds {pid, uid, group, start}; Linux and Windows {pid, start, uid, group}.
    if platform == EntryPlatform::Macos {
        put(&mut map, "pid", Value::from(entry.pid));
        put(&mut map, "uid", owner);
        put(&mut map, "group", Value::from(entry.group));
        put(&mut map, "start", Value::from(entry.start.clone()));
    } else {
        put(&mut map, "pid", Value::from(entry.pid));
        put(&mut map, "start", Value::from(entry.start.clone()));
        put(&mut map, "uid", owner);
        put(&mut map, "group", Value::from(entry.group));
    }
    put(&mut map, "ownerPid", Value::from(entry.owner_pid));
    put(
        &mut map,
        "ownerStart",
        Value::from(entry.owner_start.clone()),
    );
    put(&mut map, "name", Value::from(entry.name.clone()));
    if let Some(cwd) = &entry.cwd {
        put(&mut map, "cwd", Value::from(cwd.clone()));
    }
    put(&mut map, "createdAt", Value::from(entry.created_at));
    if let Some(tree) = &entry.tree {
        put(&mut map, "tree", Value::from(tree.clone()));
    }
    Value::Object(map).to_string()
}

fn get<'a>(map: &'a Map<String, Value>, key: &str) -> Result<&'a Value, SupervisorError> {
    map.get(key)
        .ok_or_else(|| SupervisorError::Journal(format!("inventory row is missing {key}")))
}

fn as_u32(value: &Value, key: &str) -> Result<u32, SupervisorError> {
    match value {
        Value::Number(number) => number
            .as_u64()
            .and_then(|n| u32::try_from(n).ok())
            .ok_or_else(|| SupervisorError::Journal(format!("inventory row has a bad {key}"))),
        _ => Err(SupervisorError::Journal(format!(
            "inventory row has a bad {key}"
        ))),
    }
}

fn as_string(value: &Value, key: &str) -> Result<String, SupervisorError> {
    match value {
        Value::String(text) => Ok(text.clone()),
        _ => Err(SupervisorError::Journal(format!(
            "inventory row has a bad {key}"
        ))),
    }
}

/// Parses one stored row, validating what the schema checks.
pub fn parse_entry(text: &str) -> Result<ProcessEntry, SupervisorError> {
    let value: Value = serde_json::from_str(text)
        .map_err(|_| SupervisorError::Journal("inventory row is not JSON".to_owned()))?;
    let Value::Object(map) = value else {
        return Err(SupervisorError::Journal(
            "inventory row is not JSON".to_owned(),
        ));
    };
    let owner = match get(&map, "uid")? {
        Value::Number(_) => OwnerValue::Uid(as_u32(get(&map, "uid")?, "uid")?),
        Value::String(sid) => {
            if !crate::wintree::valid_sid(sid) {
                return Err(SupervisorError::Journal(
                    "inventory row has a bad uid".to_owned(),
                ));
            }
            OwnerValue::Sid(sid.clone())
        }
        _ => {
            return Err(SupervisorError::Journal(
                "inventory row has a bad uid".to_owned(),
            ));
        }
    };
    let name = as_string(get(&map, "name")?, "name")?;
    if name.chars().count() > 256 {
        return Err(SupervisorError::Journal(
            "inventory row has a bad name".to_owned(),
        ));
    }
    let start = as_string(get(&map, "start")?, "start")?;
    if start.is_empty() || start.len() > 128 {
        return Err(SupervisorError::Journal(
            "inventory row has a bad start".to_owned(),
        ));
    }
    let cwd = match map.get("cwd") {
        None => None,
        Some(value) => Some(as_string(value, "cwd")?),
    };
    let created_at = match get(&map, "createdAt")? {
        Value::Number(number) => number.as_u64().ok_or_else(|| {
            SupervisorError::Journal("inventory row has a bad createdAt".to_owned())
        })?,
        _ => {
            return Err(SupervisorError::Journal(
                "inventory row has a bad createdAt".to_owned(),
            ));
        }
    };
    let pid = as_u32(get(&map, "pid")?, "pid")?;
    let group = as_u32(get(&map, "group")?, "group")?;
    let owner_pid = as_u32(get(&map, "ownerPid")?, "ownerPid")?;
    if pid == 0 || group == 0 || owner_pid == 0 {
        return Err(SupervisorError::Journal(
            "inventory row has a bad pid".to_owned(),
        ));
    }
    Ok(ProcessEntry {
        pid,
        start,
        group,
        owner,
        owner_pid,
        owner_start: as_string(get(&map, "ownerStart")?, "ownerStart")?,
        name,
        cwd,
        created_at,
        tree: match map.get("tree") {
            None => None,
            Some(value) => Some(as_string(value, "tree")?),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry() -> ProcessEntry {
        ProcessEntry {
            pid: 20,
            start: "boot:99".to_owned(),
            owner: OwnerValue::Uid(1000),
            group: 20,
            owner_pid: 10,
            owner_start: "boot:11".to_owned(),
            name: "synthetic".to_owned(),
            cwd: None,
            created_at: 1,
            tree: None,
        }
    }

    #[test]
    fn entries_round_trip_through_json() {
        for platform in [
            EntryPlatform::Linux,
            EntryPlatform::Macos,
            EntryPlatform::Windows,
        ] {
            let text = entry_json(&entry(), platform);
            assert_eq!(parse_entry(&text), Ok(entry()));
        }
        let mut with_cwd = entry();
        with_cwd.cwd = Some("/tmp/work".to_owned());
        let text = entry_json(&with_cwd, EntryPlatform::Linux);
        assert_eq!(parse_entry(&text), Ok(with_cwd));
    }

    #[test]
    fn macos_keeps_pid_uid_group_start_order() {
        let text = entry_json(&entry(), EntryPlatform::Macos);
        let pid = text.find("\"pid\"").expect("pid key");
        let uid = text.find("\"uid\"").expect("uid key");
        let group = text.find("\"group\"").expect("group key");
        let start = text.find("\"start\"").expect("start key");
        assert!(pid < uid && uid < group && group < start);
    }

    #[test]
    fn corrupt_rows_fail_closed() {
        assert!(parse_entry("not json").is_err());
        assert!(parse_entry("[]").is_err());
        let mut bad = entry();
        bad.pid = 0;
        assert!(parse_entry(&entry_json(&bad, EntryPlatform::Linux)).is_err());
        let mut bad = entry();
        bad.name = "x".repeat(257);
        assert!(parse_entry(&entry_json(&bad, EntryPlatform::Linux)).is_err());
    }
}
