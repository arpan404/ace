// SPDX-License-Identifier: Apache-2.0
//! A devices channel's outgoing messages before its socket has said welcome
//! (`packages/devices/src/held-pushes.ts`).
//!
//! The channel can subscribe early (so a full subscriber budget refuses the
//! hello), but nothing reaches the client until `open`: then the opening
//! snapshot goes first, followed by every change that came in while it waited —
//! the latest of each replaceable push, in the order they last changed.
//!
//! Sans-IO: `open` hands back the writes in order instead of awaiting them.

use indexmap::IndexMap;

use super::wire::{Push, PushKind};

/// At most this many pushes wait for the welcome (`held-pushes.ts:25`).
pub const MAX_HELD: usize = 64;

/// The refusal a channel gets when it holds more than [`MAX_HELD`].
pub const TOO_MANY_HELD: &str = "Too many device pushes before welcome";

/// One channel's held pushes.
#[derive(Debug)]
pub struct HeldPushes<M> {
    /// `undefined` once welcome went out: from then on every send writes.
    held: Option<IndexMap<String, Push<M>>>,
    /// The counter that names an unreplaceable push (`once:1`, `once:2`, …).
    serial: u64,
}

impl<M> Default for HeldPushes<M> {
    fn default() -> Self {
        Self::new()
    }
}

impl<M> HeldPushes<M> {
    pub fn new() -> Self {
        Self {
            held: Some(IndexMap::new()),
            serial: 0,
        }
    }

    /// `send`: before welcome the push is held (replacing an earlier one of its
    /// kind, and moving to the end), and the caller writes nothing.
    pub fn send(&mut self, push: Push<M>) -> Result<Held<M>, String> {
        // The TypeScript checks the bound before the key: a repeat of a held
        // push is refused too while the channel is at the cap.
        if self
            .held
            .as_ref()
            .is_some_and(|held| held.len() >= MAX_HELD)
        {
            return Err(String::from(TOO_MANY_HELD));
        }
        let Some(held) = self.held.as_mut() else {
            return Ok(Held::Write(push));
        };
        let key = match push.kind.replace_key() {
            Some(key) => key,
            None => {
                self.serial = self.serial.saturating_add(1);
                format!("once:{}", self.serial)
            }
        };
        // `held.delete(key); held.set(key, message)` — the latest position wins.
        held.shift_remove(&key);
        held.insert(key, push);
        Ok(Held::Held)
    }

    /// `open`: the snapshot first, then what waited in last-change order. `None`
    /// when welcome already went out.
    pub fn open(&mut self, snapshot: Vec<Push<M>>) -> Option<Vec<Push<M>>> {
        let held = self.held.take()?;
        let mut writes = snapshot;
        writes.extend(held.into_values());
        Some(writes)
    }

    /// Whether pushes are still held (before welcome).
    pub fn holding(&self) -> bool {
        self.held.is_some()
    }

    /// How many pushes wait, for tests and diagnostics.
    pub fn len(&self) -> usize {
        self.held.as_ref().map_or(0, IndexMap::len)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// What `send` decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Held<M> {
    /// Welcome already went out: write it now.
    Write(Push<M>),
    /// It waits for the welcome.
    Held,
}

/// The kind of a `devices.enabled` push, for the opening snapshot.
pub fn enabled<M>(message: M) -> Push<M> {
    Push {
        kind: PushKind::Enabled,
        message,
    }
}

#[cfg(test)]
mod tests;
