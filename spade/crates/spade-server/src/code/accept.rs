//! The components sent with an install, an update or a rollback (ADR 0203 §5), checked and kept
//! before the step is taken: each the manifest names must be sent, as base64 by its path; its
//! bytes must pass Spade's own check against the manifest's entry; a market version's must be
//! exactly the bytes its signed manifest lists. Kept by sha256, they become the step's pins.
//! Bytes nothing names are ignored.

use std::collections::BTreeMap;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use spade_core::package::Manifest;
use spade_core::package::code;

use super::Code;
use crate::packages::envelope::{self, Envelope};

/// The pins of the components `manifest` names, their bytes kept in `store`; or why the step is
/// refused. A manifest with no code needs no store.
pub fn accepted(
    manifest: &Manifest,
    sent: &BTreeMap<String, String>,
    sealed: Option<&Envelope>,
    store: Option<&Code>,
) -> Result<BTreeMap<String, String>, String> {
    if manifest.code.is_empty() {
        return Ok(BTreeMap::new());
    }
    let Some(store) = store else {
        return Err("this Spade can't run a package's code".to_owned());
    };
    let mut pins = BTreeMap::new();
    for entry in &manifest.code {
        let Some(text) = sent.get(&entry.file) else {
            return Err(format!(
                "{} is named in code but wasn't sent with the manifest",
                entry.file
            ));
        };
        // Base64 of 8 MiB is under 11 MiB: anything longer is refused before it is decoded.
        if text.len() > code::MOST_BYTES / 3 * 4 + 8 {
            return Err(format!("{} is larger than 8 MiB", entry.file));
        }
        let bytes = STANDARD
            .decode(text.trim())
            .map_err(|_| format!("{} wasn't sent as base64", entry.file))?;
        if let Some(sealed) = sealed
            && !envelope::lists_bytes(sealed, &entry.file, &bytes)
        {
            return Err(format!("{} isn't the one the market signed", entry.file));
        }
        code::check(entry, &bytes).map_err(|problems| spade_core::rule::joined(&problems, "; "))?;
        pins.insert(entry.name.clone(), store.keep(&bytes)?);
    }
    Ok(pins)
}
