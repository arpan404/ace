// SPDX-License-Identifier: Apache-2.0

//! The daemon's side of the screen session helper (ADR 0225, S2.1): the frame wire inside the
//! daemon, a frame as the shared media stream's pictures carry it, the bounded hub that
//! delivers the newest frame to each viewer, and the one error a failed shutdown reports.
//!
//! The helper stays its own native process and its wire stays byte for byte: a captured frame
//! is `u32 header length | JSON header | payload`, and a recording file is those frames back to
//! back. Neither ever reaches a client; viewers get pictures on the shared media stream.

pub mod error;
pub mod session;

pub use error::ScreenError;
pub use session::frame_hub::{FrameHub, Subscription};
pub use session::frame_picture::{CapturedPicture, frame_picture};
pub use session::frames::{Frame, FrameDecoder, FrameHeader, frame_packet, wire_frame};
pub use session::physical_input::{MacPhysicalInput, MacPorts, WindowsPhysicalInput, WindowsPorts};
pub use session::shutdown_failure::{ShutdownFailure, shutdown_failure};
