/// Retirement is logical for the in-flight packet: finish its bytes intact, then receivers
/// reject its generation. Never cancel a partial packet on a shared byte stream.
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
    pub fn take(&mut self) -> Option<Packet> {
        self.pending.take()
    }
}
