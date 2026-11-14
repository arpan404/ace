// SPDX-License-Identifier: Apache-2.0
//! What a client says about its link (ADR 0149, K3). It is the client's word: every field is
//! optional and bounded by its type, and it only picks a viewer's starting step. It never
//! raises a rate above what the link has measured.
use crate::control::{Id, present};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LinkHint {
    /// The web's `navigator.connection.effectiveType` (`slow-2g`, `2g`, `3g`, `4g`). An open
    /// string, so a later value parses.
    #[serde(
        rename = "effectiveType",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub effective_type: Option<Id>,
    /// The client's estimate of its downlink.
    #[serde(
        rename = "downlinkKbps",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub downlink_kbps: Option<u32>,
    /// The client's estimate of its round trip.
    #[serde(
        rename = "rttMs",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub rtt_ms: Option<u32>,
    /// `Save-Data`, or `navigator.connection.saveData`.
    #[serde(
        rename = "saveData",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub save_data: Option<bool>,
    /// iOS `NWPath.isExpensive`: a cellular link or a hotspot.
    #[serde(
        rename = "expensive",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub expensive: Option<bool>,
    /// iOS `NWPath.isConstrained`: Low Data Mode.
    #[serde(
        rename = "constrained",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub constrained: Option<bool>,
}
