// SPDX-License-Identifier: Apache-2.0
//! A dictionary's transaction lifecycle (E5.3 step 4, `records.ts:241`-`:290`): persist,
//! committed, flush and release. The SQL text is the TypeScript's, from the call sites named on
//! each statement.

use ace_core::section::Change;
use ace_store::stmt_cache;
use std::rc::Rc;

use ace_json::Value;

use super::budget::Cached;
use super::{DELETE_APPENDS, DELETE_RECORD, Records, UPSERT_RECORD, insert_patch, text};
use crate::EngineError;

/// A record's typed form loses fields this build does not know; the stored value keeps them
/// (`parseRecord` validates without stripping, `records.ts:15`), so a newer build's fields
/// survive a write by this one.
fn keep_unknown_fields(encoded: &str, base: &str) -> String {
    let (Ok(Value::Object(typed)), Ok(Value::Object(original))) =
        (ace_json::parse(encoded), ace_json::parse(base))
    else {
        return encoded.to_owned();
    };
    let mut merged = typed.clone();
    for (key, value) in &original {
        if !merged.contains_key(key) {
            merged.insert(key.clone(), value.clone());
        }
    }
    if merged.len() == typed.len() {
        return encoded.to_owned();
    }
    ace_json::to_string(&Value::Object(merged))
}

impl<T: Clone + 'static> Records<T> {
    /// `persist` (`records.ts:241`): pending patches of keys not replaced, then every written
    /// and deleted slot.
    pub fn persist(&mut self) -> Result<(), EngineError> {
        let patches: Vec<(String, Vec<super::Append>)> = self
            .patches
            .iter()
            .map(|(key, patches)| (key.clone(), patches.clone()))
            .collect();
        for (key, list) in patches {
            if self.replaced.contains(&key) {
                continue;
            }
            for patch in list {
                insert_patch(&self.conn, &self.thread, &self.group, &key, &patch)?;
            }
        }
        for (key, change) in self.section.changes() {
            match change {
                Change::Deleted => {
                    stmt_cache::run(
                        &self.conn,
                        DELETE_APPENDS,
                        vec![text(&self.thread), text(&self.group), text(&key)],
                    )?;
                    stmt_cache::run(
                        &self.conn,
                        DELETE_RECORD,
                        vec![text(&self.thread), text(&self.group), text(&key)],
                    )?;
                }
                Change::Written(value) => {
                    if self.appended.contains(&key) && !self.replaced.contains(&key) {
                        continue;
                    }
                    let json = (self.encode)(&key, value)?;
                    let base = self
                        .section
                        .base_json(&key)
                        .map(str::to_owned)
                        .or_else(|| self.cache.get::<T>(&key).map(|cached| cached.json))
                        .unwrap_or_default();
                    let json = keep_unknown_fields(&json, &base);
                    if json != base || self.replaced.contains(&key) {
                        stmt_cache::run(
                            &self.conn,
                            DELETE_APPENDS,
                            vec![text(&self.thread), text(&self.group), text(&key)],
                        )?;
                        stmt_cache::run(
                            &self.conn,
                            UPSERT_RECORD,
                            vec![
                                text(&self.thread),
                                text(&self.group),
                                text(&key),
                                text(&json),
                            ],
                        )?;
                    }
                    let bytes = json.len();
                    self.cache.set(
                        &key,
                        Cached {
                            value: Rc::new(value.clone()),
                            json,
                            bytes,
                        },
                        bytes,
                    );
                }
            }
        }
        Ok(())
    }

    /// `committed` (`records.ts:278`): clear every overlay and the enumeration.
    pub fn committed(&mut self) {
        self.patches.clear();
        self.section.committed();
        self.replaced.clear();
        self.appended.clear();
        self.append_value = None;
    }

    /// `flush` (`records.ts:287`).
    pub fn flush(&mut self) -> Result<(), EngineError> {
        self.persist()?;
        self.committed();
        Ok(())
    }

    /// `release` (`records.ts:182`): give back this dictionary's share of the budget.
    /// Permanent: a released section caches nothing, and later reads use SQLite. Unflushed
    /// changes stay in the overlay, as the TypeScript's `touched` entries do.
    pub fn release(&mut self) {
        self.cache.disable();
    }
}
