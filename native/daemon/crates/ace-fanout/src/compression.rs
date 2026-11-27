// SPDX-License-Identifier: Apache-2.0
//! Which server messages may be compressed on the way to a remote client
//! (`apps/daemon/src/compression-policy.ts`).
//!
//! Compressing before encryption lets a message's length leak secrets when a secret and
//! attacker-controlled data share one compression context (CRIME/BREACH). Only transcript and
//! history bulk is allowlisted here; nothing carrying a credential, token, URL, or code is ever
//! compressed or packed into a shared frame with compressible messages.

/// Smaller messages gain too little to be worth a deflate (`compressionThresholdBytes`).
pub const COMPRESSION_THRESHOLD_BYTES: usize = 1024;

/// Whether a JSON server message of `message_type` may be compressed (alone, without context
/// takeover) for a remote peer. An allowlist so new message types default to uncompressed.
pub fn may_compress(message_type: &str) -> bool {
    matches!(
        message_type,
        "events"
            | "snapshot"
            | "snapshot.part"
            | "entities.page"
            | "entities.page.part"
            | "items.page"
            | "items.window"
            | "turns.page"
            | "turn.steps"
            | "item.raw"
            | "threads.patch"
            | "thread.catchUp"
            | "thread.search"
            | "search.results"
            | "history.list"
            | "catalog.changed"
            | "catalog.list.result"
            | "models.result"
            | "usage.result"
    )
}
