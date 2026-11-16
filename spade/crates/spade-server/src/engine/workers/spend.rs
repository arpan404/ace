//! What a worker's subtree spent (ADR 0161), shown in the tree as information. Nothing bounds
//! it (ADR 0166).

use super::super::Engine;

impl Engine {
    /// What `conversation`'s subtree has spent, all told.
    pub(super) fn subtree_spent(&self, conversation: &str) -> u64 {
        self.store
            .spent_by_all(&self.worker_subtree(conversation), 0)
            .unwrap_or(0)
    }
}
