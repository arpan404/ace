//! The fixed-size feature space: every feature is a namespace and a few words, hashed (FNV-1a,
//! then a final mix) to one of [`BUCKETS`] rows. Nothing is looked up in a vocabulary, so a word
//! the model never saw still lands somewhere, and the same words always land on the same row.

/// Rows in the feature space.
pub const BUCKETS: usize = 1 << 17;

const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const PRIME: u64 = 0x0000_0100_0000_01b3;

fn mix(mut h: u64) -> u32 {
    h ^= h >> 33;
    h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
    h ^= h >> 33;
    (h as usize & (BUCKETS - 1)) as u32
}

fn hash(space: &str, parts: &[&str]) -> u64 {
    let mut h = feed(OFFSET, space.as_bytes());
    for part in parts {
        h = feed(h, &[0x1f]);
        h = feed(h, part.as_bytes());
    }
    h
}

/// Bits in the set of what the model knows as low-risk.
pub const KNOWN_BITS: usize = 1 << 20;

/// The two bits a key sets in the known set (a Bloom filter: a key never added reads as known
/// only when both of its bits were set by others).
pub fn probes(key: u64) -> [usize; 2] {
    let a = key ^ (key >> 31);
    let b = key.wrapping_mul(0x9e37_79b9_7f4a_7c15);
    [
        (a as usize) & (KNOWN_BITS - 1),
        ((b >> 40) as usize) & (KNOWN_BITS - 1),
    ]
}

fn feed(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(PRIME);
    }
    h
}

/// The features of one call as they are gathered: named features (each counts once) and
/// character n-grams (weighted together so a long text doesn't drown the rest).
#[derive(Debug, Default)]
pub(crate) struct Bag {
    named: Vec<u32>,
    grams: Vec<u32>,
    /// Full hashes of the parts that say what a command is (its programs, subcommands and
    /// flags), checked against what the model knows as low-risk.
    keys: Vec<u64>,
}

/// How much all of a call's n-grams weigh together, against 1 for each named feature.
const GRAMS_WEIGHT: f32 = 4.0;

impl Bag {
    /// A feature `space:part1␟part2…`.
    pub fn add(&mut self, space: &str, parts: &[&str]) {
        self.named.push(mix(hash(space, parts)));
    }

    /// A feature that is also a key part of what the call is.
    pub fn key(&mut self, space: &str, parts: &[&str]) {
        let h = hash(space, parts);
        self.named.push(mix(h));
        self.keys.push(h);
    }

    /// Character 3- and 4-grams of `text` (already squeezed).
    pub fn grams(&mut self, space: &str, text: &[u8]) {
        let seed = feed(OFFSET, space.as_bytes());
        for n in [3usize, 4] {
            for window in text.windows(n) {
                let h = feed(feed(seed, &[n as u8]), window);
                self.grams.push(mix(h));
            }
        }
    }

    /// The sparse vector: rows sorted, each named feature once with weight 1, the n-grams
    /// sharing [`GRAMS_WEIGHT`] by the square root of how many distinct ones there are.
    pub fn finish(mut self) -> (Vec<(u32, f32)>, Vec<u64>) {
        self.keys.sort_unstable();
        self.keys.dedup();
        let keys = std::mem::take(&mut self.keys);
        (self.vector(), keys)
    }

    fn vector(mut self) -> Vec<(u32, f32)> {
        self.named.sort_unstable();
        self.named.dedup();
        self.grams.sort_unstable();
        self.grams.dedup();
        let each = if self.grams.is_empty() {
            0.0
        } else {
            GRAMS_WEIGHT / (self.grams.len() as f32).sqrt()
        };
        let mut out: Vec<(u32, f32)> = Vec::with_capacity(self.named.len() + self.grams.len());
        let (mut i, mut j) = (0, 0);
        while i < self.named.len() || j < self.grams.len() {
            let named = self.named.get(i).copied();
            let gram = self.grams.get(j).copied();
            match (named, gram) {
                (Some(a), Some(b)) if a == b => {
                    out.push((a, 1.0 + each));
                    i += 1;
                    j += 1;
                }
                (Some(a), Some(b)) if a < b => {
                    out.push((a, 1.0));
                    i += 1;
                }
                (Some(a), None) => {
                    out.push((a, 1.0));
                    i += 1;
                }
                (_, Some(b)) => {
                    out.push((b, each));
                    j += 1;
                }
                (None, None) => break,
            }
        }
        out
    }
}
