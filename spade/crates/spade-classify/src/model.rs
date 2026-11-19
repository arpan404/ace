//! The model: one int8 row of class weights per feature bucket, a scale and a bias per class, a
//! temperature that calibrates its probabilities and the two thresholds it acts above. The file
//! is little-endian:
//!
//! ```text
//! "SPCM" | version u32 | buckets u32 | classes u32 | temperature f32 | low f32 | person f32
//! | read f32 | scale f32 × classes | bias f32 × classes | weight i8 × buckets × classes
//! | known bits (KNOWN_BITS / 8 bytes)
//! ```
//!
//! The known bits are a Bloom filter of the programs, subcommands and flags seen in low-risk
//! training commands: a command with any other part is never settled.
//!
//! Inference is a sparse sum, so its cost follows the call's features, not the model's size, and
//! the same input always gives the same bits.

use std::borrow::Cow;

use crate::CLASSES;
use crate::hash::{BUCKETS, KNOWN_BITS, probes};

const MAGIC: &[u8; 4] = b"SPCM";
/// 3: the person threshold is over the sum of the person-only effects, and a read threshold.
const VERSION: u32 = 3;
const C: usize = CLASSES.len();
const HEADER: usize = 4 + 4 * 7 + 8 * C;

/// A model file that can't be used: the classifier then abstains on everything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Invalid(pub &'static str);

/// What a model file holds, apart from its weights.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Header {
    /// Logits are divided by it before the softmax (temperature scaling).
    pub temperature: f32,
    /// The probability of a low-risk effect (`read` or `write_local`) at or above which a call
    /// may be settled as low-risk.
    pub low: f32,
    /// The probability of a person-only effect (any of them, summed) at or above which a call goes
    /// to the person.
    pub person: f32,
    /// The probability of `read` at or above which a plain command may be settled while untrusted
    /// content is in view: above every validation call that isn't a read.
    pub read: f32,
    pub scales: [f32; C],
    pub bias: [f32; C],
}

pub struct Model {
    header: Header,
    weights: Cow<'static, [u8]>,
    id: String,
}

impl std::fmt::Debug for Model {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Model")
            .field("id", &self.id)
            .field("header", &self.header)
            .finish_non_exhaustive()
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    let word: [u8; 4] = bytes.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(word))
}

fn f32_at(bytes: &[u8], at: usize) -> Option<f32> {
    u32_at(bytes, at).map(f32::from_bits)
}

impl Model {
    /// Reads a model file.
    pub fn parse(bytes: Cow<'static, [u8]>) -> Result<Self, Invalid> {
        if bytes.get(..4) != Some(MAGIC.as_slice()) {
            return Err(Invalid("not a model file"));
        }
        let word = |at| u32_at(&bytes, at).ok_or(Invalid("cut short"));
        let real = |at| f32_at(&bytes, at).ok_or(Invalid("cut short"));
        if word(4)? != VERSION {
            return Err(Invalid("a version this build doesn't read"));
        }
        if word(8)? as usize != BUCKETS || word(12)? as usize != C {
            return Err(Invalid("a shape this build doesn't read"));
        }
        let mut scales = [0.0; C];
        let mut bias = [0.0; C];
        for c in 0..C {
            scales[c] = real(32 + 4 * c)?;
            bias[c] = real(32 + 4 * C + 4 * c)?;
        }
        let header = Header {
            temperature: real(16)?,
            low: real(20)?,
            person: real(24)?,
            read: real(28)?,
            scales,
            bias,
        };
        let finite = [header.temperature, header.low, header.person, header.read]
            .iter()
            .chain(&scales)
            .chain(&bias)
            .all(|x| x.is_finite());
        if !finite || header.temperature <= 0.0 {
            return Err(Invalid("a value that isn't a number"));
        }
        if bytes.len() != HEADER + BUCKETS * C + KNOWN_BITS / 8 {
            return Err(Invalid("the wrong length"));
        }
        let id = format!("spade-classify/{:08x}", fingerprint(&bytes));
        Ok(Self {
            header,
            weights: bytes,
            id,
        })
    }

