// SPDX-License-Identifier: Apache-2.0

//! The `result` value of a `response`.

use serde::{Deserialize, Serialize};

use crate::files::{Description, Entry, IndexResult, Page, ReadMeta};

/// What a successful request produced. The tag says which op it answers, so a client never has to
/// guess from the shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Reply {
    /// The op did its work and has nothing to return: `closeRoot`, `unwatch`, `createDir`,
    /// `rename`, `remove`, `setMode` and `publish`.
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
    /// The details a `describe` found: version, size, kind and mode in one answer.
    Description(Description),
    /// The bytes a `measure` counted below a path.
    Measure {
        /// The sum of the sizes of the files the path holds.
        bytes: u64,
        /// True when a walk budget stopped the count, so `bytes` is a lower bound.
        shallow: bool,
    },
    /// The metadata of a `read`; the bytes arrive in a body frame when `body` is true.
    Read(ReadMeta),
    /// The version a `write` or `createFile` left behind.
    Version {
        /// The version string, the same format stored drafts carry.
        version: String,
    },
    /// A file's content digest, and the version it was taken at.
    Fingerprint {
        /// The version of the bytes that were hashed.
        version: String,
        /// The file's size in bytes.
        size: u64,
        /// `sha256:` and the digest of the file's bytes.
        digest: String,
    },
    /// The answer to an `indexQuery`.
    Index(IndexResult),
}
