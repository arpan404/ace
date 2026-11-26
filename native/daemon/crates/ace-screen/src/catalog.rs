// SPDX-License-Identifier: Apache-2.0

//! The screen words the daemon renders, loaded from `native/daemon/catalog/screen.json` via
//! `ace-json` (ADR 0225 safeguard 3). The TypeScript and the Rust render the same strings;
//! nothing here is retyped.

use std::sync::OnceLock;

use ace_json::Value;

/// The file both backends read.
const SCREEN_CATALOG_JSON: &str = include_str!("../../../catalog/screen.json");

/// One refusal: the code a tool result carries and the text the model reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub code: String,
    pub message: String,
}

impl Refusal {
    fn from_object(object: &ace_json::Map) -> Option<Self> {
        Some(Self {
            code: object.get("code").and_then(Value::as_str)?.to_owned(),
            message: object.get("message").and_then(Value::as_str)?.to_owned(),
        })
    }
}

/// `computer`'s words (`packages/screen/src/computer/`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerWords {
    /// The client was closed: `client.ts:119`.
    pub closed: Refusal,
    /// The connection was closed: `helper-connection.ts:152`, `:189`.
    pub stopped: Refusal,
    /// A request the caller cancelled: `helper-connection.ts:68`.
    pub cancelled: Refusal,
    /// A request that overran its deadline: `helper-connection.ts:62`.
    pub timeout: Refusal,
    /// The helper exited while a request was running: `helper-connection.ts:63`.
    pub helper_exited: Refusal,
    /// A previous helper has not exited yet: `helper-connection.ts:125`.
    pub helper_stopping: Refusal,
    /// A helper that could not be started, with nothing more to say: `:360`.
    pub helper_unavailable: Refusal,
    /// A helper that could not be started, naming why: `:226`.
    pub helper_unavailable_with: Refusal,
    /// A reply past the byte cap: `:395`.
    pub reply_too_large: Refusal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenCatalog {
    pub computer: ComputerWords,
}

fn object<'a>(root: &'a ace_json::Map, key: &str) -> Option<&'a ace_json::Map> {
    root.get(key).and_then(Value::as_object)
}

fn refusal(root: &ace_json::Map, key: &str) -> Option<Refusal> {
    object(root, key).and_then(Refusal::from_object)
}

fn parse(json: &str) -> Option<ScreenCatalog> {
    let value = ace_json::parse(json).ok()?;
    let root = value.as_object()?;
    let computer = object(root, "computer")?;
    Some(ScreenCatalog {
        computer: ComputerWords {
            closed: refusal(computer, "closed")?,
            stopped: refusal(computer, "stopped")?,
            cancelled: refusal(computer, "cancelled")?,
            timeout: refusal(computer, "timeout")?,
            helper_exited: refusal(computer, "helperExited")?,
            helper_stopping: refusal(computer, "helperStopping")?,
            helper_unavailable: refusal(computer, "helperUnavailable")?,
            helper_unavailable_with: refusal(computer, "helperUnavailableWith")?,
            reply_too_large: refusal(computer, "replyTooLarge")?,
        },
    })
}

/// The catalog, parsed once. A build whose catalog is missing a word panics at first use: the
/// file is compiled in, so that is a broken build, never a runtime condition.
pub fn catalog() -> &'static ScreenCatalog {
    static CATALOG: OnceLock<ScreenCatalog> = OnceLock::new();
    CATALOG.get_or_init(|| match parse(SCREEN_CATALOG_JSON) {
        Some(catalog) => catalog,
        None => panic!("catalog/screen.json is missing a computer word"),
    })
}

/// `refusal.message` with `{name}` filled in, as the TypeScript's template literals do.
pub fn fill(refusal: &Refusal, name: &str, value: &str) -> String {
    refusal.message.replace(&format!("{{{name}}}"), value)
}

#[cfg(test)]
mod tests {
    use super::catalog;

    #[test]
    fn every_computer_word_is_present_and_names_its_code() {
        let computer = &catalog().computer;
        for (refusal, code) in [
            (&computer.closed, "closed"),
            (&computer.stopped, "closed"),
            (&computer.cancelled, "cancelled"),
            (&computer.timeout, "timeout"),
            (&computer.helper_exited, "helper_exited"),
            (&computer.helper_stopping, "helper_stopping"),
            (&computer.helper_unavailable, "helper_unavailable"),
            (&computer.helper_unavailable_with, "helper_unavailable"),
            (&computer.reply_too_large, "reply_too_large"),
        ] {
            assert_eq!(refusal.code, code);
            assert!(!refusal.message.is_empty());
        }
    }
}
