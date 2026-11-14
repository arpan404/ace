//! Fixed key hand-over block. Keys deliberately have no Debug or serde implementations.
use zeroize::Zeroizing;
pub struct KeyBlock {
    pub send_key: Zeroizing<[u8; 32]>,
    pub receive_key: Zeroizing<[u8; 32]>,
    pub send_nonce: u64,
    pub receive_nonce: u64,
    pub frames_sent: u64,
    pub frames_received: u64,
    pub flags: u8,
    pub window: u32,
    pub unacked: u32,
    pub owed: u32,
    pub uncounted: u32,
}
#[derive(Debug, PartialEq)]
pub struct InvalidKeyBlock;
pub fn crc32c(bytes: &[u8]) -> u32 {
    let mut crc = !0u32;
    for b in bytes {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            crc = (crc >> 1) ^ if crc & 1 != 0 { 0x82f63b78 } else { 0 };
        }
    }
    !crc
}
impl KeyBlock {
    pub fn decode(b: &[u8]) -> Result<Self, InvalidKeyBlock> {
        if b.len() != 120 || b[96] > 3 || b[97..100] != [0, 0, 0] {
            return Err(InvalidKeyBlock);
        }
        let u32_at = |i| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let u64_at = |i| {
            u64::from_be_bytes([
                b[i],
                b[i + 1],
                b[i + 2],
                b[i + 3],
                b[i + 4],
                b[i + 5],
                b[i + 6],
                b[i + 7],
            ])
        };
        if crc32c(&b[..116]) != u32_at(116) {
            return Err(InvalidKeyBlock);
        }
        let mut send_key = Zeroizing::new([0; 32]);
        send_key.copy_from_slice(&b[..32]);
        let mut receive_key = Zeroizing::new([0; 32]);
        receive_key.copy_from_slice(&b[32..64]);
        Ok(Self {
            send_key,
            receive_key,
            send_nonce: u64_at(64),
            receive_nonce: u64_at(72),
            frames_sent: u64_at(80),
            frames_received: u64_at(88),
            flags: b[96],
            window: u32_at(100),
            unacked: u32_at(104),
            owed: u32_at(108),
            uncounted: u32_at(112),
        })
    }
    pub fn encode(&self) -> Result<Zeroizing<[u8; 120]>, InvalidKeyBlock> {
        if self.flags > 3 {
            return Err(InvalidKeyBlock);
        }
        let mut b = Zeroizing::new([0; 120]);
        b[..32].copy_from_slice(self.send_key.as_ref());
        b[32..64].copy_from_slice(self.receive_key.as_ref());
        for (i, n) in [
            self.send_nonce,
            self.receive_nonce,
            self.frames_sent,
            self.frames_received,
        ]
        .iter()
        .enumerate()
        {
            b[64 + i * 8..72 + i * 8].copy_from_slice(&n.to_be_bytes());
        }
        b[96] = self.flags;
        for (i, n) in [self.window, self.unacked, self.owed, self.uncounted]
            .iter()
            .enumerate()
        {
            b[100 + i * 4..104 + i * 4].copy_from_slice(&n.to_be_bytes());
        }
        let crc = crc32c(&b[..116]);
        b[116..].copy_from_slice(&crc.to_be_bytes());
        Ok(b)
    }
}
