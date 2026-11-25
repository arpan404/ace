// SPDX-License-Identifier: Apache-2.0
//! The device words: every refusal this crate renders comes from
//! `native/daemon/catalog/devices.json` (ADR 0225 safeguard 3), which the TypeScript and
//! Rust both read. The file is embedded at build time, so a missing catalog breaks the build
//! and a missing key fails the test that exercises it; no message is retyped in code.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use super::{Code, Refusal};

/// The catalog beside the daemon crate's workspace, compiled into the addon.
const CATALOG: &str = include_str!("../../../../catalog/devices.json");

#[derive(Debug, Deserialize)]
struct Catalog {
    platform: BTreeMap<String, Word>,
}

#[derive(Debug, Deserialize)]
struct Word {
    code: String,
    message: String,
    hint: String,
}

/// What a lookup says when the catalog has no such key: a daemon bug, never a device fact.
const MISSING: Refusal = Refusal {
    code: Code::CommandFailed,
    message: "A device message is missing from ace's catalog",
    hint: "Reinstall ace; its device catalog is incomplete.",
};

fn catalog() -> &'static Catalog {
    static CATALOG_ONCE: OnceLock<Catalog> = OnceLock::new();
    CATALOG_ONCE.get_or_init(|| {
        serde_json::from_str(CATALOG).unwrap_or(Catalog {
            platform: BTreeMap::new(),
        })
    })
}

/// The refusal `key` names, with the catalog's own code, message and hint.
pub fn refusal(key: &str) -> Refusal {
    let Some(word) = catalog().platform.get(key) else {
        return MISSING;
    };
    let Some(code) = Code::parse(&word.code) else {
        return MISSING;
    };
    Refusal {
        code,
        message: word.message.as_str(),
        hint: word.hint.as_str(),
    }
}

/// The refusal `key` names, or `None` when the catalog has no such word. Used by the check
/// that renders every word through both backends.
pub fn lookup(key: &str) -> Option<Refusal> {
    has(key).then(|| refusal(key))
}

/// Whether the catalog names `key` with a code the protocol has.
pub fn has(key: &str) -> bool {
    catalog()
        .platform
        .get(key)
        .is_some_and(|word| Code::parse(&word.code).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_word_this_crate_renders_is_in_the_catalog() {
        for key in [
            "installSimulatorApp",
            "installAndroidApk",
            "installPathRelative",
            "installPathInvalid",
            "appIdInvalid",
            "appNotLaunchable",
            "urlInvalid",
            "localeUnsupported",
            "locationPhysical",
            "simulatorNotBooted",
            "simulatorNameAmbiguous",
            "identityPlatformMismatch",
            "identityNotUdid",
            "identityNotAvd",
            "sizeUndecoded",
            "iosNeedsMac",
            "iosNeedsMacOs",
            "xcodeMissing",
            "xcodeUnavailable",
            "xcodeNotFull",
            "adbMissingArm",
            "adbMissingLinux",
            "sdkMissing",
            "armEmulatorNote",
            "deviceServiceClosed",
            "androidEmulatorMissing",
            "androidBootBusy",
            "androidPortLimit",
            "toolsNowhere",
        ] {
            assert!(has(key), "catalog names no usable word for {key}");
        }
    }

    #[test]
    fn a_missing_key_renders_a_typed_failure_rather_than_a_blank_message() {
        let missing = refusal("noSuchWord");
        assert_eq!(missing.code, Code::CommandFailed);
        assert!(!missing.message.is_empty());
    }
}
