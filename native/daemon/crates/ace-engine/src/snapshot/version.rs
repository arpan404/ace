// SPDX-License-Identifier: Apache-2.0
//! The snapshot format's version (E5.3, `schema-version.ts`). The database checks run in the
//! TypeScript opener; Rust checks the per-row snapshot version on every decode, exactly where
//! `requireSnapshotVersion` does (`snapshot.ts:147`).

use ace_json::Value;

/// The pre-release engine format's version (`schema-version.ts:6`). Formats do not change in
/// E5.3: this stays 9.
pub const ENGINE_SCHEMA_VERSION: u64 = 9;

/// The recovery text every refusal carries (`schema-version.ts:11`).
pub const RECOVERY: &str = "Quit ace, then start it with a fresh ACE_HOME.";

/// `requireSnapshotVersion` (`schema-version.ts:24`): the stored header says `engineSnapshot`
/// is `9`, else `IncompatibleDataError(location, message, recovery)`.
pub fn require_snapshot_version(value: &Value) -> Result<(), crate::EngineError> {
    let version = match value {
        Value::Object(object) => object.get("engineSnapshot"),
        _ => None,
    };
    if matches!(version, Some(Value::Number(number)) if number.as_u64() == Some(ENGINE_SCHEMA_VERSION))
    {
        return Ok(());
    }
    Err(crate::EngineError::Incompatible {
        message: format!("Unsupported engine snapshot format: expected {ENGINE_SCHEMA_VERSION}"),
        recovery: RECOVERY,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_snapshot_without_the_expected_version_is_refused_with_the_recovery_text() {
        let error = require_snapshot_version(&ace_json::parse(r#"{"engineSnapshot":8}"#).unwrap())
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Unsupported engine snapshot format: expected 9"
        );
        assert!(
            matches!(error, crate::EngineError::Incompatible { recovery, .. } if recovery == RECOVERY)
        );
        assert!(
            require_snapshot_version(&ace_json::parse(r#"{"engineSnapshot":9}"#).unwrap()).is_ok()
        );
        assert!(
            require_snapshot_version(&ace_json::parse(r#"{"threadId":"t"}"#).unwrap()).is_err()
        );
    }
}
