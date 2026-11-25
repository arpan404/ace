// SPDX-License-Identifier: Apache-2.0
//! One lazy dictionary per record section (E5.3 step 4, `records.ts:22`-`:291`).
//!
//! A dictionary reads a key from the append overlay, then the section's overlay, then the
//! shared budget, then SQLite: `SELECT value FROM engine_state_records WHERE thread_id=? AND
//! section=? AND key=?` (`records.ts:128`), every `engine_state_appends` patch for the key
//! `ORDER BY id` (`:136`), then the pending in-transaction patches (`:143`). The byte count is
//! the base JSON's bytes plus each patch's text bytes, and the value is validated with the
//! section's decoder without stripping (`parseRecord`, `:15`). Writes validate, decorate, cache
//! with the **previous** JSON (so persist can tell a change), and mark the key `replaced`.
//!
//! The section itself is [`ace_core::section::Section`]: one overlay per scope, no second
//! resident map beside the budget. The budget and SQLite are behind its `RecordSource`.

pub mod append;
pub mod budget;
mod persist;
#[cfg(test)]
mod tests;

pub use append::{Append, PathStep, restore_append};
pub use budget::{BudgetSection, Cached, MAX_BYTES, MAX_ENTRIES, RecordBudget, section};

use ace_core::section::{Loaded, Section, SourceError};
use ace_store::{Connection, Value as SqlValue, stmt_cache};
use std::collections::HashSet;
use std::rc::Rc;
use std::sync::Arc;

use crate::{EngineError, ThreadId};

/// The TypeScript's combined-patch limit, in UTF-16 code units (`records.ts:210`).
pub const MAX_PATCH_UNITS: usize = 32_768;

const SELECT_VALUE: &str =
    "SELECT value FROM engine_state_records WHERE thread_id=? AND section=? AND key=?";
const SELECT_APPENDS: &str =
    "SELECT patch FROM engine_state_appends WHERE thread_id=? AND section=? AND key=? ORDER BY id";
const SELECT_KEYS: &str =
    "SELECT key FROM engine_state_records WHERE thread_id=? AND section=? ORDER BY rowid";
const INSERT_APPEND: &str =
    "INSERT INTO engine_state_appends (thread_id,section,key,patch) VALUES (?, ?, ?, ?)";
const DELETE_APPENDS: &str =
    "DELETE FROM engine_state_appends WHERE thread_id=? AND section=? AND key=?";
const DELETE_RECORD: &str =
    "DELETE FROM engine_state_records WHERE thread_id=? AND section=? AND key=?";
const UPSERT_RECORD: &str = "INSERT INTO engine_state_records VALUES (?, ?, ?, ?) ON CONFLICT(thread_id,section,key) DO UPDATE SET value=excluded.value";

/// What one section's records decode to and how they are decorated and encoded.
pub struct SectionSpec<T> {
    /// The section's name, which is contract (`persistence.ts:120`).
    pub name: String,
    /// Validate the stored value without stripping (`parseRecord`).
    pub decode: fn(&ace_json::Value) -> Result<T, EngineError>,
    /// `RecordBudget::section` for this section.
    pub cache: BudgetSection,
}

/// The source a section's lazy reads go through: the shared budget, then SQLite.
/// How a section decorates a record it reads.
type Decorate<T> = Box<dyn Fn(&str, T) -> T>;
/// How a section encodes a record it writes.
type Encode<T> = Box<dyn Fn(&str, &T) -> Result<String, EngineError>>;

pub struct SqlSource<T> {
    conn: Arc<Connection>,
    thread: ThreadId,
    group: String,
    cache: BudgetSection,
    decode: fn(&ace_json::Value) -> Result<T, EngineError>,
    decorate: Decorate<T>,
}

impl<T: Clone + serde::Serialize + 'static> ace_core::section::RecordSource<T> for SqlSource<T> {
    fn load(&self, key: &str) -> Result<Option<Loaded<T>>, SourceError> {
        if let Some(cached) = self.cache.get::<T>(key) {
            return Ok(Some(Loaded {
                value: cached.value,
                json: cached.json,
            }));
        }
        let row = stmt_cache::get_row(
            &self.conn,
            SELECT_VALUE,
            vec![text(&self.thread), text(&self.group), text(key)],
        )
        .map_err(|error| SourceError::new(error.to_string()))?;
        let Some(row) = row else {
            return Ok(None);
        };
        let json = row
            .get("value")
            .and_then(text_of)
            .unwrap_or_default()
            .to_owned();
        let mut value =
            ace_json::parse(&json).map_err(|error| SourceError::new(error.to_string()))?;
        let mut bytes = json.len();
        let patches = stmt_cache::all_rows(
            &self.conn,
            SELECT_APPENDS,
            vec![text(&self.thread), text(&self.group), text(key)],
        )
        .map_err(|error| SourceError::new(error.to_string()))?;
        for row in patches {
            let patch_json = row.get("patch").and_then(text_of).unwrap_or_default();
            let patch = Append::parse(
                &ace_json::parse(patch_json)
                    .map_err(|error| SourceError::new(error.to_string()))?,
            )
            .map_err(SourceError::new)?;
            bytes += patch.text.len();
            value = restore_append(value, &patch).map_err(SourceError::new)?;
        }
        let decoded = (self.decode)(&value).map_err(|error| SourceError::new(error.to_string()))?;
        let value = Rc::new((self.decorate)(key, decoded));
        self.cache.set(
            key,
            Cached {
                value: Rc::clone(&value),
                json: json.clone(),
                bytes,
            },
            bytes,
        );
        Ok(Some(Loaded { value, json }))
    }

    fn keys(&self) -> Result<Vec<String>, SourceError> {
        let rows = stmt_cache::all_rows(
            &self.conn,
            SELECT_KEYS,
            vec![text(&self.thread), text(&self.group)],
        )
        .map_err(|error| SourceError::new(error.to_string()))?;
        Ok(rows
            .into_iter()
            .filter_map(|row| row.get("key").and_then(text_of).map(str::to_owned))
            .collect())
    }
}

