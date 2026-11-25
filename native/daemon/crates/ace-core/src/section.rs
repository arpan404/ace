// SPDX-License-Identifier: Apache-2.0
//! The lazy record sections of a decoded thread state (E5.3 step 3, `records.ts`).
//!
//! A section holds one kind of record keyed by its native key. It has one of two sources:
//!
//! - **Resident (the default).** No source: every entry lives in an `IndexMap` and the
//!   section behaves exactly as the plain maps it replaces, including serde-driven JSON order.
//!   `@ace/core`'s facade, `ace-core-wasm` and every core test use this form.
//! - **Lazy.** A [`RecordSource`]: records come from the engine's shared record budget, then
//!   SQLite, one key at a time. The section itself holds only the current scope's overlay, so
//!   no second resident map sits beside the budget.
//!
//! **The overlay** holds what the current scope read or wrote: `Read(Rc<T>)`, `Written(T)` or
//! `Deleted`, plus each read's base JSON (the TypeScript `originals`). It is cleared by
//! [`Section::committed`] and by [`Section::end_untracked`] at the end of a read that ran
//! outside a transaction, so it holds at most what one batch or one read touched.
//!
//! **Edits reach the overlay only through [`Section::get_mut`], [`Section::insert`] and
//! [`Section::remove`].** `get_mut` turns a `Read(Rc<T>)` into `Written(T)` by
//! `Rc::unwrap_or_clone`, as the TypeScript treats a value read while tracking as possibly
//! mutated in place (`records.ts:146`).
//!
//! **Sections the core enumerates.** A fresh grep before writing this found these read by the
//! whole section rather than by key, so a lazy section must call [`Section::load_keys`] first:
//! `agents` (nine sites) and the four live indexes `liveTools`, `pendingInteractions`,
//! `runningTasks` and `openText` (`indexes.rs:128`-`:179`). Every other section is reached only
//! by key.

use indexmap::IndexMap;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

/// A load or enumeration that failed. The engine maps it to the error the TypeScript throws
/// there: `Invalid snapshot record` (`records.ts:16`) or the SQLite error.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct SourceError {
    pub message: String,
}

impl SourceError {
    pub fn new(message: impl Into<String>) -> SourceError {
        SourceError {
            message: message.into(),
        }
    }
}

/// One record as the source holds it: the decoded value and its base JSON (the stored record
/// without its appends), which persist compares a change against.
pub struct Loaded<T> {
    pub value: Rc<T>,
    pub json: String,
}

/// Where a lazy section reads from: the engine's budget, then SQLite (E5.3 step 4).
pub trait RecordSource<T> {
    /// An owned handle: the budget keeps its own `Rc`.
    fn load(&self, key: &str) -> Result<Option<Loaded<T>>, SourceError>;
    /// Stored keys in the TypeScript `ownKeys` query's order (`records.ts:153`).
    fn keys(&self) -> Result<Vec<String>, SourceError>;
}

/// One slot of the overlay.
enum Slot<T> {
    Read(Rc<T>),
    Written(T),
    Deleted,
}

/// One pending change, for the engine's persist.
pub enum Change<'a, T> {
    Written(&'a T),
    Deleted,
}

/// One record dictionary: resident, or lazy over a [`RecordSource`].
pub struct Section<T> {
    eager: Option<IndexMap<String, T>>,
    source: Option<Rc<dyn RecordSource<T>>>,
    overlay: IndexMap<String, Slot<T>>,
    base: HashMap<String, String>,
    /// Keys this scope loaded and the source did not have, so `peek` answers `None` without
    /// a failed assertion.
    absent: HashSet<String>,
    enumeration: Option<Vec<String>>,
}

impl<T> Default for Section<T> {
    fn default() -> Section<T> {
        Section::eager(IndexMap::new())
    }
}

