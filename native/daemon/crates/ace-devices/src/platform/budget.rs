// SPDX-License-Identifier: Apache-2.0
//! The platform's numbers: the ten-minute device install budget (`action-budget.ts`) and the
//! bound on the one lookup whose output the shell reads back.

/// `deviceInstallTimeoutMs`: an install gets ten minutes before its SDK command is stopped.
pub const INSTALL_TIMEOUT_MS: u64 = 600_000;

/// `resolve-activity --brief` prints one `package/activity` line; 8 KiB is its capture bound.
pub const RESOLVE_ACTIVITY_MAX_BYTES: u64 = 8192;
