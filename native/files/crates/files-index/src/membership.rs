// SPDX-License-Identifier: Apache-2.0

//! Membership for live updates: hash to arena slot.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use crate::arena::PathArena;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x1000_0000_01b3;

/// FNV-1a. Path hashing only has to spread a million similar strings, and every lookup compares the
/// bytes of the stored path before believing the slot, so a collision can never report the wrong
/// file.
#[derive(Default)]
pub(crate) struct PathHasher(Option<u64>);

impl Hasher for PathHasher {
    fn finish(&self) -> u64 {
        self.0.unwrap_or(FNV_OFFSET)
    }

    fn write(&mut self, bytes: &[u8]) {
        let mut hash = self.0.unwrap_or(FNV_OFFSET);
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
        self.0 = Some(hash);
    }
}

pub(crate) type PathMap<V> = HashMap<u64, V, BuildHasherDefault<PathHasher>>;

/// Hash-to-slot map for the indexed paths, so `apply` can refresh a file that a watcher reports as
/// modified without adding it twice.
#[derive(Debug, Default)]
pub(crate) struct Membership {
    slots: PathMap<u32>,
}

impl Membership {
    pub fn with_capacity(paths: usize) -> Membership {
        Membership {
            slots: PathMap::with_capacity_and_hasher(paths, BuildHasherDefault::default()),
        }
    }

    /// The slot holding `path`, if it is indexed. The slot's bytes are compared, so a hash
    /// collision reads as "not indexed" rather than as some other path.
    pub fn find(&self, arena: &PathArena, path: &str) -> Option<u32> {
        let slot = *self.slots.get(&hash(path))?;
        (arena.is_live(slot) && arena.get(slot) == Some(path)).then_some(slot)
    }

    pub fn insert(&mut self, path: &str, slot: u32) {
        self.slots.insert(hash(path), slot);
    }

    /// Forget `path` if the map really points at it.
    pub fn remove(&mut self, arena: &PathArena, path: &str) {
        let hash = hash(path);
        if self
            .slots
            .get(&hash)
            .is_some_and(|&slot| arena.get(slot) == Some(path))
        {
            self.slots.remove(&hash);
        }
    }

    /// Approximate bytes the map occupies, for the build report and bench.
    pub fn bytes_used(&self) -> usize {
        self.slots.capacity() * (size_of::<u64>() + size_of::<u32>())
    }
}

fn hash(path: &str) -> u64 {
    let mut hasher = PathHasher::default();
    std::hash::Hash::hash(path, &mut hasher);
    hasher.finish()
}
