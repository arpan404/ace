//! Keeping the evaluation sets disjoint from the fit set (ADR 0172, amendment 6). Two calls the
//! classifier folds to the same features are the same call to it, however their text differs (a
//! disguised tool name folds back, `pwd` is `pwd`). So an example is held out only when its folded
//! signature appears in no fit example. This reserves the signature before variants are generated:
//! a test or hand-labelled call that collides with a fit call is dropped, the count is reported,
//! and a corpus-wide check fails the build if any overlap remains.

use std::collections::HashSet;

use spade_classify::{Features, Subject, features};

/// A model-level signature of a call: everything the model sees, so two calls with the same
/// signature are indistinguishable to it. Folding, hashing and the eligibility flags are all
/// baked into [`Features`], so hashing it is enough.
pub fn signature(f: &Features) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |x: u64| {
        h ^= x;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    };
    let mut vector = f.vector.clone();
    vector.sort_by_key(|(row, _)| *row);
    for (row, weight) in &vector {
        feed(u64::from(*row));
        feed(u64::from(weight.to_bits()));
    }
    let mut keys = f.keys.clone();
    keys.sort_unstable();
    for key in &keys {
        feed(*key);
    }
    feed(u64::from(f.reaches_outside));
    feed(u64::from(f.hides) << 1);
    feed(u64::from(f.dropped) << 2);
    feed(u64::from(f.network) << 3);
    feed(u64::from(f.hardened) << 4);
    h
}

/// The signature of a shell command, as the classifier would see it in the bot's folder.
pub fn command_signature(command: &str, workspace: Option<&str>) -> u64 {
    signature(&features(&Subject::Shell { command, workspace }))
}

/// The set of signatures of the fit calls: every evaluation call with one of these is not
/// held out and is dropped.
pub struct Fit(HashSet<u64>);

impl Fit {
    pub fn new(signatures: impl IntoIterator<Item = u64>) -> Self {
        Self(signatures.into_iter().collect())
    }

    pub fn has(&self, signature: u64) -> bool {
        self.0.contains(&signature)
    }
}
