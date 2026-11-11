//! Where presets come from (ADR 0126). They are always the catalogue built into this binary, so an
//! upgrade sees new shipped facts at once. Spade used to copy that file into the data folder and
//! read the copy ever after, which froze it at the version first installed; a copy left there is
//! adopted once into the person's endpoints when someone edited it, then moved aside.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};
use spade_models::{Catalog, CatalogError};

use crate::home::DEFAULT_MODELS;

/// The name the old copy had in the data folder.
pub const LEFTOVER: &str = "models.json";
/// Where an old copy is moved once read, so nobody edits it expecting an effect.
pub const SET_ASIDE: &str = "models.json.old";

/// SHA-256 of every `config/models.json` an earlier Spade shipped. A copy equal to one of these
/// (or to the current one) holds nothing of the person's own.
const SHIPPED: [&str; 4] = [
    "180ad59b1946503e8a412cc0adde2cbd53f584b598c794ce094727af169d0c89",
    "37376f1d2995eec2c68a93cbf4e4fd471de3ca8d2c1cba3d880612b5c7adc54b",
    "3cb2cd56aeafd5a598146f692e42cf8e4d5f5437de0de68b0605f370b1d37a29",
    "80616f4192b2143f59572a77f3cb0a7382fa6f8f1648adfa25fa20cc7d4058cc",
];

/// Earlier shipped files this build can still read, oldest first. An old copy's value that equals
/// one of these (or the current presets) is a shipped default, not the person's edit.
const READABLE_HISTORY: [&str; 1] = [include_str!("../shipped/models-2026-11-10.json")];

/// Every shipped catalogue this build can read: the earlier ones, then the current presets.
pub fn history() -> Vec<Catalog> {
    READABLE_HISTORY
        .iter()
        .chain(std::iter::once(&DEFAULT_MODELS))
        .filter_map(|text| Catalog::from_json(text).ok())
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The presets built into this binary.
pub fn shipped() -> Result<Catalog, CatalogError> {
    Catalog::from_json(DEFAULT_MODELS)
}

/// What a data folder's leftover copy holds.
#[derive(Debug)]
pub enum Leftover {
    /// No copy.
    None,
    /// A copy of a shipped file, unchanged: nothing to adopt.
    Shipped(PathBuf),
    /// The person's edited copy, to adopt into their endpoints.
    Edited(PathBuf, Catalog),
    /// A copy this build cannot read; it is left in place and ignored.
    Unreadable(PathBuf, String),
}

/// Looks at `<data dir>/models.json`, if there is one.
pub fn leftover(data_dir: &Path) -> Leftover {
    let path = data_dir.join(LEFTOVER);
    let Ok(bytes) = std::fs::read(&path) else {
        return Leftover::None;
    };
    let hash = sha256(&bytes);
    if hash == sha256(DEFAULT_MODELS.as_bytes()) || SHIPPED.contains(&hash.as_str()) {
        return Leftover::Shipped(path);
    }
    let text = String::from_utf8_lossy(&bytes);
    match Catalog::from_json(&text) {
        Ok(catalog) => Leftover::Edited(path, catalog),
        Err(error) => Leftover::Unreadable(path, error.problems.join("; ")),
    }
}

/// What Spade starts with: the presets (`override_path` replaces the built-in ones, for
/// development), an edited old copy to adopt, and the old copy to move aside once started.
pub struct Startup {
    pub presets: Catalog,
    pub adopt: Option<Catalog>,
    pub set_aside: Option<PathBuf>,
}

pub fn load(data_dir: &Path, override_path: Option<&Path>) -> Result<Startup, CatalogError> {
    let presets = match override_path {
        Some(path) => Catalog::load(path)?,
        None => shipped()?,
    };
    let (adopt, set_aside) = match leftover(data_dir) {
        Leftover::None => (None, None),
        Leftover::Shipped(path) => (None, Some(path)),
        Leftover::Edited(path, catalog) => (Some(catalog), Some(path)),
        Leftover::Unreadable(path, why) => {
            tracing::warn!(path = %path.display(), %why, "ignoring an old models.json this Spade cannot read");
            (None, None)
        }
    };
    Ok(Startup {
        presets,
        adopt,
        set_aside,
    })
}

/// Moves a read copy aside.
pub fn set_aside(path: &Path) -> std::io::Result<()> {
    std::fs::rename(path, path.with_file_name(SET_ASIDE))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_readable_shipped_file_is_known_by_its_hash_and_parses() {
        for text in READABLE_HISTORY {
            assert!(SHIPPED.contains(&sha256(text.as_bytes()).as_str()));
        }
        assert_eq!(history().len(), READABLE_HISTORY.len() + 1);
    }

    #[test]
    fn the_current_shipped_file_counts_as_shipped() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        std::fs::write(dir.path().join(LEFTOVER), DEFAULT_MODELS).unwrap_or_else(|e| panic!("{e}"));
        assert!(matches!(leftover(dir.path()), Leftover::Shipped(_)));
        assert!(matches!(
            leftover(&dir.path().join("empty")),
            Leftover::None
        ));
    }
}
