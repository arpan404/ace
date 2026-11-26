// SPDX-License-Identifier: Apache-2.0
//! The emulator gRPC binding (D3.3, U4): the request bytes and the stream's once-per-stream
//! answers. The HTTP/2 connection, the shared file and each reply's framing stay the shell's
//! (a per-chunk crossing is the per-frame rule); nothing here decides anything.

use ace_devices::platform::emulator_grpc;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

/// The `screenshotRequest` message, so the shell sends the exact bytes: the file URL is
/// `pathToFileURL(file).href` as the TypeScript spells it.
#[napi]
pub fn device_emulator_screenshot_request(width: u32, height: u32, handle: String) -> Buffer {
    Buffer::from(emulator_grpc::screenshot_request(width, height, &handle))
}

/// What a `grpc-status` refuses the stream with, or nothing for a status that is fine.
#[napi]
pub fn device_emulator_status_refusal(status: String) -> Option<String> {
    emulator_grpc::status_refusal(&status)
}

/// What a stream that ended on its own reports.
#[napi]
pub fn device_emulator_stream_ended() -> String {
    emulator_grpc::stream_ended().to_string()
}
