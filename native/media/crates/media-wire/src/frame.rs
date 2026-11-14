//! Pure MediaFrame v1 and egress codecs. Extensions and unknown flag bits are retained.
#[derive(Clone, Debug, PartialEq)]
pub struct MediaFrame {
    pub kind: u8,
    pub flags: u32,
    pub age_us: u32,
    pub width: u16,
    pub height: u16,
    pub display_width: u16,
    pub display_height: u16,
    pub scale: u16,
    pub rotation: u8,
    pub codec: u8,
    pub encode: u32,
    pub epoch: u32,
    pub codec_string: String,
    pub description: Vec<u8>,
    pub extension: Vec<u8>,
    pub payload: Vec<u8>,
}
#[derive(Debug, PartialEq)]
pub struct InvalidFrame;
impl MediaFrame {
    pub fn encode(&self) -> Result<Vec<u8>, InvalidFrame> {
        let h = 44 + self.codec_string.len() + self.description.len() + self.extension.len();
        if !(1..=5).contains(&self.kind)
            || self.rotation > 3
            || self.codec > 9
            || (self.codec == 0 && self.kind != 4 && self.kind != 5)
            || !self.codec_string.is_ascii()
            || h > 4096
            || self.payload.len() > 8 * 1024 * 1024
            || (self.kind == 5 && self.payload.len() != 32)
        {
            return Err(InvalidFrame);
        }
        let mut b = Vec::with_capacity(h + self.payload.len());
        b.extend_from_slice(b"ACEM");
        b.extend_from_slice(&[1, self.kind]);
        b.extend_from_slice(&(h as u16).to_be_bytes());
        b.extend_from_slice(&(self.payload.len() as u32).to_be_bytes());
        for n in [self.flags, self.age_us] {
            b.extend_from_slice(&n.to_be_bytes());
        }
        for n in [
            self.width,
            self.height,
            self.display_width,
            self.display_height,
            self.scale,
        ] {
            b.extend_from_slice(&n.to_be_bytes());
        }
        b.extend_from_slice(&[self.rotation, self.codec]);
        for n in [self.encode, self.epoch] {
            b.extend_from_slice(&n.to_be_bytes());
        }
        b.extend_from_slice(&(self.codec_string.len() as u16).to_be_bytes());
        b.extend_from_slice(&(self.description.len() as u16).to_be_bytes());
        b.extend_from_slice(self.codec_string.as_bytes());
        b.extend_from_slice(&self.description);
        b.extend_from_slice(&self.extension);
        b.extend_from_slice(&self.payload);
        Ok(b)
    }
    pub fn decode(b: &[u8]) -> Result<Self, InvalidFrame> {
        if b.len() < 44 || &b[..4] != b"ACEM" || b[4] != 1 {
            return Err(InvalidFrame);
        }
        let u16_at = |i| u16::from_be_bytes([b[i], b[i + 1]]);
        let u32_at = |i| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let h = usize::from(u16_at(6));
        let p = u32_at(8) as usize;
        let c = usize::from(u16_at(40));
        let d = usize::from(u16_at(42));
        if !(44..=4096).contains(&h) || p > 8 * 1024 * 1024 || h + p != b.len() || 44 + c + d > h {
            return Err(InvalidFrame);
        }
        let frame = Self {
            kind: b[5],
            flags: u32_at(12),
            age_us: u32_at(16),
            width: u16_at(20),
            height: u16_at(22),
            display_width: u16_at(24),
            display_height: u16_at(26),
            scale: u16_at(28),
            rotation: b[30],
            codec: b[31],
            encode: u32_at(32),
            epoch: u32_at(36),
            codec_string: String::from_utf8(b[44..44 + c].to_vec()).map_err(|_| InvalidFrame)?,
            description: b[44 + c..44 + c + d].to_vec(),
            extension: b[44 + c + d..h].to_vec(),
            payload: b[h..].to_vec(),
        };
        // Validate without duplicating the contract; no I/O occurs here.
        if !(1..=5).contains(&frame.kind)
            || frame.rotation > 3
            || frame.codec > 9
            || (frame.codec == 0 && frame.kind != 4 && frame.kind != 5)
            || !frame.codec_string.is_ascii()
            || (frame.kind == 5 && p != 32)
        {
            return Err(InvalidFrame);
        }
        Ok(frame)
    }
}
/// One egress frame: the 12-byte header (magic, source handle, sequence), then the frame.
pub fn encode_egress(
    handle: u32,
    sequence: u32,
    frame: &MediaFrame,
) -> Result<Vec<u8>, InvalidFrame> {
    let mut b = b"ACEE".to_vec();
    b.extend_from_slice(&handle.to_be_bytes());
    b.extend_from_slice(&sequence.to_be_bytes());
    b.extend(frame.encode()?);
    Ok(b)
}
#[derive(Clone, Debug, PartialEq)]
pub struct Egress {
    pub handle: u32,
    pub sequence: u32,
    pub frame: MediaFrame,
}
impl Egress {
    pub fn encode(&self) -> Result<Vec<u8>, InvalidFrame> {
        encode_egress(self.handle, self.sequence, &self.frame)
    }
    pub fn decode(b: &[u8]) -> Result<Self, InvalidFrame> {
        if b.len() < 56 || &b[..4] != b"ACEE" {
            return Err(InvalidFrame);
        }
        Ok(Self {
            handle: u32::from_be_bytes([b[4], b[5], b[6], b[7]]),
            sequence: u32::from_be_bytes([b[8], b[9], b[10], b[11]]),
            frame: MediaFrame::decode(&b[12..])?,
        })
    }
}
