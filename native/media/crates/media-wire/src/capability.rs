// SPDX-License-Identifier: Apache-2.0
//! What the probe found per step (ADR 0148), and what each source runs on.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Step {
    #[serde(rename = "encode")]
    Encode,
    #[serde(rename = "decode")]
    Decode,
    #[serde(rename = "jpeg-decode")]
    JpegDecode,
    #[serde(rename = "jpeg-encode")]
    JpegEncode,
    #[serde(rename = "scale")]
    Scale,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Backend {
    #[serde(rename = "vt")]
    Vt,
    #[serde(rename = "mf")]
    Mf,
    #[serde(rename = "vaapi")]
    Vaapi,
    #[serde(rename = "nv")]
    Nv,
    /// The last-resort encoder (`media-chrome`).
    #[serde(rename = "chrome")]
    Chrome,
    #[serde(rename = "cpu")]
    Cpu,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrialState {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "timed-out")]
    TimedOut,
    #[serde(rename = "failed")]
    Failed,
}
/// One probe result: a step and codec on one backend. `codec` is absent for `scale`; sizes
/// are 0 when the trial didn't succeed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capability {
    #[serde(rename = "step")]
    pub step: Step,
    #[serde(
        rename = "codec",
        default,
        deserialize_with = "crate::control::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub codec: Option<String>,
    #[serde(rename = "backend")]
    pub backend: Backend,
    #[serde(rename = "hardware")]
    pub hardware: bool,
    #[serde(rename = "zeroCopy")]
    pub zero_copy: bool,
    #[serde(rename = "state")]
    pub state: TrialState,
    #[serde(rename = "maxWidth")]
    pub max_width: u32,
    #[serde(rename = "maxHeight")]
    pub max_height: u32,
}
/// One step a source is running, with its picture-sized copies per frame (per still for stills).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceStep {
    #[serde(rename = "step")]
    pub step: Step,
    #[serde(rename = "backend")]
    pub backend: Backend,
    #[serde(rename = "hardware")]
    pub hardware: bool,
    #[serde(rename = "readbacks")]
    pub readbacks: u32,
    #[serde(rename = "uploads")]
    pub uploads: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Acceleration {
    #[serde(rename = "steps")]
    pub steps: Vec<SourceStep>,
    #[serde(rename = "degraded")]
    pub degraded: bool,
    #[serde(
        rename = "reason",
        default,
        deserialize_with = "crate::control::present",
        skip_serializing_if = "Option::is_none"
    )]
    pub reason: Option<String>,
}
