// SPDX-License-Identifier: Apache-2.0

//! The `result` value of a `response`.

use serde::{Deserialize, Serialize};

use crate::files::{Entry, IndexResult, Page, ReadMeta};

/// What a successful request produced. The tag says which op it answers, so a client never has to
/// guess from the shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    /// The op did its work and has nothing to return: `closeRoot`, `unwatch`, `createDir`,
    /// `rename` and `remove`.
    Done,
    /// The number of an opened root.
    Root {
        /// The root's number, to pass to every op on this checkout.
        root: u64,
    },
    /// The subscription of a `watch` or `search`.
    Subscription {
        /// The subscription id, which `event` messages carry.
        subscription: u64,
    },
    /// One page of a `list`.
    Page(Page),
    /// The description a `stat` found.
    Entry(Entry),
    /// The metadata of a `read`; the bytes arrive in a body frame when `body` is true.
    Read(ReadMeta),
    /// The version a `write` or `createFile` left behind.
    Version {
        /// The version string, the same format stored drafts carry.
        version: String,
    },
    /// The answer to an `indexQuery`.
    Index(IndexResult),
}
