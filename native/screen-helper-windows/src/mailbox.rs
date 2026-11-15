//! What waits for the daemon's pipe. Stills are latest-only: one pending packet, replaced by a
//! newer one. Video is ordered: every H.264 unit is written, none coalesced, up to
//! [`VIDEO_LIMIT`] queued bytes; past that deltas are dropped to the next keyframe, which is
//! asked for once. Retirement is logical for the in-flight packet: its bytes finish intact,
//! then receivers reject its generation. A partial packet is never cancelled on the shared
//! byte stream.
use std::collections::VecDeque;

pub const VIDEO_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Default)]
pub struct Mailbox {
    active: Option<u64>,
    pending: Option<Packet>,
    video: VecDeque<Packet>,
    video_bytes: usize,
    skipping: bool,
}
pub struct Packet {
    pub generation: u64,
    pub bytes: Vec<u8>,
}
/// What publishing a video unit did.
#[derive(Debug, PartialEq, Eq)]
pub enum Queued {
    Queued,
    /// Dropped: the session's generation was retired, or deltas are skipped to a keyframe.
    Dropped,
    /// Dropped, and a keyframe should be asked for.
    WantKeyframe,
}
impl Mailbox {
    pub fn activate(&mut self, generation: u64) {
        self.retire();
        self.active = Some(generation);
    }
    pub fn retire(&mut self) {
        self.active = None;
        self.pending = None;
        self.video.clear();
        self.video_bytes = 0;
        self.skipping = false;
    }
    pub fn current(&self, generation: u64) -> bool {
        self.active == Some(generation)
    }
    pub fn publish(&mut self, generation: u64, bytes: Vec<u8>) -> bool {
        if !self.current(generation) {
            return false;
        }
        self.pending = Some(Packet { generation, bytes });
        true
    }
    pub fn publish_video(&mut self, generation: u64, bytes: Vec<u8>, key: bool) -> Queued {
        if !self.current(generation) {
            return Queued::Dropped;
        }
        if self.video_bytes > 0 && self.video_bytes + bytes.len() > VIDEO_LIMIT {
            if key {
                // The backlog can't be decoded past a gap anyway: the keyframe starts afresh.
                self.video.clear();
                self.video_bytes = 0;
            } else {
                let first = !self.skipping;
                self.skipping = true;
                return if first {
                    Queued::WantKeyframe
                } else {
                    Queued::Dropped
                };
            }
        }
        if self.skipping && !key {
            return Queued::Dropped;
        }
        self.skipping = false;
        self.video_bytes += bytes.len();
        self.video.push_back(Packet { generation, bytes });
        Queued::Queued
    }
    /// The next packet to write: video in order first, then the newest still.
    pub fn take(&mut self) -> Option<Packet> {
        if let Some(packet) = self.video.pop_front() {
            self.video_bytes -= packet.bytes.len();
            return Some(packet);
        }
        self.pending.take()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drain(mailbox: &mut Mailbox) -> Vec<Vec<u8>> {
        std::iter::from_fn(|| mailbox.take().map(|p| p.bytes)).collect()
    }

    #[test]
    fn video_is_written_in_order_and_never_coalesced_while_stills_keep_only_the_newest() {
        let mut mailbox = Mailbox::default();
        mailbox.activate(1);
        assert!(mailbox.publish(1, vec![100]));
        assert!(mailbox.publish(1, vec![101]));
        for unit in 0..3u8 {
            assert_eq!(
                mailbox.publish_video(1, vec![unit], unit == 0),
                Queued::Queued
            );
        }
        assert_eq!(
            drain(&mut mailbox),
            vec![vec![0], vec![1], vec![2], vec![101]]
        );
    }

    #[test]
    fn a_full_video_queue_drops_deltas_to_the_next_keyframe_asked_for_once() {
        let mut mailbox = Mailbox::default();
        mailbox.activate(1);
        assert_eq!(
            mailbox.publish_video(1, vec![0; VIDEO_LIMIT], true),
            Queued::Queued
        );
        assert_eq!(
            mailbox.publish_video(1, vec![1], false),
            Queued::WantKeyframe
        );
        assert_eq!(mailbox.publish_video(1, vec![2], false), Queued::Dropped);
        assert_eq!(mailbox.publish_video(1, vec![3], true), Queued::Queued);
        assert_eq!(mailbox.publish_video(1, vec![4], false), Queued::Queued);
        assert_eq!(drain(&mut mailbox), vec![vec![3], vec![4]]);
    }

    #[test]
    fn retired_generations_take_no_video() {
        let mut mailbox = Mailbox::default();
        mailbox.activate(1);
        mailbox.publish_video(1, vec![0], true);
        mailbox.activate(2);
        assert_eq!(mailbox.publish_video(1, vec![1], true), Queued::Dropped);
        assert!(mailbox.take().is_none());
    }
}
