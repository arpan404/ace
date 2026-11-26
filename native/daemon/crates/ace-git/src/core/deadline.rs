// SPDX-License-Identifier: Apache-2.0
//! Git deadlines and timeout validation, matching `packages/git/src/deadlines.ts` and `cli.ts`.

use crate::core::error::{GitError, GitErrorCode};

/// Default per-call Git timeout (30 s).
pub const DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Deadline for Git writes that run a person's hooks or check out a whole tree (10 min).
pub const LONG_WRITE_TIMEOUT_MS: u64 = 600_000;

/// Largest safe Node/libuv timer delay (signed 32-bit int max).
pub const MAX_TIMEOUT_MS: u64 = 2_147_483_647;

/// Validate `timeoutMs` exactly as `GitCli`'s constructor validates it:
/// an integer between `1` and `2_147_483_647`, defaulting to `30_000`.
pub fn validate_timeout_ms(timeout_ms: Option<f64>) -> Result<u64, GitError> {
    let Some(raw) = timeout_ms else {
        return Ok(DEFAULT_TIMEOUT_MS);
    };
    if !raw.is_finite() || raw.fract() != 0.0 || raw <= 0.0 || raw > MAX_TIMEOUT_MS as f64 {
        return Err(GitError::new(
            GitErrorCode::InvalidArgument,
            "timeoutMs must be an integer between 1 and 2147483647",
        ));
    }
    Ok(raw as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_bounds_match_typescript() {
        assert_eq!(validate_timeout_ms(None), Ok(DEFAULT_TIMEOUT_MS));
        assert_eq!(validate_timeout_ms(Some(1.0)), Ok(1));
        assert_eq!(
            validate_timeout_ms(Some(2_147_483_647.0)),
            Ok(MAX_TIMEOUT_MS)
        );
        for bad in [0.0, -1.0, 1.5, f64::NAN, f64::INFINITY, 2_147_483_648.0] {
            let err = validate_timeout_ms(Some(bad));
            assert!(matches!(
                err,
                Err(GitError {
                    code: GitErrorCode::InvalidArgument,
                    ..
                })
            ));
        }
    }
}
