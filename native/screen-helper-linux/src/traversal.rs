//! Pure traversal accounting shared by tree construction and tests.
use crate::protocol::{Fault, Result};
pub struct Budget {
    remaining: usize,
    bytes: usize,
    pub max_depth: usize,
    pub truncated: bool,
}
impl Budget {
    pub fn new(depth: usize, nodes: usize) -> Result<Self> {
        if depth > 32 || nodes == 0 || nodes > 512 {
            return Err(Fault::new("bounds", "Tree caps: depth <=32, nodes 1..512"));
        }
        Ok(Self {
            remaining: nodes,
            bytes: 60 * 1024,
            max_depth: depth,
            truncated: false,
        })
    }
    pub fn admit(&mut self, bytes: usize) -> bool {
        if self.remaining == 0 || bytes > self.bytes {
            self.truncated = true;
            return false;
        }
        self.remaining -= 1;
        self.bytes -= bytes;
        true
    }
    pub fn descend(&mut self, depth: usize, children: usize) -> bool {
        if children == 0 {
            return false;
        }
        if depth >= self.max_depth || self.remaining == 0 || self.bytes < 256 {
            self.truncated = true;
            return false;
        }
        true
    }
}
