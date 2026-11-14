// SPDX-License-Identifier: Apache-2.0
//! What a grant must pass before anything is installed for it: revocations, and the
//! connections and streams already closed. Grants reach ace-media on the normal lane, behind
//! revocations and closes on the priority lane, so a grant the daemon issued before a
//! revocation or close can arrive after it; the ledger refuses it.
//!
//! The normal lane is one FIFO and the daemon issues `issued` from one monotonic sequence, so
//! grants arrive with non-decreasing `issued`. ace-media enforces that (an older grant is
//! refused) and so may forget a revocation once a grant issued after it has arrived: no grant
//! it could cover is still on the way. When too many revocations are outstanding at once, the
//! oldest is forgotten and every grant at or below its sequence is refused (fail closed).
//!
//! Closes carry no sequence, so closed ids are kept for the process's lifetime. Past
//! [`MAX_CLOSED`] the ledger reports full and the process restarts, which ends every
//! connection and forgets nothing it shouldn't.
use media_wire::control::{Admission, Owner, Refusal};
use std::collections::{HashSet, VecDeque};

/// Revocations outstanding at once (issued after the newest grant seen).
pub const MAX_REVOCATIONS: usize = 4096;
/// Closed connection and stream ids remembered, together.
pub const MAX_CLOSED: usize = 65_536;

struct Revocation {
    issued: u64,
    device: String,
    admission: Option<Admission>,
}

impl Revocation {
    /// The same rule the daemon applies to the grants it still holds (`grants.ts`).
    fn covers(&self, owner: &Owner, issued: u64) -> bool {
        owner.device.get() == self.device
            && issued <= self.issued
            && self
                .admission
                .as_ref()
                .is_none_or(|a| *a == owner.admission)
    }
}

/// The bookkeeping is full; the process must restart.
#[derive(Debug, PartialEq, Eq)]
pub struct Full;

#[derive(Default)]
pub struct Ledger {
    revocations: VecDeque<Revocation>,
    /// The highest `issued` of a grant taken from the normal lane.
    watermark: u64,
    /// Grants issued at or below this are refused: a revocation that may cover them was dropped.
    floor: Option<u64>,
    connections: HashSet<String>,
    streams: HashSet<String>,
}

impl Ledger {
    /// Every grant, in normal-lane order, before anything is stored or imported for it.
    pub fn admit(
        &mut self,
        owner: &Owner,
        issued: u64,
        connection: &str,
        stream: Option<&str>,
    ) -> Result<(), Refusal> {
        if issued < self.watermark {
            return Err(Refusal::Revoked);
        }
        self.watermark = issued;
        let watermark = self.watermark;
        self.revocations.retain(|r| r.issued >= watermark);
        if self.floor.is_some_and(|floor| issued <= floor)
            || self.revocations.iter().any(|r| r.covers(owner, issued))
        {
            return Err(Refusal::Revoked);
        }
        if self.connections.contains(connection) || stream.is_some_and(|s| self.streams.contains(s))
        {
            return Err(Refusal::UnknownConnection);
        }
        Ok(())
    }

    /// Records a revocation for grants still on the way.
    pub fn revoke(&mut self, issued: u64, device: &str, admission: Option<&Admission>) {
        if self.revocations.len() == MAX_REVOCATIONS
            && let Some(oldest) = self.revocations.pop_front()
        {
            self.floor = Some(self.floor.map_or(oldest.issued, |f| f.max(oldest.issued)));
        }
        self.revocations.push_back(Revocation {
            issued,
            device: device.to_owned(),
            admission: admission.cloned(),
        });
    }

    /// Whether the newest revocation covers a grant already installed.
    pub fn latest_covers(&self, owner: &Owner, issued: u64) -> bool {
        self.revocations
            .back()
            .is_some_and(|r| r.covers(owner, issued))
    }

    pub fn close_connection(&mut self, id: &str) -> Result<(), Full> {
        self.remember(id, true)
    }

    pub fn close_stream(&mut self, id: &str) -> Result<(), Full> {
        self.remember(id, false)
    }

    fn remember(&mut self, id: &str, connection: bool) -> Result<(), Full> {
        if self.connections.len() + self.streams.len() >= MAX_CLOSED {
            return Err(Full);
        }
        let set = if connection {
            &mut self.connections
        } else {
            &mut self.streams
        };
        set.insert(id.to_owned());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner(device: &str) -> Owner {
        let value = serde_json::json!({ "session": "s", "device": device,
            "admission": { "kind": "pairing", "generation": 1 } });
        match serde_json::from_value(value) {
            Ok(owner) => owner,
            Err(error) => panic!("owner: {error}"),
        }
    }

    #[test]
    fn a_grant_older_than_one_already_seen_is_refused() {
        let mut ledger = Ledger::default();
        assert_eq!(ledger.admit(&owner("d"), 5, "c1", None), Ok(()));
        assert_eq!(
            ledger.admit(&owner("d"), 5, "c2", None),
            Ok(()),
            "equal is in order"
        );
        assert_eq!(
            ledger.admit(&owner("d"), 4, "c3", None),
            Err(Refusal::Revoked)
        );
    }

    #[test]
    fn a_revocation_outlives_its_buffered_grants_however_many_follow_it() {
        let mut ledger = Ledger::default();
        ledger.revoke(10, "d", None);
        for i in 0..(MAX_REVOCATIONS as u64 * 2) {
            ledger.revoke(11 + i, "other", None);
        }
        // The first revocation was dropped to make room, so its grants are refused anyway,
        // along with everything else that old.
        assert_eq!(
            ledger.admit(&owner("d"), 9, "c", None),
            Err(Refusal::Revoked)
        );
        assert_eq!(
            ledger.admit(&owner("e"), 10, "c", None),
            Err(Refusal::Revoked)
        );
    }

    #[test]
    fn a_revocation_is_forgotten_only_once_a_later_grant_proves_none_it_covers_is_left() {
        let mut ledger = Ledger::default();
        ledger.revoke(10, "d", None);
        assert_eq!(
            ledger.admit(&owner("d"), 10, "c1", None),
            Err(Refusal::Revoked)
        );
        assert_eq!(ledger.admit(&owner("d"), 11, "c2", None), Ok(()));
        assert_eq!(ledger.revocations.len(), 0);
    }

    #[test]
    fn closed_ids_refuse_later_grants_and_a_full_ledger_says_so() {
        let mut ledger = Ledger::default();
        assert_eq!(ledger.close_connection("c1"), Ok(()));
        assert_eq!(ledger.close_stream("st1"), Ok(()));
        assert_eq!(
            ledger.admit(&owner("d"), 1, "c1", None),
            Err(Refusal::UnknownConnection)
        );
        assert_eq!(
            ledger.admit(&owner("d"), 1, "c2", Some("st1")),
            Err(Refusal::UnknownConnection)
        );
        assert_eq!(ledger.admit(&owner("d"), 1, "c2", Some("st2")), Ok(()));
        for i in 2..MAX_CLOSED {
            assert_eq!(ledger.close_connection(&format!("x{i}")), Ok(()));
        }
        assert_eq!(ledger.close_connection("last"), Err(Full));
    }
}
