// SPDX-License-Identifier: Apache-2.0
//! The seam a recorder plugs into. The fragmented-MP4 recorder is F1's; until it lands every
//! `record.start` fails, so the daemon keeps recording on its legacy path.
use media_wire::control::Part;
use media_wire::frame::MediaFrame;

/// What `record.start` asks for.
pub struct RecordSpec<'a> {
    pub recording: &'a str,
    pub source: &'a str,
    pub directory: &'a str,
    pub max_bytes: u64,
    pub pointer_track: bool,
}

/// One running recording. It sees only frames the privacy barrier released.
pub trait Recorder: Send {
    fn write(&mut self, frame: &MediaFrame);
    /// Frames were lost (held past the bound, or dropped to the next keyframe).
    fn gap(&mut self);
    /// `record.cut`: start a new part at the next keyframe.
    fn cut(&mut self);
    fn meta(&mut self, epoch: u32, data: &serde_json::Value);
    /// `record.stop` or shutdown: close the last part. The parts written, or why it failed.
    fn finish(self: Box<Self>) -> Result<Vec<Part>, String>;
}

pub trait Recorders: Send {
    fn start(&mut self, spec: &RecordSpec<'_>) -> Result<Box<dyn Recorder>, String>;
}

/// No recorder is built into this binary yet.
pub struct NoRecorders;

impl Recorders for NoRecorders {
    fn start(&mut self, _: &RecordSpec<'_>) -> Result<Box<dyn Recorder>, String> {
        Err("recorder-unavailable".into())
    }
}
