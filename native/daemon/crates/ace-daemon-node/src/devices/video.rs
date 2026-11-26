// SPDX-License-Identifier: Apache-2.0
//! D3.3's capture decisions: the values a capture, route or settings change asks for, and the
//! one per-frame conversion measured against the TypeScript before any per-frame wiring.
//! Every function translates values; behaviour lives in `ace-devices`.

use ace_devices::platform::capture;
use ace_devices::platform::capture::{
    WindowChoice, android_live_view_error, choose_window, needs_tools_download, simulator_route,
};
use ace_devices::platform::host_frames;
use ace_devices::platform::one_off_screenshot;
use ace_devices::platform::scrcpy::capture::frame as forwarded_frame;
use ace_devices::platform::scrcpy::protocol::ScreenSize;
use ace_devices::platform::simulator_capture;
use ace_devices::platform::simulator_transcode;
use napi_derive::napi;

/// A JSON document this crate's `ace-json` wrote.
fn parse<T: serde::de::DeserializeOwned>(text: &str) -> napi::Result<T> {
    let value = ace_json::parse(text)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))?;
    ace_json::from_value(&value)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

use super::answered;

/// One Simulator's start route, or the refusal that stops it.
#[napi]
pub fn device_capture_simulator_route(
    supported: bool,
    command: Option<String>,
    version: Option<String>,
    serve_sim_env: bool,
    screen_available: bool,
) -> napi::Result<String> {
    answered(|| {
        simulator_route(
            supported,
            command.as_deref(),
            version.as_deref(),
            serve_sim_env,
            screen_available,
        )
    })
}

#[napi]
pub fn device_capture_needs_tools_download(supported: bool, serve_sim_env: bool) -> bool {
    needs_tools_download(supported, serve_sim_env)
}

/// The window list as JSON pairs; the answer names the one window, many or none.
#[napi]
pub fn device_capture_windows(windows: String, name: String) -> napi::Result<String> {
    let pairs: Vec<(String, String)> = parse(&windows)?;
    let borrowed: Vec<(&str, &str)> = pairs
        .iter()
        .map(|(bundle, title)| (bundle.as_str(), title.as_str()))
        .collect();
    let choice = choose_window(&borrowed, &name);
    let text = match choice {
        WindowChoice::One(index) => format!("{{\"choice\":\"one\",\"index\":{index}}}"),
        WindowChoice::Many => "{\"choice\":\"many\"}".to_string(),
        WindowChoice::None => "{\"choice\":\"none\"}".to_string(),
    };
    Ok(text)
}

#[napi]
pub fn device_capture_android_live_view_error(why: String) -> napi::Result<String> {
    answered(|| Err::<(), _>(android_live_view_error(&why)))
}

/// serve-sim's endpoint line, or the refusal that a helper announced something else.
#[napi]
pub fn device_capture_endpoint(line: String) -> napi::Result<String> {
    answered(|| simulator_capture::parse_endpoint(&line))
}

#[napi]
pub fn device_capture_local_url(
    value: String,
    port: u32,
    protocol: String,
) -> napi::Result<String> {
    answered(|| {
        simulator_capture::local_url(&value, port as u16, &protocol).map(|url| url.to_string())
    })
}

#[napi]
pub fn device_capture_sibling(stream: String, name: String) -> napi::Result<String> {
    answered(|| simulator_capture::sibling_str(&stream, &name))
}

/// The screen config in a control message's payload.
#[napi]
pub fn device_capture_screen_config(payload: String) -> napi::Result<String> {
    let text = payload.as_bytes();
    match simulator_capture::screen_config(text) {
        Some(config) => ace_json::ser::to_string(&config)
            .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}"))),
        None => Ok("null".to_string()),
    }
}

#[napi]
pub fn device_capture_spawn_args(command_args: String, udid: String) -> napi::Result<String> {
    let args: Vec<String> = parse(&command_args)?;
    ace_json::ser::to_string(&simulator_capture::spawn_args(&args, &udid))
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

#[napi]
pub fn device_capture_transcode(
    transcoding: bool,
    bitrate: f64,
    max_width: f64,
    max_height: f64,
    native_width: Option<f64>,
    native_height: Option<f64>,
    source: Option<f64>,
) -> bool {
    simulator_transcode::needs_transcode(&simulator_transcode::TranscodeInput {
        transcoding,
        bitrate,
        box_: simulator_transcode::Box {
            max_width,
            max_height,
        },
        native: match (native_width, native_height) {
            (Some(width), Some(height)) => Some(simulator_transcode::Size { width, height }),
            _ => None,
        },
        source,
    })
}

#[napi]
pub fn device_capture_encode_spec(
    native_width: f64,
    native_height: f64,
    max_width: f64,
    max_height: f64,
    bitrate: f64,
) -> napi::Result<String> {
    ace_json::ser::to_string(&simulator_transcode::encode_spec(
        simulator_transcode::Size {
            width: native_width,
            height: native_height,
        },
        simulator_transcode::EncodeSettings {
            max_width,
            max_height,
            bitrate,
        },
    ))
    .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

#[napi]
pub fn device_capture_still_scale(encoded_width: u32, native_width: Option<f64>) -> f64 {
    simulator_capture::still_scale(
        encoded_width,
        native_width.map(|width| simulator_transcode::Size {
            width,
            height: width,
        }),
    )
}

#[napi]
pub fn device_host_frames_name(runtime_id: String) -> String {
    host_frames::file_name(&runtime_id)
}

#[napi]
pub fn device_host_frames_bytes(width: u32, height: u32) -> String {
    host_frames::file_bytes(u64::from(width), u64::from(height)).to_string()
}

#[napi]
pub fn device_host_frames_edge(box_: f64) -> u32 {
    host_frames::stream_edge(box_)
}

#[napi]
pub fn device_screenshot_check_source(bytes: u32) -> napi::Result<String> {
    answered(|| one_off_screenshot::check_source(bytes as usize))
}

#[napi]
pub fn device_screenshot_fit_op() -> napi::Result<String> {
    ace_json::ser::to_string(&one_off_screenshot::fit_op())
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

#[napi]
pub fn device_screenshot_scale(encoded_width: u32, source_width: u32) -> f64 {
    one_off_screenshot::scale(encoded_width, source_width)
}

/// The per-frame conversion measured against the TypeScript: one scrcpy unit to the frame the
/// daemon forwards, payload included.
#[napi]
pub fn device_video_forward_frame(
    unit: String,
    display_width: f64,
    display_height: f64,
    sequence: String,
) -> napi::Result<String> {
    let unit: ace_devices::platform::media_paths::VideoUnit = parse(&unit)?;
    let sequence: u64 = sequence
        .parse()
        .map_err(|_| napi::Error::from_reason("ace-devices: bad sequence".to_string()))?;
    let frame = forwarded_frame(
        &unit,
        ScreenSize {
            width: display_width,
            height: display_height,
        },
        sequence,
    );
    ace_json::ser::to_string(&frame)
        .map_err(|error| napi::Error::from_reason(format!("ace-devices: {error}")))
}

#[napi]
pub fn device_capture_route_exists() -> bool {
    capture::android_capture_enabled(false)
}
