// SPDX-License-Identifier: Apache-2.0
//! The recovery pass's history refresh (`packages/adapter-opencode/src/history.ts`):
//! opaque pagination that refreshes the mutable head and stops at the previous
//! immutable message.
//!
//! One read is a machine: it asks for a page, reads it, and either asks for the
//! next one or reports the head it reached. The session's last head is kept
//! across passes, so a later pass reads only what arrived since.

use ace_json::{Value, json};
use indexmap::{IndexMap, IndexSet};

use crate::translate::boundaries::{BoundaryError, parse_page, parse_projected_message};
use crate::translate::data::{fields, get, s_in};

use super::http::Reply;

/// `for (let n = 0; n < 512; n++)`.
const MAX_PAGES: usize = 512;

/// Why a history refresh could not finish. The pass carries the text.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HistoryError {
    #[error("Repeated OpenCode history cursor")]
    RepeatedCursor,
    #[error("OpenCode history page limit reached")]
    PageLimit,
    #[error("Invalid projected message identity")]
    MessageIdentity,
    #[error("{0}")]
    Envelope(String),
}

impl From<BoundaryError> for HistoryError {
    fn from(error: BoundaryError) -> Self {
        Self::Envelope(error.to_string())
    }
}

/// Why a page stopped: the read's own check, or the caller's delivery. The
/// TypeScript's `receive` callback can throw, and that throw leaves the head
/// where it was, so a page never commits past a message it could not deliver.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Failure<E> {
    #[error("{0}")]
    History(#[from] HistoryError),
    #[error("{0}")]
    Delivery(E),
}

impl<E> From<BoundaryError> for Failure<E> {
    fn from(error: BoundaryError) -> Self {
        Self::History(HistoryError::from(error))
    }
}

/// One session's in-flight refresh.
pub struct Read {
    session: String,
    head: Option<String>,
    cursor: Option<String>,
    newest: String,
    cursors: IndexSet<String>,
    pages: usize,
}

/// What one reply asked for next.
#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    /// `message.list` with these params.
    Request(Value),
    /// The refresh ended; its messages were delivered.
    Done,
}

/// The pass's history heads, one per session.
#[derive(Default)]
pub struct HistoryReader {
    heads: IndexMap<String, String>,
}

impl HistoryReader {
    pub fn new() -> Self {
        Self::default()
    }

    /// The first request for a session: `order: "desc"`, no cursor.
    pub fn begin(&self, session: &str) -> (Read, Step) {
        let read = Read {
            session: session.to_owned(),
            head: self.heads.get(session).cloned(),
            cursor: None,
            newest: String::new(),
            cursors: IndexSet::new(),
            pages: 0,
        };
        (read, Step::Request(params(session, None)))
    }

    /// One page. Every message is handed to `deliver` in page order, as the
    /// TypeScript's `receive` callback is; a failed delivery stops the read
    /// before its head moves.
    pub fn step<E>(
        &mut self,
        read: &mut Read,
        reply: &Reply,
        deliver: &mut dyn FnMut(&Value) -> Result<(), E>,
    ) -> Result<Step, Failure<E>> {
        let body = fields(&reply.body);
        let messages = parse_page(&reply.body)?;
        let mut reached = false;
        for message in messages {
            let key = s_in(fields(message), "id");
            if key.is_empty() {
                return Err(Failure::History(HistoryError::MessageIdentity));
            }
            if read.newest.is_empty() {
                read.newest = key.to_owned();
            }
            deliver(&Value::Object(parse_projected_message(message)?.clone()))
                .map_err(Failure::Delivery)?;
            if read.head.as_deref() == Some(key) {
                reached = true;
                break;
            }
        }
        read.pages += 1;
        let next = s_in(fields(get(body, "cursor")), "next");
        if next.is_empty() || reached {
            if !read.newest.is_empty() {
                self.heads.insert(read.session.clone(), read.newest.clone());
            }
            return Ok(Step::Done);
        }
        if !read.cursors.insert(next.to_owned()) {
            return Err(Failure::History(HistoryError::RepeatedCursor));
        }
        if read.pages >= MAX_PAGES {
            return Err(Failure::History(HistoryError::PageLimit));
        }
        read.cursor = Some(next.to_owned());
        Ok(Step::Request(params(&read.session, Some(next))))
    }
}

/// `message.list`'s arguments, as the TypeScript builds them.
fn params(session: &str, cursor: Option<&str>) -> Value {
    match cursor {
        Some(cursor) => json!({ "sessionID": session, "limit": 128, "cursor": cursor }),
        None => json!({ "sessionID": session, "limit": 128, "order": "desc" }),
    }
}

#[cfg(test)]
mod tests;
