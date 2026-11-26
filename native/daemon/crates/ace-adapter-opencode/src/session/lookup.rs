// SPDX-License-Identifier: Apache-2.0
//! The part of an ancestry probe that awaits (`ancesry.ts`'s lookup loop,
//! `packages/adapter-opencode/src/ancestry.ts:94`-`:128`): a GET chain up to 16
//! hops, a cycle check, which ends at a fork or a root.
//!
//! The chain is a machine over `http` replies. It decides nothing about the
//! probe: the tenant admits the chain it returns, then either replays the held
//! events or asks for a recovery pass.

use ace_json::{Value, json};
use indexmap::IndexSet;

use crate::translate::boundaries::BoundaryError;

use super::http::Reply;
use super::ownership::{order_info, parse_info};

/// `chain.length >= 16`.
const MAX_HOPS: usize = 16;

/// Why a chain could not be proven. The TypeScript throws these texts.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LookupError {
    #[error("Unverified OpenCode ancestry")]
    Unverified,
    #[error("Mismatched OpenCode ancestry identity")]
    Mismatched,
    #[error("{0}")]
    Envelope(String),
}

impl From<BoundaryError> for LookupError {
    fn from(error: BoundaryError) -> Self {
        Self::Envelope(error.to_string())
    }
}

/// What one reply asked for next.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// `session.get` for this session id.
    Request(Value),
    /// The chain reached an owned session: its snapshots, oldest first.
    Admit(Vec<Value>),
    /// The chain ended at a fork or a root with nothing to admit.
    Finished,
    /// A recovery began while the chain ran: the probe's facts need a pass, and
    /// the session is already recovering, so nothing more is noted.
    Waiting,
    /// A recovery began while the chain ran: the session is not recovering yet,
    /// so the probe fails and asks for one.
    NeedsRecovery,
    /// The chain cannot be proven; the probe is failed.
    Failed(LookupError),
}

/// One probe's GET chain.
pub struct Lookup {
    /// The probed session, whose ownership decides the loop's condition.
    id: String,
    /// The session the outstanding request names.
    cursor: String,
    /// The snapshots read so far, child first.
    chain: Vec<Value>,
    visited: IndexSet<String>,
}

impl Lookup {
    /// A new chain: its first request names the probed session.
    pub fn begin(id: &str) -> (Self, Step) {
        let mut visited = IndexSet::new();
        // `visited.add(cursor)` runs before each request, the first included.
        visited.insert(id.to_owned());
        let lookup = Self {
            id: id.to_owned(),
            cursor: id.to_owned(),
            chain: Vec::new(),
            visited,
        };
        (lookup, Step::Request(json!({ "sessionID": id })))
    }

    /// `owned` answers whether this tree owns an id; `needs_recovery` and
    /// `recovering` are the probe's and the session's flags at this reply.
    pub fn step(
        &mut self,
        reply: &Reply,
        owned: &dyn Fn(&str) -> bool,
        needs_recovery: bool,
        recovering: bool,
    ) -> Step {
        // The pass reached the probe's session while its chain was in flight:
        // a chain read now could race the snapshots, so the probe waits.
        if needs_recovery && owned(&self.id) {
            return if recovering {
                Step::Waiting
            } else {
                Step::NeedsRecovery
            };
        }
        let Some(info) = parse_info(&reply.body) else {
            return Step::Failed(LookupError::Envelope(
                BoundaryError::Event("info").to_string(),
            ));
        };
        if info.id != self.cursor {
            return Step::Failed(LookupError::Mismatched);
        }
        // A fork or a root ends the chain: nothing above it can be admitted.
        if info.fork || info.parent_id.is_empty() {
            return Step::Finished;
        }
        self.chain.push(order_info(&reply.body));
        self.cursor = info.parent_id.to_owned();
        if owned(&self.cursor) {
            self.chain.reverse();
            return Step::Admit(std::mem::take(&mut self.chain));
        }
        if self.chain.len() >= MAX_HOPS || !self.visited.insert(self.cursor.clone()) {
            return Step::Failed(LookupError::Unverified);
        }
        Step::Request(json!({ "sessionID": self.cursor }))
    }

    /// The session the outstanding request names.
    pub fn cursor(&self) -> &str {
        &self.cursor
    }
}

#[cfg(test)]
mod tests;
