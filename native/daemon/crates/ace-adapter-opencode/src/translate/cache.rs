// SPDX-License-Identifier: Apache-2.0
//! Bounded reconciliation windows (`packages/adapter-opencode/src/cache.ts`).
//! Live entities are kept separately by their owner. Maps keep TypeScript
//! insertion order (IndexMap), so facts that enumerate them keep their order.

use indexmap::IndexMap;
use std::collections::{HashSet, VecDeque};

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
    map: IndexMap<String, V>,
    limit: usize,
}

impl<V> RecentMap<V> {
    pub fn new(limit: usize) -> Self {
        Self {
            map: IndexMap::new(),
            limit,
        }
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.map.get(key)
    }

    /// `Map.delete`: drops the entry, keeping the others' order.
    pub fn delete(&mut self, key: &str) {
        self.map.shift_remove(key);
    }

    pub fn set(&mut self, key: String, value: V) {
        self.map.shift_remove(&key);
        self.map.insert(key, value);
        while self.map.len() > self.limit {
            self.map.shift_remove_index(0);
        }
    }
}
