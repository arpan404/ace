// SPDX-License-Identifier: Apache-2.0
//! A steps page's wire structs, in the protocol's field order.
//!
//! A step splices its stored item bytes; the surface is added after the budget.

use super::surface::Surface;
use serde::Serialize;

/// One step, in the protocol's field order. The item splices stored bytes.
#[derive(Serialize)]
pub struct StepOut {
    pub seq: i64,
    pub item: Box<serde_json::value::RawValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<Surface>,
}

/// A page of steps, in the protocol's field order.
#[derive(Serialize)]
pub struct StepsPage<'a> {
    #[serde(rename = "type")]
    pub type_: &'static str,
    #[serde(rename = "requestId")]
    pub request_id: &'a str,
    #[serde(rename = "threadId")]
    pub thread_id: &'a str,
    #[serde(rename = "turnOrdinal")]
    pub turn_ordinal: i64,
    pub seq: i64,
    #[serde(rename = "endSeq")]
    pub end_seq: i64,
    pub steps: Vec<StepOut>,
    pub after: Option<i64>,
}
