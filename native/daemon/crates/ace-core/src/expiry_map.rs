// SPDX-License-Identifier: Apache-2.0
//! The indexed min-heap of `expiry-map.ts`: expiry visits only due entries,
//! deletion retains no tombstones. The deadline index builds on it.

use std::collections::HashMap;

/// One heap entry: a key with its value and expiry.
struct Entry<T> {
    key: String,
    value: T,
    expires_at: i64,
}

/// An indexed min-heap keyed by expiry.
pub struct ExpiryMap<T> {
    heap: Vec<Entry<T>>,
    indexes: HashMap<String, usize>,
}

impl<T> ExpiryMap<T> {
    /// Create an empty map.
    pub fn new() -> Self {
        Self {
            heap: Vec::new(),
            indexes: HashMap::new(),
        }
    }

    /// The earliest entry, if any.
    pub fn first(&self) -> Option<(&str, &T, i64)> {
        self.heap
            .first()
            .map(|entry| (entry.key.as_str(), &entry.value, entry.expires_at))
    }

    /// Drop every entry.
    pub fn clear(&mut self) {
        self.heap.clear();
        self.indexes.clear();
    }

    /// The number of entries.
    pub fn len(&self) -> usize {
        self.heap.len()
    }

    /// Whether the map holds no entry.
    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }

    /// The expiry of one key, if present.
    pub fn deadline(&self, key: &str) -> Option<i64> {
        self.indexes
            .get(key)
            .and_then(|index| self.heap.get(*index))
            .map(|entry| entry.expires_at)
    }

    /// The value of one key, if present.
    pub fn get(&self, key: &str) -> Option<&T> {
        self.indexes
            .get(key)
            .and_then(|index| self.heap.get(*index))
            .map(|entry| &entry.value)
    }

    /// Insert or replace one key.
    pub fn set(&mut self, key: String, value: T, expires_at: i64) {
        self.delete(&key.clone());
        let index = self.heap.len();
        self.heap.push(Entry {
            key: key.clone(),
            value,
            expires_at,
        });
        self.indexes.insert(key, index);
        self.up(index);
    }

    /// Delete one key, returning its value.
    pub fn delete(&mut self, key: &str) -> Option<T> {
        let index = self.indexes.get(key).copied()?;
        Some(self.remove(index).value)
    }

    /// Drain every entry due at `now`, earliest first.
    pub fn expire(&mut self, now: i64) -> Vec<(String, T)> {
        let mut due = Vec::new();
        while self
            .heap
            .first()
            .is_some_and(|entry| entry.expires_at <= now)
        {
            let entry = self.remove(0);
            due.push((entry.key, entry.value));
        }
        due
    }

    fn at(&self, index: usize) -> Option<&Entry<T>> {
        self.heap.get(index)
    }

    fn swap(&mut self, left: usize, right: usize) {
        if left == right || self.at(left).is_none() || self.at(right).is_none() {
            return;
        }
        self.heap.swap(left, right);
        let left_key = self.heap[left].key.clone();
        let right_key = self.heap[right].key.clone();
        self.indexes.insert(left_key, left);
        self.indexes.insert(right_key, right);
    }

    fn up(&mut self, start: usize) -> usize {
        let mut index = start;
        while index > 0 {
            let parent = (index - 1) / 2;
            let move_up = match (self.at(parent), self.at(index)) {
                (Some(parent), Some(current)) => parent.expires_at > current.expires_at,
                _ => false,
            };
            if !move_up {
                break;
            }
            self.swap(parent, index);
            index = parent;
        }
        index
    }

    fn down(&mut self, start: usize) {
        let mut index = start;
        while 2 * index + 1 < self.heap.len() {
            let mut child = 2 * index + 1;
            if child + 1 < self.heap.len() {
                let left_first = match (self.at(child + 1), self.at(child)) {
                    (Some(right), Some(left)) => right.expires_at < left.expires_at,
                    _ => false,
                };
                if left_first {
                    child += 1;
                }
            }
            let move_down = match (self.at(index), self.at(child)) {
                (Some(current), Some(child)) => current.expires_at > child.expires_at,
                _ => false,
            };
            if !move_down {
                break;
            }
            self.swap(index, child);
            index = child;
        }
    }

    fn remove(&mut self, index: usize) -> Entry<T> {
        let entry = self.heap.swap_remove(index);
        self.indexes.remove(&entry.key);
        if index < self.heap.len() {
            let key = self.heap[index].key.clone();
            self.indexes.insert(key, index);
            let settled = self.up(index);
            self.down(settled);
        }
        entry
    }
}

impl<T> Default for ExpiryMap<T> {
    fn default() -> Self {
        Self::new()
    }
}
