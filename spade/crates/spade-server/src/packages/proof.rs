//! What proves a step to a market version (ADR 0200 §3.2) when it is taken, and taken again: the
//! market's signed manifest over the `bot.json` it reads as the step's manifest. A step the API
//! proved carries its proof wherever it waits (held while the bot works, written down before a
//! crash), and is taken only on it; one recorded with none (by a build before proofs) or with
//! one that no longer verifies waits for the person to accept the version again. A local
//! package's identity claims nothing, so needs no proof.

use serde_json::Value;
use spade_core::package::Manifest;
use spade_core::package::link::PackageId;

use super::envelope::{self, Envelope};
use crate::engine::Engine;

/// Why nothing proves a step to `package` with `manifest`, if nothing does.
pub fn unproven(
    engine: &Engine,
    package: &PackageId,
    manifest: &Manifest,
    proof: Option<&Value>,
) -> Option<String> {
    if envelope::is_local(package) {
        return None;
    }
    let Some(proof) = proof else {
        return Some("nothing proves this version is the market's; accept it again".to_owned());
    };
    let Ok(sealed) = serde_json::from_value::<Envelope>(proof.clone()) else {
        return Some("its proof doesn't read".to_owned());
    };
    let (proven, recipe) = match envelope::verify(&sealed, &engine.market_keys()) {
        Ok(proven) => proven,
        Err(why) => return Some(format!("its proof doesn't hold: {why}")),
    };
    if (&proven.name, &proven.version, &proven.hash)
        != (&package.name, &package.version, &package.hash)
    {
        return Some("its proof is for another version".to_owned());
    }
    match super::manifest(&recipe) {
        Ok(read) if read == *manifest => None,
        _ => Some("its manifest isn't the one the market signed".to_owned()),
    }
}

/// `sealed` as a step keeps it.
pub fn kept(sealed: &Envelope) -> Option<Value> {
    serde_json::to_value(sealed).ok()
}