/// One record dictionary: its lazy section plus the transaction overlay's write marks.
pub struct Records<T> {
    pub(crate) conn: Arc<Connection>,
    pub(crate) thread: ThreadId,
    pub(crate) group: String,
    pub(crate) section: Section<T>,
    pub(crate) cache: BudgetSection,
    decorate: Decorate<T>,
    encode: Encode<T>,
    append_value: Option<(String, T)>,
    pub(crate) replaced: HashSet<String>,
    pub(crate) appended: HashSet<String>,
    pub(crate) patches: indexmap::IndexMap<String, Vec<Append>>,
}

impl<T: Clone + serde::Serialize + 'static> Records<T> {
    /// A dictionary over one section. `initial` holds the records the state already had
    /// (empty for a stored section; an agent's `nativeRuns` seed their own section).
    pub fn new(
        conn: Arc<Connection>,
        _budget: &Rc<std::cell::RefCell<RecordBudget>>,
        thread: ThreadId,
        spec: SectionSpec<T>,
        initial: indexmap::IndexMap<String, T>,
        decorate: Option<Decorate<T>>,
        encode: Option<Encode<T>>,
    ) -> Records<T> {
        let decorate = decorate.unwrap_or_else(|| Box::new(|_key: &str, value: T| value));
        let source = Rc::new(SqlSource {
            conn: Arc::clone(&conn),
            thread: thread.clone(),
            group: spec.name.clone(),
            cache: spec.cache.clone(),
            decode: spec.decode,
            decorate: Box::new(|_key: &str, value: T| value),
        });
        let mut records = Records {
            conn,
            thread,
            group: spec.name,
            section: Section::lazy(source),
            cache: spec.cache,
            decorate,
            encode: encode.unwrap_or_else(|| {
                Box::new(|_key: &str, value: &T| {
                    ace_json::ser::to_string(value)
                        .map_err(|error| EngineError::Records(error.to_string()))
                })
            }),
            append_value: None,
            replaced: HashSet::new(),
            appended: HashSet::new(),
            patches: indexmap::IndexMap::new(),
        };
        for (key, value) in initial {
            records.write(&key, value);
        }
        records
    }

    /// The section's name.
    pub fn name(&self) -> &str {
        &self.group
    }

    /// `read` (`records.ts:118`): the append value, the overlay, the budget, then SQLite.
    pub fn read(&mut self, key: &str) -> Result<Option<T>, EngineError> {
        if let Some((current, value)) = &self.append_value
            && current == key
        {
            return Ok(Some(value.clone()));
        }
        self.section
            .load(key)
            .map_err(|error| EngineError::Records(error.to_string()))?;
        Ok(self.section.peek(key).cloned())
    }

    /// A read that must find the record: the engine's `requireState`-shaped record paths.
    pub fn require(&mut self, key: &str) -> Result<T, EngineError> {
        self.read(key)?
            .ok_or_else(|| EngineError::Records("Invalid snapshot record".to_owned()))
    }

    /// `write` (`records.ts:101`): validate (the caller already decoded), decorate, cache with
    /// the previous JSON, mark replaced.
    pub fn write(&mut self, key: &str, value: T) {
        self.tracking_access(true);
        let decorated = (self.decorate)(key, value);
        let previous = self
            .cache
            .get::<T>(key)
            .map(|cached| cached.json)
            .or_else(|| self.section.base_json(key).map(str::to_owned))
            .unwrap_or_default();
        let bytes = previous.len();
        self.cache.set(
            key,
            Cached {
                value: Rc::new(decorated.clone()),
                json: previous.clone(),
                bytes,
            },
            bytes,
        );
        self.section.set_base(key, previous);
        self.section.insert(key.to_owned(), decorated);
        self.replaced.insert(key.to_owned());
    }

    /// `delete` (`records.ts:83`): a touched absence and no cached entry.
    pub fn delete(&mut self, key: &str) {
        self.tracking_access(true);
        self.section.remove(key);
        self.cache.delete(key);
    }

    /// `keys` (`records.ts:158`): the stored keys plus the overlay, in JavaScript order.
    pub fn keys(&mut self) -> Result<Vec<String>, EngineError> {
        self.section
            .load_keys()
            .map_err(|error| EngineError::Records(error.to_string()))?;
        Ok(self.section.keys())
    }

    /// Whether this batch appended to the key (its full record predates the chunk).
    pub fn is_appended(&self, key: &str) -> bool {
        self.appended.contains(key)
    }

    /// `hasReplacement` (`records.ts:186`).
    pub fn has_replacement(&self, key: &str) -> bool {
        self.replaced.contains(key)
    }

    /// `useAppendValue` (`records.ts:189`): this read returns the metadata copy while the
    /// fact folds. [`Records::finish_append_value`] is the finish closure.
    pub fn set_append_value(&mut self, key: &str, value: T) {
        self.append_value = Some((key.to_owned(), value));
    }

    /// The finish closure of `useAppendValue` (`:190`-`:198`).
    pub fn finish_append_value(&mut self, key: &str) {
        self.append_value = None;
        if self.appended.contains(key) {
            // The full cached value predates this chunk. Materialize it only for a full read.
            self.cache.delete(key);
            self.section.forget(key);
        }
    }

    /// `append` (`records.ts:200`): skip when replaced or nothing is cached, coalesce inside a
    /// transaction, else insert at once.
    pub fn append(
        &mut self,
        key: &str,
        patch: Append,
        in_transaction: bool,
    ) -> Result<(), EngineError> {
        self.tracking_access(true);
        let entry = self.cache.get::<T>(key);
        let current = self
            .append_value
            .as_ref()
            .is_some_and(|(current, _)| current == key);
        let cached = entry.as_ref().is_some_and(|entry| !entry.json.is_empty());
        if self.replaced.contains(key) || (!cached && !current) {
            return Ok(());
        }
        if in_transaction {
            let patches = self.patches.entry(key.to_owned()).or_default();
            match patches.last_mut() {
                Some(previous)
                    if previous.path == patch.path
                        && units(&previous.text) + units(&patch.text) <= MAX_PATCH_UNITS =>
                {
                    previous.text.push_str(&patch.text);
                }
                _ => patches.push(patch.clone()),
            }
        } else {
            insert_patch(&self.conn, &self.thread, &self.group, key, &patch)?;
        }
        if let Some(mut entry) = entry {
            entry.bytes += patch.text.len();
            let bytes = entry.bytes;
            self.cache.set(key, entry, bytes);
        }
        self.appended.insert(key.to_owned());
        Ok(())
    }

    /// `begin` (`records.ts:228`): tracking on. The overlay records changes either way; the
    /// snapshot's persist runs every section that has them.
    pub fn begin(&mut self) {}

    /// `retainChanges` (`records.ts:231`): drop read values this batch cannot have changed.
    pub fn retain_changes(&mut self, keeps: impl Fn(&T) -> bool) {
        let drops: Vec<String> = self
            .section
            .changes()
            .into_iter()
            .filter_map(|(key, change)| match change {
                ace_core::section::Change::Written(value)
                    if !self.replaced.contains(&key)
                        && !self.appended.contains(&key)
                        && !keeps(value) =>
                {
                    Some(key)
                }
                _ => None,
            })
            .collect();
        for key in drops {
            self.section.forget(&key);
        }
    }

    /// `access(true)`: the section joins this transaction's persist list (the snapshot keeps
    /// every section and persists the ones with changes).
    fn tracking_access(&mut self, _write: bool) {}

    /// The keys this scope wrote, in overlay order (the snapshot's agent encode step).
    pub fn changes(&self) -> Vec<(String, ace_core::section::Change<'_, T>)> {
        self.section.changes()
    }

    /// Whether the section has changes or patches to persist.
    pub fn has_changes(&self) -> bool {
        !self.patches.is_empty() || self.section.has_changes()
    }

    /// The state's current value for a touched key, or its absence: the engine's adopt step
    /// after a fold, which is what the TypeScript's proxy sees as it is mutated in place.
    pub fn adopt(&mut self, key: &str, value: Option<T>) {
        if !self.section.is_loaded(key)
            && let Some(value) = value
        {
            // A key the fold created: a full record, as an assignment through the proxy.
            self.write(key, value);
            return;
        }
        match value {
            Some(value) => match self.section.get_mut(key) {
                Ok(Some(slot)) => *slot = value,
                _ => self.write(key, value),
            },
            None => {
                if self.section.is_loaded(key) {
                    self.section.remove(key);
                }
            }
        }
    }
}

pub(crate) fn text(value: &str) -> SqlValue {
    SqlValue::Text(value.to_owned())
}

/// A row cell as text.
pub(crate) fn text_of(value: &SqlValue) -> Option<&str> {
    match value {
        SqlValue::Text(text) => Some(text.as_str()),
        _ => None,
    }
}

pub(crate) fn insert_patch(
    conn: &Arc<Connection>,
    thread: &str,
    group: &str,
    key: &str,
    patch: &Append,
) -> Result<(), EngineError> {
    stmt_cache::run(
        conn,
        INSERT_APPEND,
        vec![text(thread), text(group), text(key), text(&patch.to_json())],
    )?;
    Ok(())
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}
