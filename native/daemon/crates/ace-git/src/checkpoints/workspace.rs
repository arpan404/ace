// SPDX-License-Identifier: Apache-2.0
//! `workspaceRevision` (`packages/git/src/index.ts:644`-`:655`, G5): the branch head and the
//! snapshot's tree as one string, so a caller can tell two workspace states apart without reading
//! every file. On an unborn branch the head is the text `unborn`.
//!
//! The revision is taken under the checkout's lease, and the snapshot uses a temporary index: the
//! person's index and checkout are never written.

use crate::checkpoints::restore::Lock;
use crate::checkpoints::snapshot::{DirectCapture, SnapshotContext, snapshot};
use crate::core::error::GitError;
use crate::reads::status::state;

/// `workspaceRevision`: `<branch head or "unborn">:<snapshot tree>`.
pub async fn workspace_revision(
    port: &dyn CommandPort,
    context: &SnapshotContext,
    lock: &dyn Lock,
    root: &str,
) -> Result<String, GitError> {
    let guard = lock.acquire(root).await?;
    let result = async {
        let state = state(port, root, &[]).await?;
        let capture = DirectCapture { port, context };
        let tree = snapshot(port, context, root, None, &capture).await?;
        let head = state.branch.head.as_deref().unwrap_or("unborn");
        Ok(format!("{head}:{tree}"))
    }
    .await;
    lock.release(guard);
    result
}

use crate::reads::CommandPort;

#[cfg(test)]
mod tests;
