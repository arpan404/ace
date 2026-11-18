// SPDX-License-Identifier: Apache-2.0

//! What a watcher reports to its sink.

/// One batch of news about the tree.
///
/// The sink is called from the watcher's own thread, at most once per quiet period, and
/// batches arrive in the order the changes happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Batch {
    /// Paths that changed, sorted by path. Every path appears once per batch.
    Changes(Vec<Change>),
    /// The tree could not be tracked precisely: list that folder again, or the whole root
    /// when `dir` is `None`. Everything the batch would have reported is inside it.
    Rescan { dir: Option<String> },
    /// Watching works but is degraded; the message says why.
    Warning(String),
}

/// One path that changed, relative to the root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    /// Relative path from the root, `/` separated, never empty.
    pub path: String,
    /// What happened to the path inside the batch's window.
    pub kind: ChangeKind,
    /// Whether the path is a directory. A symbolic link is never one.
    pub directory: bool,
}

/// What happened to a path, after coalescing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    /// The path appeared.
    Created,
    /// The path's contents or metadata changed, including a rename onto it.
    Modified,
    /// The path is gone. A deleted folder takes its whole subtree with it, whatever
    /// `Change::directory` says (a rename or a truncated event cannot always tell what it was).
    Deleted,
}
