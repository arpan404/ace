// SPDX-License-Identifier: Apache-2.0
//! Exit codes (`@ace/service/exit-codes`, ADR 0072).
//!
//! Ported from `packages/service/src/exit-codes.ts`, whose numbers come from
//! `cliExitCodes` in `packages/protocol/src/cli-output.ts`. Whatever starts the
//! daemon (the desktop app, a login service) reads them, so the numbers never
//! change. The TypeScript cases that pin them are
//! `apps/daemon/src/cli/contract.test.ts` ("exit codes" → "%s exits %i, the same
//! number the desktop app reads").

/// One exit code, by the CLI's own name for it.
///
/// The whole table is the CLI's contract that the desktop app and the login
/// service read; slice 1 constructs only the codes its own failures produce.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCode {
    Ok,
    Failed,
    NeedsHuman,
    Timeout,
    Refused,
    Uncertain,
    AddressInUse,
    LockHeld,
    Usage,
    NewerData,
    IncompatibleData,
}

impl ExitCode {
    /// The number the CLI, the desktop app and the login service read.
    pub fn number(self) -> i32 {
        match self {
            Self::Ok => 0,
            Self::Failed => 1,
            Self::NeedsHuman => 2,
            Self::Timeout => 3,
            Self::Refused => 4,
            Self::Uncertain => 5,
            Self::AddressInUse => 6,
            Self::LockHeld => 7,
            // sysexits' EX_USAGE and EX_DATAERR.
            Self::Usage => 64,
            Self::NewerData => 65,
            Self::IncompatibleData => 66,
        }
    }

    /// The CLI's name for the outcome, as it prints it.
    #[allow(dead_code)]
    pub fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::NeedsHuman => "needs-human",
            Self::Timeout => "timeout",
            Self::Refused => "refused",
            Self::Uncertain => "uncertain",
            Self::AddressInUse => "address-in-use",
            Self::LockHeld => "lock-held",
            Self::Usage => "usage",
            Self::NewerData => "newer-data",
            Self::IncompatibleData => "incompatible-data",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ExitCode;

    /// `apps/daemon/src/cli/contract.test.ts`: "%s exits %i, the same number the
    /// desktop app reads".
    #[test]
    fn every_exit_code_is_the_number_the_desktop_app_reads() {
        let table = [
            (ExitCode::Ok, 0, "ok"),
            (ExitCode::Failed, 1, "failed"),
            (ExitCode::NeedsHuman, 2, "needs-human"),
            (ExitCode::Timeout, 3, "timeout"),
            (ExitCode::Refused, 4, "refused"),
            (ExitCode::Uncertain, 5, "uncertain"),
            (ExitCode::AddressInUse, 6, "address-in-use"),
            (ExitCode::LockHeld, 7, "lock-held"),
            (ExitCode::Usage, 64, "usage"),
            (ExitCode::NewerData, 65, "newer-data"),
            (ExitCode::IncompatibleData, 66, "incompatible-data"),
        ];
        for (code, number, name) in table {
            assert_eq!(code.number(), number);
            assert_eq!(code.name(), name);
        }
    }
}