impl<T> Section<T> {
    /// A resident section over `map`: the form every core caller and test uses.
    pub fn eager(map: IndexMap<String, T>) -> Section<T> {
        Section {
            eager: Some(map),
            source: None,
            overlay: IndexMap::new(),
            base: HashMap::new(),
            absent: HashSet::new(),
            enumeration: None,
        }
    }

    /// A lazy section: nothing resident, every miss goes to `source`.
    pub fn lazy(source: Rc<dyn RecordSource<T>>) -> Section<T> {
        Section {
            eager: None,
            source: Some(source),
            overlay: IndexMap::new(),
            base: HashMap::new(),
            absent: HashSet::new(),
            enumeration: None,
        }
    }

    /// Whether every entry is resident (the default, source-less form).
    pub fn is_eager(&self) -> bool {
        self.eager.is_some()
    }

    /// The resident map, for a section with no source.
    pub fn resident(&self) -> Option<&IndexMap<String, T>> {
        self.eager.as_ref()
    }

    /// The resident map for editing, for a section with no source.
    pub fn resident_mut(&mut self) -> Option<&mut IndexMap<String, T>> {
        self.eager.as_mut()
    }

    /// Ensure `key` is in the overlay. A resident section already holds it; a lazy one reads
    /// it once and keeps the handle for this scope.
    pub fn load(&mut self, key: &str) -> Result<(), SourceError> {
        if self.eager.is_some() || self.overlay.contains_key(key) || self.absent.contains(key) {
            return Ok(());
        }
        let Some(source) = self.source.as_ref() else {
            return Ok(());
        };
        if let Some(loaded) = source.load(key)? {
            self.base.insert(key.to_owned(), loaded.json);
            self.overlay
                .insert(key.to_owned(), Slot::Read(loaded.value));
        } else {
            self.absent.insert(key.to_owned());
        }
        Ok(())
    }

    /// Ensure the enumeration: stored keys plus the overlay, in the TypeScript `ownKeys`
    /// order (`records.ts:171`).
    pub fn load_keys(&mut self) -> Result<(), SourceError> {
        if self.eager.is_some() || self.enumeration.is_some() {
            return Ok(());
        }
        let Some(source) = self.source.as_ref() else {
            return Ok(());
        };
        let stored = source.keys()?;
        self.enumeration = Some(js_key_order(merge_keys(stored, &self.overlay)));
        Ok(())
    }

    /// The value in the overlay or the resident map. A key not loaded is a bug: `None` in
    /// release, a failed assertion in tests.
    pub fn peek(&self, key: &str) -> Option<&T> {
        if let Some(map) = &self.eager {
            return map.get(key);
        }
        match self.overlay.get(key) {
            Some(Slot::Read(value)) => Some(value),
            Some(Slot::Written(value)) => Some(value),
            Some(Slot::Deleted) => None,
            None => {
                debug_assert!(
                    self.absent.contains(key),
                    "section key {key} was peeked before load: load it first"
                );
                None
            }
        }
    }

    /// The current value for writing, copying a read into the overlay once.
    pub fn get_mut(&mut self, key: &str) -> Result<Option<&mut T>, SourceError>
    where
        T: Clone,
    {
        if self.eager.is_none() && !self.overlay.contains_key(key) {
            self.load(key)?;
        }
        let Section { eager, overlay, .. } = self;
        if let Some(map) = eager {
            return Ok(map.get_mut(key));
        }
        let read = match overlay.get(key) {
            Some(Slot::Read(value)) => Some(Rc::clone(value)),
            _ => None,
        };
        if let Some(value) = read {
            let owned = Rc::unwrap_or_clone(value);
            overlay.insert(key.to_owned(), Slot::Written(owned));
        }
        Ok(match overlay.get_mut(key) {
            Some(Slot::Written(value)) => Some(value),
            _ => None,
        })
    }

    /// A written key.
    pub fn insert(&mut self, key: String, value: T) {
        if let Some(map) = &mut self.eager {
            map.insert(key, value);
            return;
        }
        self.absent.remove(&key);
        let added = key.clone();
        self.overlay.insert(key, Slot::Written(value));
        if let Some(enumeration) = &mut self.enumeration
            && !enumeration.iter().any(|seen| seen == &added)
        {
            enumeration.push(added);
        }
    }

