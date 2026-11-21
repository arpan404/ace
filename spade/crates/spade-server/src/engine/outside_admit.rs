//! What Spade holds in memory for the person's own outside agents at once (ADR 0202 §3, §6), so
//! none of them can tie it up or replay what ace sent:
//!
//! - **Waits.** A request that waits on a call (an MCP `tools/call`, an A2A `SendMessage` or
//!   `CancelTask`) holds a slot while it waits: at most [`WAITS_PER_GRANT`] per grant and
//!   [`WAITS_AT_ONCE`] in all. One beyond is refused before anything is delivered; reading a
//!   task (`GetTask`) never waits, and reads only what its call stored.
//! - **Stamps.** Each request ace forwards carries a signed nonce, taken once while its stamp's
//!   time is within the skew window. A stamp signed before this Spade started is refused, since
//!   the nonces seen before then are gone.
//! - **MCP request ids.** A legacy client's `notifications/cancelled` names a request by its
//!   JSON-RPC id, kept as JSON so `7` and `"7"` are two requests; one id is in flight once.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::Value;

/// The most requests of one grant waiting on its calls at once.
pub const WAITS_PER_GRANT: usize = 8;
/// The most requests of all outside callers waiting at once.
pub const WAITS_AT_ONCE: usize = 32;
/// The most nonces kept for the skew window; a stamp beyond them is refused, not forgotten.
const MOST_NONCES: usize = 20_000;

#[derive(Default)]
struct Waits {
    by_grant: HashMap<String, usize>,
    total: usize,
}

impl Waits {
    fn take(&mut self, grant: &str) -> bool {
        let held = self.by_grant.get(grant).copied().unwrap_or(0);
        if held >= WAITS_PER_GRANT || self.total >= WAITS_AT_ONCE {
            return false;
        }
        self.by_grant.insert(grant.to_owned(), held + 1);
        self.total += 1;
        true
    }

    fn give_back(&mut self, grant: &str) {
        if let Some(held) = self.by_grant.get_mut(grant) {
            *held -= 1;
            if *held == 0 {
                self.by_grant.remove(grant);
            }
            self.total = self.total.saturating_sub(1);
        }
    }
}

struct Nonces {
    /// When this Spade started: stamps signed before it can't be checked against `seen`.
    since_ms: i64,
    /// Each nonce taken, with its stamp's time.
    seen: HashMap<String, i64>,
}

/// The outside callers' share of the engine's memory.
pub(super) struct Shared {
    requests: Mutex<HashMap<(String, String), String>>,
    waits: Mutex<Waits>,
    nonces: Mutex<Nonces>,
}

impl Shared {
    pub(super) fn new(started_ms: i64) -> Self {
        Self {
            requests: Mutex::default(),
            waits: Mutex::default(),
            nonces: Mutex::new(Nonces {
                since_ms: started_ms,
                seen: HashMap::new(),
            }),
        }
    }

    /// A wait slot for `grant`, or `None` when it, or everyone, has as many as allowed.
    pub(super) fn wait_slot(&self, grant: &str) -> Option<WaitSlot<'_>> {
        let taken = self
            .waits
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take(grant);
        taken.then(|| WaitSlot {
            waits: &self.waits,
            grant: grant.to_owned(),
        })
    }

    /// Takes stamp nonce `nonce`, signed at `time`, once: false when it was taken before, the
    /// stamp is older than this Spade, or too many are held. `window_ms` is how long a stamp
    /// verifies after its time; `now` the clock's time.
    pub(super) fn take_nonce(&self, nonce: &str, time: i64, now: i64, window_ms: i64) -> bool {
        let mut nonces = self.nonces.lock().unwrap_or_else(|p| p.into_inner());
        if time < nonces.since_ms {
            return false;
        }
        nonces
            .seen
            .retain(|_, at| at.saturating_add(window_ms) >= now);
        if nonces.seen.contains_key(nonce) || nonces.seen.len() >= MOST_NONCES {
            return false;
        }
        nonces.seen.insert(nonce.to_owned(), time);
        true
    }

    /// Claims MCP request `id` of `grant` for call `call` while it runs: false when that id,
    /// as JSON, is in flight already.
    pub(super) fn claim_request(&self, grant: &str, id: &Value, call: &str) -> bool {
        let mut requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
        match requests.entry((grant.to_owned(), id.to_string())) {
            std::collections::hash_map::Entry::Occupied(_) => false,
            std::collections::hash_map::Entry::Vacant(free) => {
                free.insert(call.to_owned());
                true
            }
        }
    }

    pub(super) fn release_request(&self, grant: &str, id: &Value) {
        self.requests
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&(grant.to_owned(), id.to_string()));
    }

    pub(super) fn request_call(&self, grant: &str, id: &Value) -> Option<String> {
        self.requests
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&(grant.to_owned(), id.to_string()))
            .cloned()
    }
}

/// A request's hold on one of its grant's waits, given back when dropped.
pub struct WaitSlot<'a> {
    waits: &'a Mutex<Waits>,
    grant: String,
}

impl Drop for WaitSlot<'_> {
    fn drop(&mut self) {
        self.waits
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .give_back(&self.grant);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_grant_waits_on_so_many_calls_at_once_and_everyone_on_so_many_in_all() {
        let shared = Shared::new(0);
        let mine: Vec<_> = (0..WAITS_PER_GRANT)
            .filter_map(|_| shared.wait_slot("g1"))
            .collect();
        assert_eq!(mine.len(), WAITS_PER_GRANT);
        assert!(shared.wait_slot("g1").is_none());
        drop(mine);
        assert!(shared.wait_slot("g1").is_some());

        let grants: Vec<String> = (0..WAITS_AT_ONCE).map(|i| format!("g{i}")).collect();
        let all: Vec<_> = grants.iter().filter_map(|g| shared.wait_slot(g)).collect();
        assert_eq!(all.len(), WAITS_AT_ONCE);
        assert!(shared.wait_slot("another").is_none());
    }

    #[test]
    fn a_nonce_is_taken_once_in_its_window_and_a_stamp_older_than_spade_never() {
        let shared = Shared::new(1_000);
        assert!(shared.take_nonce("n1", 1_500, 1_500, 300));
        assert!(!shared.take_nonce("n1", 1_500, 1_600, 300));
        assert!(shared.take_nonce("n2", 1_600, 1_600, 300));
        // Signed before this Spade started: whatever it saw then is gone.
        assert!(!shared.take_nonce("n3", 999, 1_100, 300));
    }

    #[test]
    fn request_ids_keep_their_json_type_and_one_id_is_in_flight_once() {
        let shared = Shared::new(0);
        assert!(shared.claim_request("g", &json!(7), "cc.a"));
        assert!(shared.claim_request("g", &json!("7"), "cc.b"));
        assert!(!shared.claim_request("g", &json!(7), "cc.c"));
        assert_eq!(shared.request_call("g", &json!(7)).as_deref(), Some("cc.a"));
        assert_eq!(
            shared.request_call("g", &json!("7")).as_deref(),
            Some("cc.b")
        );
        shared.release_request("g", &json!(7));
        assert_eq!(shared.request_call("g", &json!(7)), None);
        assert!(shared.claim_request("g", &json!(7), "cc.d"));
    }
}
