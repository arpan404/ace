// SPDX-License-Identifier: Apache-2.0
//! Translator identity allocation (`packages/adapter-acp/src/identity.ts`).

use crate::error::AcpError;
use serde::{Deserialize, Serialize};

/// JavaScript's `Number.MAX_SAFE_INTEGER` (`2^53 - 1`).
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Persist generation and cursor together when continuing an allocator after a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslatorIdentity {
    pub generation: String,
    pub cursor: u64,
}

/// Validate and build a translator identity (`createTranslatorIdentity`, `identity.ts:6`).
pub fn create_translator_identity(
    generation: impl Into<String>,
    cursor: i64,
) -> Result<TranslatorIdentity, AcpError> {
    let generation = generation.into();
    if generation.is_empty() || cursor < 0 || (cursor as u64) > MAX_SAFE_INTEGER {
        return Err(AcpError::InvalidIdentity);
    }
    Ok(TranslatorIdentity {
        generation,
        cursor: cursor as u64,
    })
}

/// Validate and build a translator identity starting at cursor `0`.
pub fn create_translator_identity_default(
    generation: impl Into<String>,
) -> Result<TranslatorIdentity, AcpError> {
    create_translator_identity(generation, 0)
}

#[cfg(test)]
mod tests {
    use super::{MAX_SAFE_INTEGER, TranslatorIdentity, create_translator_identity};

    #[test]
    fn translator_identity_accepts_valid_and_rejects_invalid_allocations() {
        let cases: &[(&str, i64, Option<u64>)] = &[
            ("gen-1", 0, Some(0)),
            ("gen-1", 42, Some(42)),
            ("gen-1", MAX_SAFE_INTEGER as i64, Some(MAX_SAFE_INTEGER)),
            ("", 0, None),
            ("gen-1", -1, None),
            ("gen-1", (MAX_SAFE_INTEGER as i64) + 1, None),
        ];

        for &(generation, cursor, expected) in cases {
            let actual = create_translator_identity(generation, cursor).ok();
            let expected = expected.map(|c| TranslatorIdentity {
                generation: generation.to_owned(),
                cursor: c,
            });
            assert_eq!(
                actual, expected,
                "generation={generation:?} cursor={cursor}"
            );
        }
    }
}
