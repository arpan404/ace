// SPDX-License-Identifier: Apache-2.0
//! The snapshot read budget (`read-budget.ts`) and host text clipping (`host-text.ts`):
//! 8 MiB of source bytes per snapshot, cached pages included, and one long record never
//! fails a read.

use crate::transport::error::{ForgeError, Kind};

/// Cumulative source bytes per snapshot, including cached pages.
pub const READ_BUDGET_BYTES: u64 = 8_388_608;
/// The protocol's longest text field (`maxForgeTextLength`, `packages/protocol/src/forge.ts`).
pub const MAX_FORGE_TEXT_LENGTH: usize = 65_536;
/// The most labels a read keeps.
pub const MAX_LABELS: usize = 100;

/// A snapshot's read budget: once spent, the snapshot must stop reading.
#[derive(Debug, Default, Clone)]
pub struct ReadBudget {
    bytes: u64,
}

impl ReadBudget {
    /// A fresh budget.
    pub fn new() -> ReadBudget {
        ReadBudget::default()
    }

    /// Records bytes read; a snapshot over budget fails with `limit`.
    pub fn add(&mut self, bytes: u64) -> Result<(), ForgeError> {
        if self.spend(bytes) {
            Ok(())
        } else {
            Err(ForgeError::new(Kind::Limit))
        }
    }

    /// Records bytes read; false once the snapshot is over budget.
    pub fn spend(&mut self, bytes: u64) -> bool {
        self.bytes = self.bytes.saturating_add(bytes);
        self.bytes <= READ_BUDGET_BYTES
    }

    /// The bytes spent so far.
    pub fn spent(&self) -> u64 {
        self.bytes
    }
}

/// `value` cut to the protocol's longest field, in UTF-16 code units.
pub fn clip_text(value: &str) -> String {
    super::tail::clip_units(value, MAX_FORGE_TEXT_LENGTH)
}

/// At most 100 labels, each cut to the protocol's longest field.
pub fn clip_labels(labels: &[String]) -> Vec<String> {
    labels
        .iter()
        .take(MAX_LABELS)
        .map(|label| clip_text(label))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{MAX_LABELS, ReadBudget, clip_labels, clip_text};
    use crate::transport::error::Kind;

    #[test]
    fn the_budget_is_eight_mebibytes_and_fails_once_spent() {
        let mut budget = ReadBudget::new();
        assert!(budget.add(8_388_608).is_ok());
        assert_eq!(budget.spent(), 8_388_608);
        assert_eq!(budget.add(1).expect_err("over budget").kind, Kind::Limit);
        let mut other = ReadBudget::new();
        assert!(!other.spend(8_388_609));
        assert!(!other.spend(0));
    }

    #[test]
    fn text_is_clipped_to_the_protocol_bound() {
        assert_eq!(clip_text("short"), "short");
        assert_eq!(clip_text(&"x".repeat(70_000)).len(), 65_536);
    }

    #[test]
    fn at_most_a_hundred_labels_are_kept() {
        let labels: Vec<String> = (0..150).map(|index| format!("l{index}")).collect();
        let clipped = clip_labels(&labels);
        assert_eq!(clipped.len(), MAX_LABELS);
        assert_eq!(clipped[0], "l0");
        assert_eq!(clipped[99], "l99");
    }
}
