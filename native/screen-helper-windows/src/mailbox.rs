//! What waits for the daemon's pipe: stills, latest-only, one pending packet replaced by a newer
//! one. Video never goes this way; it goes to ace-media's ingest. Retirement is logical for the
//! in-flight packet: its bytes finish intact, then receivers reject its generation. A partial
//! packet is never cancelled on the shared byte stream.

#[derive(Default)]
pub struct Mailbox {
    active: Option<u64>,
    pending: Option<Packet>,
}
pub struct Packet {
    pub generation: u64,
    pub bytes: Vec<u8>,
}
impl Mailbox {
    pub fn activate(&mut self, generation: u64) {
        self.retire();
        self.active = Some(generation);
    }
    pub fn retire(&mut self) {
        self.active = None;
        self.pending = None;
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
    /// The next packet to write: the newest still.
    pub fn take(&mut self) -> Option<Packet> {
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
    fn stills_keep_only_the_newest() {
        let mut mailbox = Mailbox::default();
        mailbox.activate(1);
        assert!(mailbox.publish(1, vec![100]));
        assert!(mailbox.publish(1, vec![101]));
        assert_eq!(drain(&mut mailbox), vec![vec![101]]);
    }

    #[test]
    fn retired_generations_take_no_still() {
        let mut mailbox = Mailbox::default();
        mailbox.activate(1);
        mailbox.publish(1, vec![0]);
        mailbox.activate(2);
        assert!(!mailbox.publish(1, vec![1]));
        assert!(mailbox.take().is_none());
    }
}
