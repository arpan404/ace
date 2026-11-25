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
    /// Messages that are not a whole refusal: a download's hint, its timeout's text.
    #[serde(default)]
    tools: BTreeMap<String, String>,
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
            tools: BTreeMap::new(),
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

/// The tool words that are not a refusal: a download's hint, its timeout's text.
pub fn hint(key: &str) -> Option<&'static str> {
    catalog().tools.get(key).map(String::as_str)
}

/// The next step of a platform word whose message is data (a key's name, a simulator's verb):
/// the catalog still owns the hint, so a refusal with a built message never spells its own.
pub fn platform_hint(key: &str) -> &'static str {
    catalog()
        .platform
        .get(key)
        .map_or(MISSING.hint, |word| word.hint.as_str())
}

/// A tool word, or the missing word's text: a hint that must render is never blank.
pub fn tool_hint(key: &str) -> &'static str {
    catalog()
        .tools
        .get(key)
        .map_or(MISSING.hint, String::as_str)
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
            "iosRecentsKey",
            "iosBackKey",
            "androidActionKey",
            "watchSideKey",
            "androidClipboardLiveView",
            "inputOutsideScreen",
            "pasteTooLong",
            "pasteTimedOut",
            "clipboardWriteTimedOut",
            "clipboardReadWaiting",
            "androidControlRestarted",
            "simulatorTreeMalformed",
            "simulatorTreeUnreadable",
            "simulatorTargetStale",
            "simulatorActionUnsupported",
            "simulatorSizeUnknown",
            "simulatorAxUnavailable",
            "simulatorAxBudget",
            "simulatorAxTimeout",
            "simulatorNoFold",
            "deviceNoFold",
            "simulatorFoldFailed",
            "androidNoFold",
            "androidFoldFailed",
            "androidTreeBudget",
            "androidXmlMalformed",
            "androidXmlDeclaration",
            "androidHierarchyDuplicate",
            "androidNodeUnclosed",
            "androidNodeOutsideHierarchy",
            "androidTreeUnbalanced",
            "androidNestingBudget",
            "androidXmlIncomplete",
            "androidEntityInvalid",
            "androidAttributesMalformed",
            "androidBoundsInvalid",
            "androidTargetStale",
            "androidActionUnsupported",
            "androidUiQueueFull",
            "simulatorTreeOnAndroid",
            "androidHelperStartFailed",
            "androidHelperExited",
            "androidHelperTimedOut",
            "androidInputEnded",
            "simulatorTooManyFingers",
            "jpegTooLarge",
        ] {
            assert!(has(key), "catalog names no usable word for {key}");
        }
    }

    #[test]
    fn every_tool_word_this_crate_renders_is_in_the_catalog() {
        for key in [
            "downloadHint",
            "againHint",
            "scrcpyHint",
            "downloadTimeout",
            "simulatorPasteTimeoutHint",
            "simulatorPasteFailedHint",
            "androidNoKeyHint",
            "iosNoKeyHint",
        ] {
            assert!(hint(key).is_some(), "catalog names no tool word for {key}");
        }
    }

    #[test]
    fn a_built_messages_next_step_still_comes_from_the_catalog() {
        assert_eq!(platform_hint("androidNoKey"), MISSING.hint);
        assert_eq!(
            tool_hint("androidNoKeyHint"),
            "Use the app's own controls instead."
        );
    }

    #[test]
    fn a_missing_key_renders_a_typed_failure_rather_than_a_blank_message() {
        let missing = refusal("noSuchWord");
        assert_eq!(missing.code, Code::CommandFailed);
        assert!(!missing.message.is_empty());
    }
}
