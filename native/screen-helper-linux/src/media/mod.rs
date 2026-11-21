//! The helper's video for ace-media (docs/media/plan.md, E2): which encoder a screen uses and
//! what it reports, the stream settings, and the capture-side encoders. Units go only to
//! ace-media's ingest.
#[cfg(target_os = "linux")]
pub mod encoder;
#[cfg(target_os = "linux")]
mod gl;
#[cfg(target_os = "linux")]
pub mod ingest;
pub mod pixels;
pub mod select;
pub mod stream;
#[cfg(target_os = "linux")]
pub mod trials;
#[cfg(target_os = "linux")]
pub mod video;
