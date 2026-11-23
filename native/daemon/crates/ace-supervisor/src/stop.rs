// SPDX-License-Identifier: Apache-2.0
//! The Windows whole-tree stop (taskkill). POSIX group signals go only
//! through a held leader (`leader.rs`), never by a bare group number.

#[cfg(windows)]
use crate::errors::SupervisorError;

/// Whole-tree stop on Windows, where process groups do not exist.
/// taskkill /T stops the tree the way a Job Object would; /F forces it.
/// Never uses a shell; a spawn failure is the stop's failure, not a wait.
#[cfg(windows)]
pub fn kill_windows_tree(pid: u32, force: bool) -> Result<(), SupervisorError> {
    let taskkill = crate::owner::windows_system_executable("taskkill.exe")?;
    let mut killer = std::process::Command::new(taskkill);
    killer.arg("/pid").arg(pid.to_string()).arg("/T");
    if force {
        killer.arg("/F");
    }
    killer.stdin(std::process::Stdio::null());
    killer.stdout(std::process::Stdio::null());
    killer.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // CREATE_NO_WINDOW: no console flash for the killer itself.
        killer.creation_flags(0x0800_0000);
    }
    killer
        .spawn()
        .map(|_| ())
        .map_err(|error| SupervisorError::Operation(format!("taskkill failed: {error}")))
}
