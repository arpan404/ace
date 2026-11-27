// SPDX-License-Identifier: Apache-2.0
//! A search page's wire structs, in the protocol's field order.

use serde::Serialize;

/// One hit, in the protocol's field order. The snippet keeps UTF-16 offsets.
#[derive(Serialize)]
pub struct Hit<'a> {
    #[serde(rename = "threadId")]
    pub thread_id: &'a str,
    #[serde(rename = "itemId")]
    pub item_id: &'a str,
    pub seq: i64,
    #[serde(rename = "turnOrdinal")]
    pub turn_ordinal: Option<i64>,
    pub snippet: SnippetOut,
}

/// A snippet, in the protocol's field order.
#[derive(Serialize)]
pub struct SnippetOut {
    pub text: String,
    pub highlights: Vec<HighlightOut>,
}

/// One highlight, in the protocol's field order.
#[derive(Serialize)]
pub struct HighlightOut {
    pub start: usize,
    pub end: usize,
}

/// The response, in the protocol's field order. Hits splice finished buffers.
#[derive(Serialize)]
pub struct SearchPage<'a> {
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(rename = "requestId")]
    pub request_id: &'a str,
    #[serde(rename = "threadId")]
    pub thread_id: &'a str,
    pub hits: Vec<Hit<'a>>,
    pub cursor: Option<String>,
    #[serde(rename = "indexedSeq")]
    pub indexed_seq: i64,
    #[serde(rename = "headSeq")]
    pub head_seq: i64,
    pub pending: i64,
    pub ready: bool,
}
