// SPDX-License-Identifier: Apache-2.0

//! A bounded heap that keeps the best `limit` candidates seen so far.

use crate::arena::PathArena;
use crate::ranking;

/// One scored path, still addressed by arena slot so the heap does not own strings.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Candidate {
    pub score: u32,
    pub slot: u32,
}

/// Keeps at most `limit` candidates, dropping the worst as better ones arrive. The root is always
/// the worst candidate in the heap, so a rejected candidate costs one comparison.
pub(crate) struct TopK<'a> {
    limit: usize,
    arena: &'a PathArena,
    heap: Vec<Candidate>,
}

impl<'a> TopK<'a> {
    pub fn new(limit: usize, arena: &'a PathArena) -> TopK<'a> {
        TopK {
            limit,
            arena,
            heap: Vec::new(),
        }
    }

    pub fn push(&mut self, candidate: Candidate) {
        if self.limit == 0 {
            return;
        }
        if self.heap.len() < self.limit {
            self.heap.push(candidate);
            self.sift_up(self.heap.len() - 1);
            return;
        }
        if self
            .heap
            .first()
            .is_some_and(|worst| self.worse_than(&candidate, worst))
        {
            self.heap[0] = candidate;
            self.sift_down(0);
        }
    }

    /// The kept candidates, best first.
    pub fn into_sorted(self) -> Vec<Candidate> {
        let TopK {
            arena, mut heap, ..
        } = self;
        heap.sort_by(|left, right| {
            ranking::order(
                (left.score, path(arena, left.slot)),
                (right.score, path(arena, right.slot)),
            )
        });
        heap
    }

    fn path(&self, slot: u32) -> &'a str {
        path(self.arena, slot)
    }

    fn worse_than(&self, left: &Candidate, right: &Candidate) -> bool {
        ranking::order(
            (left.score, self.path(left.slot)),
            (right.score, self.path(right.slot)),
        ) == std::cmp::Ordering::Greater
    }

    fn worse_at(&self, left: usize, right: usize) -> bool {
        match (self.heap.get(left), self.heap.get(right)) {
            (Some(left), Some(right)) => self.worse_than(left, right),
            _ => false,
        }
    }

    fn sift_up(&mut self, mut index: usize) {
        while index > 0 {
            let parent = (index - 1) / 2;
            if self.worse_at(index, parent) {
                self.heap.swap(index, parent);
                index = parent;
            } else {
                break;
            }
        }
    }

    fn sift_down(&mut self, mut index: usize) {
        loop {
            let left = index * 2 + 1;
            let right = left + 1;
            let mut worst = index;
            if left < self.heap.len() && self.worse_at(left, worst) {
                worst = left;
            }
            if right < self.heap.len() && self.worse_at(right, worst) {
                worst = right;
            }
            if worst == index {
                break;
            }
            self.heap.swap(index, worst);
            index = worst;
        }
    }
}

fn path(arena: &PathArena, slot: u32) -> &str {
    arena.get(slot).unwrap_or_default()
}
