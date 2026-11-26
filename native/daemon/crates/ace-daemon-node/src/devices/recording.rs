// SPDX-License-Identifier: Apache-2.0
//! The recording binding (D3.3, U5): the once-per-recording decisions and the publication plan.
//! The frames a recording keeps, ace-media's writer and the renames are the shell's.

use ace_devices::platform::recording;
use ace_devices::platform::recording_artifact::Part;
use ace_devices::platform::{Platform, recording_artifact};
use napi_derive::napi;

use super::answered;

fn json<T: serde::Serialize>(value: &T) -> napi::Result<String> {
    ace_json::ser::to_string(value)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

/// Whether a recording may start, or the refusal the person sees.
#[napi]
pub fn device_recording_start_refusal(
    has_thread: bool,
    live: bool,
    started: bool,
    starting: bool,
    closing: bool,
    registry_available: bool,
) -> napi::Result<String> {
    answered(|| {
        recording::start_refusal(recording::StartFacts {
            has_thread,
            live,
            recording: started,
            recording_starting: starting,
            recording_closing: closing,
            registry_available,
        })
    })
}

/// A capture that isn't streaming H.264 can't be recorded.
#[napi]
pub fn device_recording_codec_refusal(codec: String) -> napi::Result<String> {
    answered(|| recording::codec_refusal(&codec))
}

/// The recording's limit and the most one MP4 part holds.
#[napi]
pub fn device_recording_sizes(limit: Option<f64>) -> napi::Result<String> {
    json(&recording::sizes(limit))
}

/// Where ace-media reads the recording's video from.
#[napi]
pub fn device_recording_origin(platform: String) -> napi::Result<String> {
    let platform = Platform::parse(&platform)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))?;
    json(&recording::origin(platform))
}

/// How one recording's end reads: the failure, its truncation and the no-video failure.
#[napi]
pub fn device_recording_end(
    ok: bool,
    truncated: bool,
    reason: String,
    parts: u32,
) -> napi::Result<String> {
    json(&recording::ended(ok, truncated, &reason, parts as usize))
}

/// A notice a recording leaves on its thread.
#[napi]
pub fn device_recording_notice(kind: String, directory: Option<String>) -> napi::Result<String> {
    match kind.as_str() {
        "sizeLimit" => Ok(recording::SIZE_LIMIT_NOTICE.to_string()),
        "writeFailed" => Ok(recording::WRITE_FAILED_NOTICE.to_string()),
        "truncated" => Ok(recording::TRUNCATED_NOTICE.to_string()),
        "unsaved" => Ok(recording::UNSAVED_NOTICE.to_string()),
        "kept" => Ok(recording::kept_notice(directory.as_deref().unwrap_or(""))),
        other => Err(napi::Error::from_reason(format!(
            "ace-devices: unknown recording notice: {other}"
        ))),
    }
}

/// The publication plan: each part's id, file and name, in ace-media's order.
#[napi]
pub fn device_recording_parts(id: String, indexes: Vec<u32>) -> napi::Result<String> {
    let indexes: Vec<u64> = indexes.into_iter().map(u64::from).collect();
    let parts: Vec<Part> = recording_artifact::parts(&id, &indexes);
    json(&parts)
}

/// Why a publication stopped, naming where the video is kept.
#[napi]
pub fn device_recording_publish_failure(directory: String, root: String) -> String {
    recording_artifact::publish_failure(&directory, &root)
}
