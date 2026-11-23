// SPDX-License-Identifier: Apache-2.0
//! Objects as JavaScript orders them: array-index keys (`"0"`..`"4294967294"`) first in
//! ascending order, then every other key in insertion order (`OrdinaryOwnPropertyKeys`).
//! Assigning an existing key keeps its place; removing one (`delete`) keeps the others' order.
//! `__proto__` is an ordinary own key, as `JSON.parse` creates it.

use indexmap::map::{IndexMap, Iter, IterMut, Keys, Values, ValuesMut};
use indexmap::{Equivalent, map::IntoIter};
use std::hash::{Hash, Hasher};

use crate::string::{JsString, hash_text};
use crate::value::{Value, drop_values};

type State = foldhash::fast::RandomState;

/// A JavaScript object's own enumerable properties, in JavaScript's order.
#[derive(Default)]
pub struct Map {
    entries: IndexMap<JsString, Value, State>,
    /// How many leading entries are array-index keys (kept sorted).
    indexed: usize,
}

/// The array index a key names, if any: canonical digits for 0..=2^32-2.
fn array_index(key: &str) -> Option<u32> {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || (bytes.len() > 1 && bytes.first() == Some(&b'0')) {
        return None;
    }
    let mut value: u64 = 0;
    for byte in bytes {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value * 10 + u64::from(byte - b'0');
    }
    (value < u64::from(u32::MAX)).then_some(value as u32)
}

fn index_of_key(key: &JsString) -> Option<u32> {
    key.as_well_formed().and_then(array_index)
}

/// A borrowed lookup key that hashes like a well-formed [`JsString`].
struct Lookup<'a>(&'a str);

impl Hash for Lookup<'_> {
    fn hash<H: Hasher>(&self, state: &mut H) {
        hash_text(self.0, state);
    }
}

impl Equivalent<JsString> for Lookup<'_> {
    fn equivalent(&self, key: &JsString) -> bool {
        key.as_well_formed() == Some(self.0)
    }
}

/// What a map can be indexed by: `&str`, `String` or a [`JsString`].
pub trait MapKey {
    #[doc(hidden)]
    fn locate(&self, map: &Map) -> Option<usize>;
}

impl MapKey for str {
    fn locate(&self, map: &Map) -> Option<usize> {
        map.entries.get_index_of(&Lookup(self))
    }
}

impl MapKey for String {
    fn locate(&self, map: &Map) -> Option<usize> {
        self.as_str().locate(map)
    }
}

impl MapKey for JsString {
    fn locate(&self, map: &Map) -> Option<usize> {
        map.entries.get_index_of(self)
    }
}

impl<T: MapKey + ?Sized> MapKey for &T {
    fn locate(&self, map: &Map) -> Option<usize> {
        (**self).locate(map)
    }
}

impl Map {
    pub fn new() -> Map {
        Map::default()
    }

    pub fn with_capacity(capacity: usize) -> Map {
        Map {
            entries: IndexMap::with_capacity_and_hasher(capacity, State::default()),
            indexed: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `object[key] = value`: replaces in place, else adds the key at JavaScript's position.
    /// Returns the value replaced.
    pub fn insert(&mut self, key: impl Into<JsString>, value: Value) -> Option<Value> {
        self.insert_full(key.into(), value).1
    }

    /// [`Map::insert`], also returning the slot's position.
    fn insert_full(&mut self, key: JsString, value: Value) -> (usize, Option<Value>) {
        if let Some((at, _, slot)) = self.entries.get_full_mut(&key) {
            return (at, Some(std::mem::replace(slot, value)));
        }
        match index_of_key(&key) {
            Some(index) => {
                let at = self.indexed_position(index);
                self.entries.shift_insert(at, key, value);
                self.indexed += 1;
                (at, None)
            }
            None => (self.entries.insert_full(key, value).0, None),
        }
    }

    /// Where a new array-index key goes among the sorted leading index keys.
    fn indexed_position(&self, index: u32) -> usize {
        let (mut low, mut high) = (0, self.indexed);
        while low < high {
            let mid = low + (high - low) / 2;
            let at = self
                .entries
                .get_index(mid)
                .and_then(|(key, _)| index_of_key(key))
                .unwrap_or(u32::MAX);
            if at < index {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        low
    }

    pub fn get<Q: MapKey + ?Sized>(&self, key: &Q) -> Option<&Value> {
        key.locate(self)
            .and_then(|at| self.entries.get_index(at))
            .map(|(_, value)| value)
    }

    pub fn get_mut<Q: MapKey + ?Sized>(&mut self, key: &Q) -> Option<&mut Value> {
        key.locate(self)
            .and_then(|at| self.entries.get_index_mut(at))
            .map(|(_, value)| value)
    }

    pub fn get_key_value<Q: MapKey + ?Sized>(&self, key: &Q) -> Option<(&JsString, &Value)> {
        key.locate(self).and_then(|at| self.entries.get_index(at))
    }

    pub fn contains_key<Q: MapKey + ?Sized>(&self, key: &Q) -> bool {
        key.locate(self).is_some()
    }

    /// `delete object[key]`: the others keep their order.
    pub fn remove<Q: MapKey + ?Sized>(&mut self, key: &Q) -> Option<Value> {
        let at = key.locate(self)?;
        let (key, value) = self.entries.shift_remove_index(at)?;
        if index_of_key(&key).is_some() {
            self.indexed -= 1;
        }
        Some(value)
    }

    /// The same as [`Map::remove`]; named for code ported from `IndexMap`.
    pub fn shift_remove<Q: MapKey + ?Sized>(&mut self, key: &Q) -> Option<Value> {
        self.remove(key)
    }

    pub fn entry(&mut self, key: impl Into<JsString>) -> Entry<'_> {
        Entry {
            map: self,
            key: key.into(),
        }
    }

    pub fn get_index(&self, index: usize) -> Option<(&JsString, &Value)> {
        self.entries.get_index(index)
    }

    pub fn first(&self) -> Option<(&JsString, &Value)> {
        self.entries.first()
    }

    pub fn last(&self) -> Option<(&JsString, &Value)> {
        self.entries.last()
    }

    pub fn iter(&self) -> Iter<'_, JsString, Value> {
        self.entries.iter()
    }

    pub fn iter_mut(&mut self) -> IterMut<'_, JsString, Value> {
        self.entries.iter_mut()
    }

    pub fn keys(&self) -> Keys<'_, JsString, Value> {
        self.entries.keys()
    }

