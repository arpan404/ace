// SPDX-License-Identifier: Apache-2.0

//! The JSON messages the two sides exchange.

use serde::{Deserialize, Serialize};

use crate::event::EventPayload;
use crate::op::Op;
use crate::reply::Reply;

/// The protocol version both sides send in `hello`. A different number is a version mismatch and
/// the daemon restarts `ace-files` rather than guessing.
pub const PROTOCOL: u32 = 1;

/// One JSON message, tagged by `type`.
///
/// `hello` goes both ways: the daemon opens with `protocol` only, and `ace-files` answers with the
/// same `protocol` and the binary's `version`, so the daemon can log what it is talking to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Message {
    /// The opening handshake.
    Hello {
        /// The protocol version the sender speaks.
        protocol: u32,
        /// The `ace-files` build version. Absent in the daemon's greeting.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        version: Option<String>,
    },
    /// A request, answered by a `response` or an `error` with the same id.
    Request {
        /// Identifies the request and the body frame that may belong to it.
        id: u64,
        /// What to do.
        op: Op,
    },
    /// Give up on a request; its response is still allowed to arrive.
    Cancel {
        /// The id of the request to cancel.
        id: u64,
    },
    /// A request succeeded.
    Response {
        /// The id of the request.
        id: u64,
        /// What it produced.
        result: Reply,
    },
    /// A request failed.
    Error {
        /// The id of the request.
        id: u64,
        /// A stable code such as `NOT_FOUND`.
        code: String,
        /// A sentence for a log or the person.
        message: String,
        /// The version of the file now, so a rejected write can offer to reload it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current: Option<String>,
    },
    /// Something happened on a subscription.
    Event {
        /// The subscription a `watch` or `search` handed out.
        subscription: u64,
        /// What happened.
        payload: EventPayload,
    },
}
