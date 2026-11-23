// SPDX-License-Identifier: Apache-2.0
//! Missing terminal edges with deadlines (the port of `missing-edges.ts`).
//! An indexed min-heap: reads are constant time, updates and expirations
//! logarithmic. Bookkeeping only, never in the transcript.

pub struct MissingEdges {
    heap: Vec<Edge>,
    positions: std::collections::HashMap<String, usize>,
}

struct Edge {
    id: String,
    at: i64,
}

impl MissingEdges {
    pub fn new() -> Self {
        MissingEdges {
            heap: Vec::new(),
            positions: std::collections::HashMap::new(),
        }
    }

    pub fn next_deadline(&self) -> Option<i64> {
        self.heap.first().map(|edge| edge.at)
    }

    pub fn set(&mut self, id: &str, at: i64) {
        if let Some(&existing) = self.positions.get(id) {
            if let Some(edge) = self.heap.get_mut(existing) {
                edge.at = at;
                self.repair(existing);
            }
            return;
        }
        let index = self.heap.len();
        self.heap.push(Edge {
            id: id.to_owned(),
            at,
        });
        self.positions.insert(id.to_owned(), index);
        self.up(index);
    }

    pub fn delete(&mut self, id: &str) {
        let index = match self.positions.remove(id) {
            Some(index) => index,
            None => return,
        };
        let last = match self.heap.pop() {
            Some(last) => last,
            None => return,
        };
        if index == self.heap.len() {
            return;
        }
        self.heap[index] = last;
        let moved = self.heap[index].id.clone();
        self.positions.insert(moved, index);
        self.repair(index);
    }

    pub fn expired(&mut self, now: i64) -> Vec<String> {
        let mut ids = Vec::new();
        loop {
            let due = self
                .heap
                .first()
                .map(|edge| edge.at <= now)
                .unwrap_or(false);
            if !due {
                break;
            }
            let id = self
                .heap
                .first()
                .map(|edge| edge.id.clone())
                .unwrap_or_default();
            self.delete(&id);
            if !id.is_empty() {
                ids.push(id);
            } else {
                break;
            }
        }
        ids
    }

    pub fn clear(&mut self) {
        self.heap.clear();
        self.positions.clear();
    }

    fn repair(&mut self, index: usize) {
        if index == 0 {
            self.down(index);
            return;
        }
        let parent = (index - 1) / 2;
        let above = self.heap.get(parent).map(|e| e.at).unwrap_or(i64::MAX);
        let here = self.heap.get(index).map(|e| e.at).unwrap_or(i64::MAX);
        if index > 0 && here < above {
            self.up(index);
        } else {
            self.down(index);
        }
    }

    fn up(&mut self, mut index: usize) {
        while index > 0 {
            let parent = (index - 1) / 2;
            let above = self.heap.get(parent).map(|e| e.at).unwrap_or(i64::MAX);
            let here = self.heap.get(index).map(|e| e.at).unwrap_or(i64::MAX);
            if here >= above {
                return;
            }
            self.swap(index, parent);
            index = parent;
        }
    }

    fn down(&mut self, mut index: usize) {
        loop {
            let left = index * 2 + 1;
            let right = left + 1;
            let left_at = self.heap.get(left).map(|e| e.at).unwrap_or(i64::MAX);
            let right_at = self.heap.get(right).map(|e| e.at).unwrap_or(i64::MAX);
            let smallest = if right_at < left_at { right } else { left };
            let here = self.heap.get(index).map(|e| e.at).unwrap_or(i64::MAX);
            let there = self.heap.get(smallest).map(|e| e.at).unwrap_or(i64::MAX);
            if here <= there {
                return;
            }
            if smallest >= self.heap.len() {
                return;
            }
            self.swap(index, smallest);
            index = smallest;
        }
    }

    fn swap(&mut self, first: usize, second: usize) {
        if first >= self.heap.len() || second >= self.heap.len() {
            return;
        }
        self.heap.swap(first, second);
        let a = self.heap[first].id.clone();
        let b = self.heap[second].id.clone();
        self.positions.insert(a, first);
        self.positions.insert(b, second);
    }
}

impl Default for MissingEdges {
    fn default() -> Self {
        Self::new()
    }
}
