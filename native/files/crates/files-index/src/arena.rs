// SPDX-License-Identifier: Apache-2.0

//! All indexed paths live in one byte arena.

/// Paths are stored back to back in a single `String` and addressed by `u32` end offsets, plus a
/// liveness byte. A million paths therefore cost their own bytes plus five bytes of bookkeeping
/// each, and a search walks contiguous memory instead of chasing a pointer per path.
///
/// Deleting a path flips its liveness byte and leaves a hole, because the byte arena cannot shrink
/// in the middle without moving every later path. [`PathArena::compact`] rebuilds the arena when
/// the holes outweigh the live paths, so a session that deletes far more than it adds is bounded.
#[derive(Debug, Default)]
pub(crate) struct PathArena {
    bytes: String,
    ends: Vec<u32>,
    live: Vec<bool>,
    live_len: usize,
}

impl PathArena {
    /// Reserve for an expected number of paths and average path length.
    pub fn with_capacity(paths: usize, bytes: usize) -> PathArena {
        PathArena {
            bytes: String::with_capacity(bytes),
            ends: Vec::with_capacity(paths),
            live: Vec::with_capacity(paths),
            live_len: 0,
        }
    }

    /// Slots ever written, including holes left by deletions.
    pub fn slots(&self) -> u32 {
        u32::try_from(self.ends.len()).unwrap_or(u32::MAX)
    }

    /// Paths currently indexed.
    pub fn live_len(&self) -> usize {
        self.live_len
    }

    /// Add a path at a fresh slot. `None` when the arena would pass the `u32` offset limit or the
    /// slot count would overflow.
    pub fn push(&mut self, path: &str) -> Option<u32> {
        let end = u32::try_from(self.bytes.len().checked_add(path.len())?).ok()?;
        let slot = u32::try_from(self.ends.len()).ok()?.checked_add(1)?;
        self.bytes.push_str(path);
        self.ends.push(end);
        self.live.push(true);
        self.live_len += 1;
        Some(slot - 1)
    }

    /// The path in a slot, whether or not it is still live.
    pub fn get(&self, slot: u32) -> Option<&str> {
        let index = usize::try_from(slot).ok()?;
        let end = *self.ends.get(index)? as usize;
        let start = index
            .checked_sub(1)
            .and_then(|previous| self.ends.get(previous))
            .map_or(0, |end| *end as usize);
        self.bytes.get(start..end)
    }

    /// Whether a slot still holds an indexed path.
    pub fn is_live(&self, slot: u32) -> bool {
        usize::try_from(slot)
            .ok()
            .and_then(|index| self.live.get(index))
            .copied()
            .unwrap_or(false)
    }

    /// Mark a slot deleted. Returns whether it was live.
    pub fn remove(&mut self, slot: u32) -> bool {
        let index = match usize::try_from(slot) {
            Ok(index) => index,
            Err(_) => return false,
        };
        match self.live.get_mut(index) {
            Some(live) if *live => {
                *live = false;
                self.live_len -= 1;
                true
            }
            _ => false,
        }
    }

    /// Holes left by deletions.
    pub fn dead_len(&self) -> usize {
        self.ends.len() - self.live_len
    }

    /// Rewrite the arena with only the live paths, in their current order. Callers decide when the
    /// copy is worth it (see [`PathArena::dead_len`]).
    pub fn compact(&mut self) {
        if self.dead_len() == 0 {
            return;
        }
        let mut rebuilt = PathArena::with_capacity(self.live_len, self.bytes.len());
        for slot in 0..self.slots() {
            if self.is_live(slot)
                && let Some(path) = self.get(slot)
            {
                rebuilt.push(path);
            }
        }
        *self = rebuilt;
    }

    /// Bytes of path text written, live or not: what a copy of the live paths needs at most.
    pub fn text_len(&self) -> usize {
        self.bytes.len()
    }

    /// Bytes the arena occupies, for the build report and bench.
    pub fn bytes_used(&self) -> usize {
        self.bytes.capacity() + self.ends.capacity() * size_of::<u32>() + self.live.capacity()
    }
}