    /// The model's name in logs and stored verdicts: `spade-classify/` and a hash of its file.
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn header(&self) -> &Header {
        &self.header
    }

    /// The raw class scores of a sparse feature vector.
    pub fn logits(&self, features: &[(u32, f32)]) -> [f32; C] {
        let mut sums = [0.0f32; C];
        for &(row, weight) in features {
            let at = HEADER + row as usize * C;
            let Some(cells) = self.weights.get(at..at + C) else {
                continue;
            };
            for (sum, cell) in sums.iter_mut().zip(cells) {
                *sum += weight * f32::from(*cell as i8);
            }
        }
        let mut logits = [0.0f32; C];
        for c in 0..C {
            logits[c] = self.header.bias[c] + self.header.scales[c] * sums[c];
        }
        logits
    }

    /// Whether every key was in a low-risk training command (none: not known).
    pub fn knows(&self, keys: &[u64]) -> bool {
        let start = HEADER + BUCKETS * C;
        let bit = |at: usize| {
            self.weights
                .get(start + at / 8)
                .is_some_and(|byte| byte & (1 << (at % 8)) != 0)
        };
        !keys.is_empty()
            && keys
                .iter()
                .all(|key| probes(*key).iter().all(|at| bit(*at)))
    }

    /// The calibrated probabilities of a sparse feature vector.
    pub fn probabilities(&self, features: &[(u32, f32)]) -> [f32; C] {
        softmax(self.logits(features), self.header.temperature)
    }
}

/// Softmax of `logits / temperature`.
pub fn softmax(logits: [f32; C], temperature: f32) -> [f32; C] {
    let scaled = logits.map(|l| l / temperature);
    let top = scaled.iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let exp = scaled.map(|l| crate::math::exp(l - top));
    let total: f32 = exp.iter().sum();
    exp.map(|e| e / total)
}

fn fingerprint(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for b in bytes {
        h ^= u32::from(*b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Float weights (`BUCKETS × classes`, row-major) as int8 with one scale per class: each
/// class's largest weight maps to ±127.
pub fn quantize(weights: &[f32]) -> (Vec<i8>, [f32; C]) {
    let mut scales = [0.0f32; C];
    let rows = weights.as_chunks::<C>().0;
    for row in rows {
        for (scale, w) in scales.iter_mut().zip(row) {
            *scale = scale.max(w.abs());
        }
    }
    let scales = scales.map(|s| if s > 0.0 { s / 127.0 } else { 1.0 });
    let quantized = rows
        .iter()
        .flat_map(|row| {
            row.iter()
                .zip(scales)
                .map(|(w, s)| (w / s).round().clamp(-127.0, 127.0) as i8)
        })
        .collect();
    (quantized, scales)
}

/// The known set of `keys`, as the model file stores it.
pub fn known_bits(keys: impl IntoIterator<Item = u64>) -> Vec<u8> {
    let mut bits = vec![0u8; KNOWN_BITS / 8];
    for key in keys {
        for at in probes(key) {
            bits[at / 8] |= 1 << (at % 8);
        }
    }
    bits
}

/// A model file.
pub fn encode(header: &Header, weights: &[i8], known: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER + weights.len() + known.len());
    out.extend_from_slice(MAGIC);
    for word in [VERSION, BUCKETS as u32, C as u32] {
        out.extend_from_slice(&word.to_le_bytes());
    }
    for real in [header.temperature, header.low, header.person, header.read] {
        out.extend_from_slice(&real.to_le_bytes());
    }
    for real in header.scales.iter().chain(&header.bias) {
        out.extend_from_slice(&real.to_le_bytes());
    }
    out.extend(weights.iter().map(|w| *w as u8));
    out.extend_from_slice(known);
    out
}
