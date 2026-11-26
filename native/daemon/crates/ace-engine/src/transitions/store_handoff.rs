// SPDX-License-Identifier: Apache-2.0
//! `store-handoff.ts` (E5.9): a thread whose saved provider session can never open again
//! continues in a fresh session of the same provider, carrying ace's own transcript (ADR 0211).
//!
//! Cases ported from `cursor-fresh-session.test.ts`; the handoff block itself is
//! `transition-history.ts`'s, and the open/commit orchestration stays the session owner's.

/// About 8k tokens, as a provider switch carries (`store-handoff.ts:27`).
pub const FRESH_SESSION_HANDOFF_BYTES: usize = 32_768;

/// `sessionStoreUnusable` (`provider-kit/src/open-error.ts:19`).
pub const STORE_UNUSABLE: &str = "session_store_unusable";

/// `freshSessionNote` (`:30`): said to the agent after the handoff, so it knows it is resuming its
/// own conversation.
pub fn fresh_session_note(provider: &str) -> String {
    let name = if provider == "cursor" {
        "Cursor"
    } else {
        provider
    };
    format!(
        "ace note: this thread's saved {name} session could not be opened again, so this is a \
         fresh {name} session. The context handoff above is this same conversation, quoted from \
         ace's transcript. Pick it up where it left off; the person's next message follows."
    )
}

/// `storeUnusable` (`:38`): a saved session the provider can never open again. The binding walks
/// the error chain (E5.9 takes the first code it finds), so a wrapped failure arrives here too.
pub fn store_unusable(code: Option<&str>) -> bool {
    code == Some(STORE_UNUSABLE)
}

/// `handoff:fresh:<generation>`: the marker a fresh session's handoff waits behind (`:80`).
pub fn fresh_session_marker(generation: i64) -> String {
    format!("handoff:fresh:{generation}")
}

#[cfg(test)]
mod tests {
    use super::*;

    // From `cursor-fresh-session.test.ts`: only the store-unusable code hands off, and the note
    // names the provider as the person knows it.
    #[test]
    fn only_an_unusable_store_hands_off_and_the_note_names_the_provider() {
        assert!(store_unusable(Some("session_store_unusable")));
        assert!(!store_unusable(Some("network_unreachable")));
        assert!(!store_unusable(None));
        assert!(fresh_session_note("cursor").starts_with(
            "ace note: this thread's saved Cursor session could not be opened again, so this is a fresh Cursor session."
        ));
        assert!(fresh_session_note("codex").contains("saved codex session"));
        assert_eq!(fresh_session_marker(1), "handoff:fresh:1");
        assert_eq!(FRESH_SESSION_HANDOFF_BYTES, 32_768);
    }
}
