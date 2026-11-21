// SPDX-License-Identifier: Apache-2.0

//! A scan's counts and notices (`ScanResult` in contracts.ts).

use serde_json::{Value, json};

#[derive(Debug, Clone, Default)]
pub struct Tally {
    pub files: u64,
    pub reads: u64,
    pub bytes: u64,
    pub skipped: u64,
    pub unsupported: Vec<(String, String)>,
}

impl Tally {
    /// Record a notice; at most 256 are kept.
    pub fn unsupported(&mut self, instance: &str, reason: &str) {
        if self.unsupported.len() < 256 {
            self.unsupported
                .push((instance.to_owned(), reason.to_owned()));
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "files": self.files,
            "reads": self.reads,
            "bytes": self.bytes,
            "skipped": self.skipped,
            "unsupported": self.unsupported.iter().map(|(i, r)| json!({ "instanceId": i, "reason": r })).collect::<Vec<_>>(),
        })
    }
}
