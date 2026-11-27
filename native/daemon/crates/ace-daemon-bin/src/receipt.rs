// SPDX-License-Identifier: Apache-2.0
//! `<home>/daemon-shutdown.json`: one bounded, correlated receipt for a stop
//! request (`shutdown-receipt.ts`).
//!
//! `ace stop` sends `POST /v1/stop`, receives `{stopping: true, receiptId}`, and
//! waits for the receipt with that id to leave `pending`. The receipt says the
//! daemon's cleanup finished; it can't say the process exited, so `ace stop`
//! proves that separately by process identity (ADR 0186).

use std::io;
use std::path::Path;

/// The file's name in the home.
pub const RECEIPT_FILE: &str = "daemon-shutdown.json";

/// What a receipt records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Pending,
    Succeeded,
    Failed,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

/// Write the receipt whole or not at all.
pub fn write(
    home: &Path,
    id: &str,
    state: State,
    at_ms: f64,
    error: Option<&str>,
    unaccounted: bool,
) -> Result<(), io::Error> {
    let mut receipt = serde_json::Map::new();
    receipt.insert("id".into(), id.into());
    receipt.insert("state".into(), state.name().into());
    receipt.insert("at".into(), at_ms.into());
    if let Some(error) = error {
        receipt.insert("error".into(), error.into());
    }
    if unaccounted {
        receipt.insert("unaccounted".into(), true.into());
    }
    let path = home.join(RECEIPT_FILE);
    let temporary = home.join(format!("{RECEIPT_FILE}.tmp"));
    crate::home::write_private(
        &temporary,
        serde_json::Value::Object(receipt).to_string().as_bytes(),
    )?;
    std::fs::rename(&temporary, path)
}

/// The receipt this home holds, or none before a stop was ever asked for.
#[cfg(test)]
pub fn read(home: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(home.join(RECEIPT_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The ask `POST /v1/stop` answers, and the request a client may send with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Admission {
    pub receipt_id: String,
}

impl Admission {
    /// The JSON body, in the TypeScript's field order: `{stopping, receiptId}`.
    pub fn to_json(&self) -> String {
        format!(
            "{{\"stopping\":true,\"receiptId\":{}}}",
            serde_json::Value::String(self.receipt_id.clone())
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::TempDir;

    /// `shutdown-receipt.ts`: one receipt, pending then succeeded, keyed by the id
    /// the answer carried.
    #[test]
    fn a_receipt_is_pending_then_succeeded_under_the_same_id() {
        let home = TempDir::new("ace-receipt");
        assert!(read(home.path()).is_none());
        assert!(write(home.path(), "receipt-1", State::Pending, 1.0, None, false).is_ok());
        let pending = read(home.path());
        assert_eq!(
            pending
                .as_ref()
                .and_then(|receipt| receipt.get("state"))
                .and_then(serde_json::Value::as_str),
            Some("pending")
        );
        assert!(write(home.path(), "receipt-1", State::Succeeded, 2.0, None, false).is_ok());
        let receipt = read(home.path()).unwrap_or_default();
        assert_eq!(
            receipt.get("id").and_then(serde_json::Value::as_str),
            Some("receipt-1")
        );
        assert_eq!(
            receipt.get("state").and_then(serde_json::Value::as_str),
            Some("succeeded")
        );
        assert_eq!(
            receipt.get("at").and_then(serde_json::Value::as_f64),
            Some(2.0)
        );
    }

    /// A failed receipt names its error, and an unaccounted stop says so.
    #[test]
    fn a_failed_receipt_names_its_error_and_an_unaccounted_stop_says_so() {
        let home = TempDir::new("ace-receipt-failed");
        assert!(write(home.path(), "r", State::Failed, 1.0, Some("deadline"), true).is_ok());
        let receipt = read(home.path()).unwrap_or_default();
        assert_eq!(
            receipt.get("error").and_then(serde_json::Value::as_str),
            Some("deadline")
        );
        assert_eq!(
            receipt
                .get("unaccounted")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
    }

    /// `POST /v1/stop`'s answer: `{stopping: true, receiptId}`.
    #[test]
    fn the_admission_answer_names_the_receipt() {
        let admission = Admission {
            receipt_id: "abc".to_owned(),
        };
        assert_eq!(
            admission.to_json(),
            "{\"stopping\":true,\"receiptId\":\"abc\"}"
        );
    }
}