    /// A deleted key.
    pub fn remove(&mut self, key: &str) -> Option<T>
    where
        T: Clone,
    {
        if let Some(map) = &mut self.eager {
            return map.shift_remove(key);
        }
        let previous = match self.overlay.insert(key.to_owned(), Slot::Deleted) {
            Some(Slot::Written(value)) => Some(value),
            Some(Slot::Read(value)) => Some(Rc::unwrap_or_clone(value)),
            _ => None,
        };
        if let Some(enumeration) = &mut self.enumeration {
            enumeration.retain(|seen| seen != key);
        }
        previous
    }

    /// Every key, after [`Section::load_keys`] for a lazy section.
    pub fn keys(&self) -> Vec<String> {
        if let Some(map) = &self.eager {
            return map.keys().cloned().collect();
        }
        self.enumeration.clone().unwrap_or_default()
    }

    /// The base JSON of a key read in this scope, for persist's change test.
    pub fn base_json(&self, key: &str) -> Option<&str> {
        self.base.get(key).map(String::as_str)
    }

    /// Record a key's base JSON when a write decides it (the TypeScript `originals`).
    pub fn set_base(&mut self, key: &str, json: String) {
        self.absent.remove(key);
        self.base.insert(key.to_owned(), json);
    }

    /// Whether this scope loaded `key` (a value or a miss).
    pub fn is_loaded(&self, key: &str) -> bool {
        self.eager.is_some() || self.overlay.contains_key(key) || self.absent.contains(key)
    }

    /// Every written and deleted slot, with the value the engine persists.
    pub fn changes(&self) -> Vec<(String, Change<'_, T>)> {
        let mut result = Vec::new();
        for (key, slot) in &self.overlay {
            match slot {
                Slot::Written(value) => result.push((key.clone(), Change::Written(value))),
                Slot::Deleted => result.push((key.clone(), Change::Deleted)),
                Slot::Read(_) => {}
            }
        }
        result
    }

    /// Drop a key's overlay slot without recording a deletion: a value the batch cannot have
    /// changed (the TypeScript's `retainChanges`).
    pub fn forget(&mut self, key: &str) {
        self.overlay.shift_remove(key);
        self.base.remove(key);
        self.absent.remove(key);
    }

    /// Whether the section holds a written or deleted slot.
    pub fn has_changes(&self) -> bool {
        self.overlay
            .values()
            .any(|slot| !matches!(slot, Slot::Read(_)))
    }

    /// Whether `key` holds a written or deleted slot.
    pub fn is_changed(&self, key: &str) -> bool {
        matches!(
            self.overlay.get(key),
            Some(Slot::Written(_)) | Some(Slot::Deleted)
        )
    }

    /// Clear the overlay and the enumeration: the transaction committed.
    pub fn committed(&mut self) {
        self.overlay.clear();
        self.base.clear();
        self.absent.clear();
        self.enumeration = None;
    }

    /// End a read that ran outside a transaction: its overlay entries are not changes.
    pub fn end_untracked(&mut self) {
        self.committed();
    }

    /// The section's share of the shared budget goes; later reads are uncached.
    pub fn clear(&mut self) {
        self.overlay.clear();
        self.base.clear();
        self.absent.clear();
        self.enumeration = None;
    }
}

impl<T: Clone> Clone for Section<T> {
    fn clone(&self) -> Section<T> {
        Section {
            eager: self.eager.clone(),
            source: self.source.clone(),
            overlay: match &self.source {
                Some(_) => IndexMap::new(),
                None => IndexMap::new(),
            },
            base: HashMap::new(),
            absent: HashSet::new(),
            enumeration: None,
        }
    }
}

