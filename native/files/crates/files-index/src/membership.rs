// SPDX-License-Identifier: Apache-2.0

//! Membership for live updates: path hash to arena slot.

use std::hash::Hasher;

use hashbrown::HashTable;

use crate::arena::PathArena;

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x1000_0000_01b3;

/// FNV-1a. Path hashing only has to spread a million similar strings; every lookup compares the
/// bytes of the stored path before believing the slot, and the table keeps every entry that shares
/// a hash, so a collision can never hide or misreport a file.
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

type Hash = fn(&str) -> u64;

/// Hash-to-slot table for the indexed paths, so `apply` can refresh a file that a watcher reports as
/// modified without adding it twice. The table holds every slot whose path hashes the same, which is
/// what makes a collision harmless: lookups compare path text, never just the hash.
#[derive(Debug)]
pub(crate) struct Membership {
    table: HashTable<u32>,
    hash: Hash,
}

impl Membership {
    pub fn with_capacity(paths: usize) -> Membership {
        Membership::with_hasher(paths, hash)
    }

    fn with_hasher(paths: usize, hash: Hash) -> Membership {
        Membership {
            table: HashTable::with_capacity(paths),
            hash,
        }
    }

    /// The slot holding `path`, if it is indexed.
    pub fn find(&self, arena: &PathArena, path: &str) -> Option<u32> {
        self.table
            .find((self.hash)(path), |&slot| arena.get(slot) == Some(path))
            .copied()
    }

    pub fn insert(&mut self, arena: &PathArena, path: &str, slot: u32) {
        let hash = self.hash;
        self.table
            .insert_unique((self.hash)(path), slot, move |&existing| {
                hash(arena.get(existing).unwrap_or_default())
            });
    }

    /// Forget `path` if the table really points at it.
    pub fn remove(&mut self, arena: &PathArena, path: &str) {
        if let Ok(entry) = self
            .table
            .find_entry((self.hash)(path), |&slot| arena.get(slot) == Some(path))
        {
            entry.remove();
        }
    }

    /// Approximate bytes the table occupies, for the build report and bench.
    pub fn bytes_used(&self) -> usize {
        self.table.capacity() * (size_of::<u32>() + size_of::<u8>())
    }
}

fn hash(path: &str) -> u64 {
    let mut hasher = PathHasher::default();
    std::hash::Hash::hash(path, &mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A hasher that puts every path in one bucket, so the table has to tell them apart by text.
    fn colliding(_: &str) -> u64 {
        0x5eed
    }

    fn arena(paths: &[&str]) -> PathArena {
        let mut arena = PathArena::default();
        for path in paths {
            arena.push(path);
        }
        arena
    }

    #[test]
    fn colliding_paths_keep_their_own_slots() {
        let arena = arena(&["src/a.rs", "src/b.rs"]);
        let mut members = Membership::with_hasher(2, colliding);
        members.insert(&arena, "src/a.rs", 0);
        members.insert(&arena, "src/b.rs", 1);

        assert_eq!(members.find(&arena, "src/a.rs"), Some(0));
        assert_eq!(members.find(&arena, "src/b.rs"), Some(1));
        assert_eq!(members.find(&arena, "src/c.rs"), None);

        members.remove(&arena, "src/a.rs");
        assert_eq!(members.find(&arena, "src/a.rs"), None);
        assert_eq!(
            members.find(&arena, "src/b.rs"),
            Some(1),
            "removing one colliding path leaves the other in place"
        );
    }
}
