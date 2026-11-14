// SPDX-License-Identifier: Apache-2.0
//! The last-resort encoder (ADR 0148): a headless Chrome for Testing that ace-media runs itself,
//! encoding H.264 with WebCodecs' software encoder, for machines with no hardware encoder at all
//! (VMs). It is chosen only when the probe found no hardware encode (`last_resort_needed`), and
//! a source on it reports its encode step as `backend: "chrome"`, `hardware: false`.
//!
//! - **Control** goes over Chrome's own `--remote-debugging-pipe` (no TCP debugging port).
//! - **Pictures and chunks** go over two loopback WebSockets as binary messages, never base64:
//!   JPEG pictures as they are (`JpegSurface`), CPU pictures packed (RGBA, BGRA, NV12; RGB is
//!   widened to RGBX). Chunks come back as AVCC with the avcC description on keyframes.
//! - **Supervision.** A crashed browser is replaced on the next picture, which is encoded as a
//!   keyframe. Dropping the encoder closes the browser and removes its profile.

mod cdp;
mod discover;
mod encoder;
mod level;
mod page;
mod probe;
mod session;
mod wire;

pub use discover::{ChromeSearch, candidates, find_chrome};
pub use encoder::{ChromeEncoder, MAX_IN_FLIGHT, MAX_SIDE};
pub use level::h264_codec_string;
pub use probe::{TRIAL_SIZE, last_resort_needed, probe};

use media_codec::{CodecError, Picture, PixelFormat, PlatformPicture, PlatformSurface, Size};
use std::path::PathBuf;
use std::time::Duration;

/// How to run the encoder's Chrome. Everything is passed in; nothing is read from globals.
#[derive(Clone, Debug)]
pub struct ChromeOptions {
    pub executable: PathBuf,
    /// Where each browser's own profile directory is made (and removed again).
    pub profile_root: PathBuf,
    /// Spawn to the page's first answer.
    pub startup_timeout: Duration,
    /// A configuration or flush answered by the page.
    pub reply_timeout: Duration,
    /// Restarts in a row with no chunk in between before the encoder gives up.
    pub max_restarts: u32,
    /// Extra Chrome switches, last on the command line (the daemon's `--no-sandbox` choice).
    pub extra_args: Vec<String>,
}

impl ChromeOptions {
    pub fn new(executable: PathBuf, profile_root: PathBuf) -> Self {
        Self {
            executable,
            profile_root,
            startup_timeout: Duration::from_secs(10),
            reply_timeout: Duration::from_secs(5),
            max_restarts: 3,
            extra_args: Vec::new(),
        }
    }
}

/// A JPEG picture, passed to the page as it is; Chrome decodes it. The picture's format is
/// `Rgb8`, what a baseline JPEG decodes to.
pub struct JpegSurface {
    bytes: Vec<u8>,
}

impl JpegSurface {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl PlatformSurface for JpegSurface {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

/// A JPEG as an encoder picture, sized from its own header.
pub fn jpeg_picture(bytes: Vec<u8>, pts_us: u64) -> Result<Picture, CodecError> {
    let size: Size = media_codec::jpeg_size(&bytes)?;
    size.validate()?;
    Ok(Picture::Platform(PlatformPicture {
        size,
        format: PixelFormat::Rgb8,
        pts_us,
        surface: Box::new(JpegSurface { bytes }),
    }))
}
