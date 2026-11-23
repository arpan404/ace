// SPDX-License-Identifier: Apache-2.0
//! Bounded reconciliation windows (`packages/adapter-opencode/src/cache.ts`).
//! Live entities are kept separately by their owner. Iteration follows
//! insertion order the way the TypeScript maps do, so facts that enumerate
//! them (disconnect broadcasts, tool tails, dispatch claims) keep their order.

use std::collections::{HashSet, VecDeque};

/// An insertion-ordered string map. Setting an existing key keeps its place,
/// like the TypeScript `Map`; linear scans are fast enough for these sizes
/// (at most a few thousand entries) and keep every order exact.
#[derive(Debug)]
pub struct OrderedMap<V> {
    entries: Vec<(String, V)>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self {
            entries: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn has(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    /// Set a key, keeping an existing key's place.
    pub fn set(&mut self, key: String, value: V) {
        match self.entries.iter_mut().find(|(k, _)| *k == key) {
            Some((_, slot)) => *slot = value,
            None => self.entries.push((key, value)),
        }
    }

    pub fn delete(&mut self, key: &str) -> Option<V> {
        match self.entries.iter().position(|(k, _)| k == key) {
            Some(index) => Some(self.entries.remove(index).1),
            None => None,
        }
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn first(&self) -> Option<(&str, &V)> {
        self.entries.first().map(|(k, v)| (k.as_str(), v))
    }
}

/// A reconciliation window over keys. Re-adding an existing key keeps its
/// place; past the bound the oldest key is evicted.
#[derive(Debug, Default)]
pub struct RecentSet {
    seen: HashSet<String>,
    order: VecDeque<String>,
}

impl RecentSet {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    pub fn has(&self, key: &str) -> bool {
        self.seen.contains(key)
    }

    pub fn add(&mut self, key: &str) {
        if self.seen.insert(key.to_owned()) {
            self.order.push_back(key.to_owned());
            while self.order.len() > 1024 {
                if let Some(oldest) = self.order.pop_front() {
                    self.seen.remove(&oldest);
                }
            }
        }
    }
}

/// A reconciliation window over entries. Setting moves the key to the newest
/// end; past the limit the oldest entry is evicted.
#[derive(Debug)]
pub struct RecentMap<V> {
    map: OrderedMap<V>,
    limit: usize,
}

impl<V> RecentMap<V> {
    pub fn new(limit: usize) -> Self {
        Self {
            map: OrderedMap::new(),
            limit,
        }
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }

    pub fn set(&mut self, key: String, value: V) {
        self.map.delete(&key);
        self.map.set(key, value);
        while self.map.len() > self.limit {
            if let Some((oldest, _)) = self.map.first() {
                let oldest = oldest.to_owned();
                self.map.delete(&oldest);
            } else {
                break;
            }
        }
    }
}
