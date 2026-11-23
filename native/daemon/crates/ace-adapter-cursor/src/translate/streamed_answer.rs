// SPDX-License-Identifier: Apache-2.0
//! The turn's last answer as it streamed (`streamed-answer.ts`): its length
//! and digests, never its text, so a recovered saved answer is matched
//! against what ace showed without holding that text again.
//!
//! Everything is counted in UTF-16 code units and hashed as UTF-16LE, as
//! Node's sha256 over `utf16le` does. A delta that ends mid surrogate pair
//! cannot occur here: every text this crate sees parsed as JSON, and JSON
//! with a lone surrogate never parses, so pairs are always whole.

use sha2::{Digest, Sha256};

/// The recovered answer is cut after this many UTF-8 bytes.
const CAP: usize = 4 * 1024 * 1024;

fn is_high(code: u16) -> bool {
    (0xd800..0xdc00).contains(&code)
}

fn is_low(code: u16) -> bool {
    (0xdc00..0xe000).contains(&code)
}

fn width(code: u16) -> usize {
    if code < 0x80 {
        1
    } else if code < 0x800 {
        2
    } else {
        3
    }
}

fn le_bytes(units: &[u16], out: &mut Vec<u8>) {
    for unit in units {
        out.extend_from_slice(&unit.to_le_bytes());
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn digest_of(units: &[u16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(units.len() * 2);
    le_bytes(units, &mut bytes);
    Sha256::digest(&bytes).to_vec()
}

/// The digest of the streamed answer and of the start that fits in 4 MiB.
pub struct StreamedAnswer {
    length: usize,
    hash: Sha256,
    capped: Sha256,
    capped_units: usize,
    capped_bytes: usize,
    full: bool,
    held: Vec<u16>,
}

impl StreamedAnswer {
    pub fn new() -> Self {
        StreamedAnswer {
            length: 0,
            hash: Sha256::new(),
            capped: Sha256::new(),
            capped_units: 0,
            capped_bytes: 0,
            full: false,
            held: Vec::new(),
        }
    }

    pub fn reset(&mut self) {
        *self = StreamedAnswer::new();
    }

    pub fn add(&mut self, text: &str) {
        let units: Vec<u16> = text.encode_utf16().collect();
        self.length += units.len();
        let mut bytes = Vec::with_capacity(units.len() * 2);
        le_bytes(&units, &mut bytes);
        self.hash.update(&bytes);
        if !self.full {
            self.fit(&units);
        }
    }

    /// Takes in what of `units` still fits in 4 MiB, a whole character at a time.
    fn fit(&mut self, units: &[u16]) {
        let mut at = 0;
        // A high surrogate that ended the last delta pairs with a low one
        // starting this one. JSON text never holds a lone surrogate, so this
        // only pairs whole characters split across deltas.
        if !self.held.is_empty() {
            let pairs = !units.is_empty() && is_low(units[0]);
            if pairs {
                let mut combined = std::mem::take(&mut self.held);
                combined.push(units[0]);
                if !self.take(&combined, 4) {
                    self.held = combined;
                    self.held.pop();
                    return;
                }
                at = 1;
            } else {
                if units.is_empty() {
                    return;
                }
                let held = std::mem::take(&mut self.held);
                if !self.take(&held, 3) {
                    self.held = held;
                    return;
                }
            }
        }
        let from = at;
        let mut bytes = self.capped_bytes;
        while at < units.len() {
            let code = units[at];
            if is_high(code) && at + 1 == units.len() {
                break;
            }
            let pair = is_high(code) && at + 1 < units.len() && is_low(units[at + 1]);
            let size = if pair { 4 } else { width(code) };
            if bytes + size > CAP {
                self.full = true;
                break;
            }
            bytes += size;
            at += if pair { 2 } else { 1 };
        }
        let mut taken = Vec::with_capacity((at - from) * 2);
        le_bytes(&units[from..at], &mut taken);
        self.capped.update(&taken);
        self.capped_units += at - from;
        self.capped_bytes = bytes;
        if !self.full && at < units.len() {
            self.held = units[at..].to_vec();
        }
    }

    /// Takes in one character of `size` bytes if it fits; false once it doesn't.
    fn take(&mut self, units: &[u16], size: usize) -> bool {
        if self.capped_bytes + size > CAP {
            self.full = true;
            return false;
        }
        let mut bytes = Vec::with_capacity(units.len() * 2);
        le_bytes(units, &mut bytes);
        self.capped.update(&bytes);
        self.capped_units += units.len();
        self.capped_bytes += size;
        true
    }

    /// The start that fits in 4 MiB, a held high surrogate counted as the lone one it is.
    fn cut(&self) -> (usize, String) {
        let mut digest = self.capped.clone();
        if !self.held.is_empty() && !self.full && self.capped_bytes + 3 <= CAP {
            let mut bytes = Vec::with_capacity(self.held.len() * 2);
            le_bytes(&self.held, &mut bytes);
            digest.update(&bytes);
            let units = self.capped_units + self.held.len();
            return (units, hex_bytes(&digest.finalize()));
        }
        (self.capped_units, hex_bytes(&digest.finalize()))
    }

    /// What of `result` was never shown: the rest of it when what streamed is
    /// its start, all of it (`apart`) when what streamed differs, nothing when
    /// it is all shown. A saved answer recovery cut (`cut`) is shown already
    /// only when it is exactly the start of what streamed that fits in 4 MiB.
    pub fn missing(&self, result: &str, cut: bool) -> Option<Missing> {
        let units: Vec<u16> = result.encode_utf16().collect();
        if self.length > units.len() {
            if !cut {
                return Some(Missing {
                    text: result.to_owned(),
                    apart: true,
                });
            }
            let (start_units, start_digest) = self.cut();
            let hex = hex_bytes(&digest_of(&units));
            return if start_units == units.len() && start_digest == hex {
                None
            } else {
                Some(Missing {
                    text: result.to_owned(),
                    apart: true,
                })
            };
        }
        if hex_bytes(&digest_of(&units[..self.length])) != hex_bytes(&self.hash.clone().finalize())
        {
            return Some(Missing {
                text: result.to_owned(),
                apart: true,
            });
        }
        if self.length == units.len() {
            None
        } else {
            let rest = String::from_utf16_lossy(&units[self.length..]);
            Some(Missing {
                text: rest,
                apart: false,
            })
        }
    }
}

/// The unsliced saved answer when it differs, or its unshown tail.
pub struct Missing {
    pub text: String,
    pub apart: bool,
}