    pub fn values(&self) -> Values<'_, JsString, Value> {
        self.entries.values()
    }

    pub fn values_mut(&mut self) -> ValuesMut<'_, JsString, Value> {
        self.entries.values_mut()
    }

    /// Keep the entries `keep` accepts, in order.
    pub fn retain(&mut self, mut keep: impl FnMut(&JsString, &mut Value) -> bool) {
        self.entries.retain(|key, value| keep(key, value));
        self.indexed = self
            .entries
            .keys()
            .take_while(|key| index_of_key(key).is_some())
            .count();
    }

    /// `Object.assign(this, other)`, draining `other`.
    pub fn append(&mut self, other: &mut Map) {
        for (key, value) in std::mem::take(other) {
            self.insert(key, value);
        }
    }

    pub fn clear(&mut self) {
        drop_values(std::mem::take(&mut self.entries).into_values().collect());
        self.indexed = 0;
    }

    pub(crate) fn take_values(&mut self) -> Vec<Value> {
        self.indexed = 0;
        std::mem::take(&mut self.entries).into_values().collect()
    }

    /// Insert during an iterative clone: the source map's order is already JavaScript's.
    pub(crate) fn push_ordered(&mut self, key: JsString, value: Value) {
        if index_of_key(&key).is_some() {
            self.indexed += 1;
        }
        self.entries.insert(key, value);
    }
}

impl Drop for Map {
    fn drop(&mut self) {
        if !self.entries.is_empty() {
            drop_values(self.take_values());
        }
    }
}

/// A key's slot, from [`Map::entry`].
pub struct Entry<'a> {
    map: &'a mut Map,
    key: JsString,
}

impl<'a> Entry<'a> {
    pub fn or_insert(self, value: Value) -> &'a mut Value {
        self.or_insert_with(|| value)
    }

    pub fn or_insert_with(self, make: impl FnOnce() -> Value) -> &'a mut Value {
        let at = match self.map.entries.get_index_of(&self.key) {
            Some(at) => at,
            None => self.map.insert_full(self.key, make()).0,
        };
        // `at` is the slot just found or inserted.
        &mut self.map.entries[at]
    }

    pub fn key(&self) -> &JsString {
        &self.key
    }
}

impl Clone for Map {
    fn clone(&self) -> Map {
        crate::value::clone_map(self)
    }
}

impl PartialEq for Map {
    fn eq(&self, other: &Map) -> bool {
        crate::value::maps_equal(self, other)
    }
}

impl std::fmt::Debug for Map {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut out = String::new();
        crate::write::write_map(&mut out, self);
        f.write_str(&out)
    }
}

impl IntoIterator for Map {
    type Item = (JsString, Value);
    type IntoIter = IntoIter<JsString, Value>;
    fn into_iter(mut self) -> Self::IntoIter {
        self.indexed = 0;
        std::mem::take(&mut self.entries).into_iter()
    }
}

impl<'a> IntoIterator for &'a Map {
    type Item = (&'a JsString, &'a Value);
    type IntoIter = Iter<'a, JsString, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter()
    }
}

impl<'a> IntoIterator for &'a mut Map {
    type Item = (&'a JsString, &'a mut Value);
    type IntoIter = IterMut<'a, JsString, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.entries.iter_mut()
    }
}

impl<K: Into<JsString>> FromIterator<(K, Value)> for Map {
    fn from_iter<I: IntoIterator<Item = (K, Value)>>(iter: I) -> Map {
        let mut map = Map::new();
        map.extend(iter);
        map
    }
}

impl<K: Into<JsString>> Extend<(K, Value)> for Map {
    fn extend<I: IntoIterator<Item = (K, Value)>>(&mut self, iter: I) {
        for (key, value) in iter {
            self.insert(key, value);
        }
    }
}
