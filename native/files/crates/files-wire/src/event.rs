// SPDX-License-Identifier: Apache-2.0

//! What a watcher or search reports while its subscription is open.

use serde::{Deserialize, Serialize};

use crate::files::{FileMatches, Summary};

/// One path the watcher saw change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// Root-relative path.
    pub path: String,
    /// What happened to it.
    pub kind: ChangeKind,
    /// True when the path is a directory.
    pub directory: bool,
}

/// What happened to a watched path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// The path appeared.
    Created,
    /// The path changed. A delete followed by a create inside one window also arrives as this.
    Modified,
    /// The path disappeared.
    Deleted,
}

/// An `event` message's payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EventPayload {
    /// A debounced batch of watch changes.
    Changes {
        /// The changes, already coalesced.
        changes: Vec<Change>,
    },
    /// The watcher could not describe individual changes and the folder must be listed again.
    Rescan {
        /// The narrowest folder to rescan; absent means the whole root.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dir: Option<String>,
    },
    /// The watcher is degraded; the message says why, for example a polling fallback.
    Warning {
        /// A sentence to show the person.
        message: String,
    },
    /// A search found matching lines in one file.
    Matches {
        /// The file and its matching lines.
        file: FileMatches,
    },
    /// A search finished.
    SearchDone {
        /// What the search covered and whether it stopped at its limit.
        summary: Summary,
    },
}
