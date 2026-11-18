// SPDX-License-Identifier: Apache-2.0

//! A small LRU for the per-folder caches.
//!
//! Folder listings are bounded by how many entries they hold rather than by how many folders are
//! open, because one folder of 100,000 files costs far more than a hundred folders of ten. A value
//! the caller is already holding is handed out as an `Arc`, so eviction never pulls it out from
//! under a request in flight.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

/// Values with a weight, evicted least recently used first once their total weight passes the
/// capacity.
pub(crate) struct Lru<V> {
    capacity: usize,
    weight: usize,
    order: VecDeque<String>,
    values: HashMap<String, (Arc<V>, usize)>,
}

impl<V> Lru<V> {
    pub(crate) fn new(capacity: usize) -> Lru<V> {
        Lru {
            capacity,
            weight: 0,
            order: VecDeque::new(),
            values: HashMap::new(),
        }
    }

    /// The value for `key`, marked as the most recently used.
    pub(crate) fn get(&mut self, key: &str) -> Option<Arc<V>> {
        let value = Arc::clone(&self.values.get(key)?.0);
        self.touch(key);
        Some(value)
    }

    /// Stores `value`, dropping the least recently used values until it fits. A value heavier than
    /// the whole capacity is not stored; the caller still gets to use it.
    pub(crate) fn insert(&mut self, key: &str, value: Arc<V>, weight: usize) {
        if let Some((_, previous)) = self.values.remove(key) {
            self.weight -= previous;
            self.order.retain(|existing| existing != key);
        }
        if weight > self.capacity {
            return;
        }
        while self.weight + weight > self.capacity {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some((_, dropped)) = self.values.remove(&oldest) {
                self.weight -= dropped;
            }
        }
        self.weight += weight;
        self.order.push_back(key.to_owned());
        self.values.insert(key.to_owned(), (value, weight));
    }

    /// Drops every value whose key `keep` rejects.
    pub(crate) fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        let mut weight = 0;
        self.values.retain(|key, (_, value_weight)| {
            let kept = keep(key);
            if kept {
                weight += *value_weight;
            }
            kept
        });
        self.weight = weight;
        let values = &self.values;
        self.order.retain(|key| values.contains_key(key));
    }

    fn touch(&mut self, key: &str) {
        self.order.retain(|existing| existing != key);
        self.order.push_back(key.to_owned());
    }
}
