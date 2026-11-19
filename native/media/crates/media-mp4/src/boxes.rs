// SPDX-License-Identifier: Apache-2.0

// ISO/IEC 14496-12: sizes include the header; full boxes add version and flags.
pub(crate) struct Boxes(pub Vec<u8>);
impl Boxes {
    pub fn new(capacity: usize) -> Self {
        Self(Vec::with_capacity(capacity))
    }
    pub fn bytes(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }
    pub fn zeros(&mut self, n: usize) {
        self.0.resize(self.0.len() + n, 0);
    }
    pub fn u16(&mut self, n: u16) {
        self.bytes(&n.to_be_bytes());
    }
    pub fn u32(&mut self, n: u32) {
        self.bytes(&n.to_be_bytes());
    }
    pub fn u64(&mut self, n: u64) {
        self.bytes(&n.to_be_bytes());
    }
    pub fn patch(&mut self, at: usize, n: u32) {
        self.0[at..at + 4].copy_from_slice(&n.to_be_bytes());
    }
    pub fn boxed(&mut self, kind: &[u8; 4], f: impl FnOnce(&mut Self)) {
        let at = self.0.len();
        self.u32(0);
        self.bytes(kind);
        f(self);
        self.patch(at, (self.0.len() - at) as u32);
    }
    pub fn full(&mut self, kind: &[u8; 4], version: u8, flags: u32, f: impl FnOnce(&mut Self)) {
        self.boxed(kind, |b| {
            b.u32((u32::from(version) << 24) | flags);
            f(b);
        });
    }
    pub fn matrix(&mut self) {
        for n in [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000] {
            self.u32(n);
        }
    }
}
