use crate::{
    codec::{jpeg, packet, Header},
    coordinates::Bounds,
    errors::{Code, Error, Result},
    tiles::Tiles,
};
/// Caller supplies event time. A denied pacing slot never updates hashes, so a final change survives.
pub struct Stream {
    tiles: Tiles,
    next_ms: f64,
    fps: u32,
    seq: u64,
    session: String,
    version: u8,
    generation: u64,
    metadata: Option<(u32, u32, f64)>,
}
impl Stream {
    pub fn new(session: String, version: u8, fps: u32) -> Self {
        Self {
            tiles: Tiles::default(),
            next_ms: 0.0,
            fps: fps.clamp(1, 30),
            seq: 0,
            session,
            version,
            generation: 1,
            metadata: None,
        }
    }
    pub fn generation(&mut self, generation: u64) {
        self.generation = generation;
        self.refresh();
    }
    pub fn capture_generation(&self) -> u64 {
        self.generation
    }
    pub fn refresh(&mut self) {
        self.tiles = Tiles::default();
        self.next_ms = 0.0;
        self.metadata = None;
    }
    pub fn due_in(&self, now_ms: f64) -> f64 {
        (self.next_ms - now_ms).max(0.0)
    }
    pub fn frame(
        &mut self,
        rgb: &[u8],
        width: u32,
        height: u32,
        scale: f64,
        now_ms: f64,
    ) -> Result<Option<Vec<u8>>> {
        if now_ms < self.next_ms {
            return Ok(None);
        }
        if !scale.is_finite() || scale <= 0.0 {
            return Err(Error::new(Code::Bounds, "Invalid scale"));
        }
        let mut dirty = self.tiles.changed(rgb, width, height)?;
        let metadata = (width, height, scale);
        if self.metadata != Some(metadata) && dirty.is_empty() {
            dirty.push(Bounds {
                x: 0.0,
                y: 0.0,
                w: width as f64,
                h: height as f64,
            });
        }
        if dirty.is_empty() {
            // Bound duplicate-event hashing to requested fps as well as encoded frames.
            self.next_ms = now_ms + 1000.0 / self.fps as f64;
            return Ok(None);
        }
        let payload = jpeg(rgb, width, height)?;
        let header = Header {
            version: self.version,
            session_id: self.session.clone(),
            seq: self.seq,
            capture_generation: (self.version == 2).then_some(self.generation),
            ts: now_ms,
            width,
            height,
            scale,
            codec: "jpeg".into(),
            bytes: payload.len(),
            dirty_rects: Some(dirty),
        };
        let bytes = packet(&header, &payload)?;
        self.metadata = Some(metadata);
        self.seq += 1;
        self.next_ms = now_ms + 1000.0 / self.fps as f64;
        Ok(Some(bytes))
    }
}
