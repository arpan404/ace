// SPDX-License-Identifier: Apache-2.0
//! The seam a recorder plugs into (docs/media/plan.md, "Recording privacy barrier"). The engine
//! hands a recorder only what the barrier released; the recorder turns it into parts on disk.
//! `NoRecorders` refuses every recording, so the daemon keeps its legacy path.
use media_wire::control::Part;
use media_wire::frame::MediaFrame;

/// What `record.start` asks for.
pub struct RecordSpec<'a> {
    pub recording: &'a str,
    pub source: &'a str,
    pub directory: &'a str,
    /// The most one part may hold; never above 512 MiB.
    pub max_bytes: u64,
    pub pointer_track: bool,
}

/// One running recording. It sees only frames the privacy barrier released, and only metadata
/// whose epoch was decided clear. A part it closes goes into `closed`; an error ends the
/// recording with `record.failed`.
pub trait Recorder: Send {
    /// `captured_us` is when the frame was captured, on ace-media's monotonic clock: its
    /// arrival less the producer's `age`. It times samples and is never used for privacy.
    fn write(
        &mut self,
        frame: &MediaFrame,
        captured_us: u64,
        closed: &mut Vec<Part>,
    ) -> Result<(), String>;
    /// Frames were lost (held past the bound, or dropped to the next keyframe).
    fn gap(&mut self, closed: &mut Vec<Part>) -> Result<(), String>;
    /// `record.cut`: start a new part at the next keyframe.
    fn cut(&mut self);
    /// `record.meta` of a clear epoch, at `at_us` on the same clock as `captured_us`.
    fn meta(&mut self, at_us: u64, epoch: u32, data: &serde_json::Value) -> Result<(), String>;
    /// `record.stop` or shutdown: close the last part. Every part this process wrote, or why
    /// it failed.
    fn finish(self: Box<Self>) -> Result<Vec<Part>, String>;
}

pub trait Recorders: Send {
    /// Starts a recording. Parts a previous process left in the directory (cut by a crash)
    /// are made playable to their last whole fragment and returned, so the daemon hears of
    /// them; the new recording continues in the next part.
    fn start(&mut self, spec: &RecordSpec<'_>) -> Result<Started, String>;
}

pub struct Started {
    pub recorder: Box<dyn Recorder>,
    pub recovered: Vec<Part>,
}

/// Refuses every recording.
pub struct NoRecorders;

impl Recorders for NoRecorders {
    fn start(&mut self, _: &RecordSpec<'_>) -> Result<Started, String> {
        Err("recorder-unavailable".into())
    }
}