fn merge_keys(stored: Vec<String>, overlay: &IndexMap<String, impl Sized>) -> Vec<String> {
    let mut keys: Vec<String> = stored;
    let mut seen: HashSet<String> = keys.iter().cloned().collect();
    for key in overlay.keys() {
        if seen.insert(key.clone()) {
            keys.push(key.clone());
        }
    }
    keys
}

/// JavaScript object key order (`Object.keys(Object.fromEntries(...))`, `records.ts:171`):
/// integer-like keys first, in ascending numeric order, then the rest in insertion order.
pub fn js_key_order(keys: Vec<String>) -> Vec<String> {
    let mut indexes: Vec<(u32, String)> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    for key in keys {
        match array_index(&key) {
            Some(index) => indexes.push((index, key)),
            None => rest.push(key),
        }
    }
    indexes.sort_by_key(|(index, _)| *index);
    let mut ordered: Vec<String> = indexes.into_iter().map(|(_, key)| key).collect();
    ordered.append(&mut rest);
    ordered
}

/// A canonical array index: `0`, or a positive decimal with no leading zero, below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes.len() > 1 && bytes[0] == b'0') {
        return None;
    }
    let mut value: u64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(byte - b'0');
    }
    if value >= u64::from(u32::MAX) {
        return None;
    }
    Some(value as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Memory(std::cell::RefCell<HashMap<String, String>>);

    impl RecordSource<String> for Memory {
        fn load(&self, key: &str) -> Result<Option<Loaded<String>>, SourceError> {
            Ok(self.0.borrow().get(key).map(|json| Loaded {
                value: Rc::new(json.clone()),
                json: json.clone(),
            }))
        }

        fn keys(&self) -> Result<Vec<String>, SourceError> {
            Ok(self.0.borrow().keys().cloned().collect())
        }
    }

    fn lazy(entries: &[(&str, &str)]) -> Section<String> {
        let map: HashMap<String, String> = entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect();
        Section::lazy(Rc::new(Memory(std::cell::RefCell::new(map))))
    }

    #[test]
    fn a_section_without_a_source_keeps_every_entry_and_its_order() {
        let mut section = Section::eager(IndexMap::new());
        section.insert("b".to_owned(), "2".to_owned());
        section.insert("a".to_owned(), "1".to_owned());
        assert_eq!(section.keys(), vec!["b".to_owned(), "a".to_owned()]);
        assert_eq!(section.peek("a"), Some(&"1".to_owned()));
        assert!(section.changes().is_empty());
    }

    #[test]
    fn a_lazy_read_takes_the_base_json_and_writes_only_after_get_mut() {
        let mut section = lazy(&[("k", "{\"a\":1}")]);
        section.load("k").unwrap();
        assert_eq!(section.peek("k"), Some(&"{\"a\":1}".to_owned()));
        assert_eq!(section.base_json("k"), Some("{\"a\":1}"));
        assert!(section.changes().is_empty(), "a read is not a write");
        section.get_mut("k").unwrap().unwrap().push('!');
        let changes = section.changes();
        assert_eq!(changes.len(), 1);
        assert!(matches!(changes[0].1, Change::Written(value) if value == "{\"a\":1}!"));
    }

    #[test]
    fn enumeration_is_javascript_order_over_stored_keys_then_the_overlay() {
        let mut section = lazy(&[("10", "j"), ("2", "j"), ("b", "j"), ("a", "j")]);
        section.load_keys().unwrap();
        section.insert("c".to_owned(), "j".to_owned());
        section.remove("b");
        assert_eq!(
            section.keys(),
            vec![
                "2".to_owned(),
                "10".to_owned(),
                "a".to_owned(),
                "c".to_owned()
            ]
        );
    }

    #[test]
    fn committed_clears_the_overlay_and_a_remove_is_a_deletion_change() {
        let mut section = lazy(&[("k", "1")]);
        section.load("k").unwrap();
        section.remove("k");
        assert!(matches!(section.changes()[0].1, Change::Deleted));
        section.committed();
        assert!(section.changes().is_empty());
        assert_eq!(section.base_json("k"), None);
    }
}
