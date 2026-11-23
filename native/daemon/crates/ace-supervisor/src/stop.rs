// SPDX-License-Identifier: Apache-2.0
//! What a stop reaches: POSIX group signals, retained stops that outlive
//! their leader, and the Windows whole-tree stop. Ports `process-owner.ts`
//! (the signal half) and `tree-stop.ts`. The guard over who may be
//! signalled stays on the shell boundary; everything here is unguarded.

use crate::errors::SupervisorError;
use crate::signal::SignalName;

/// Ends a group with `signal`. ESRCH proves it gone; on darwin EPERM while
/// a group exits is not a failure either.
#[cfg(unix)]
pub fn kill_group(group: u32, signal: SignalName) -> Result<(), SupervisorError> {
    let raw = i32::try_from(group)
        .ok()
        .filter(|raw| *raw > 0)
        .ok_or_else(|| SupervisorError::InvalidInput(format!("bad group {group}")))?;
    let Some(target) = rustix::process::Pid::from_raw(raw) else {
        return Err(SupervisorError::InvalidInput(format!("bad group {group}")));
    };
    let sig = match signal {
        SignalName::Term => rustix::process::Signal::TERM,
        SignalName::Kill => rustix::process::Signal::KILL,
    };
    match rustix::process::kill_process_group(target, sig) {
        Ok(()) => Ok(()),
        Err(error) if error == rustix::io::Errno::SRCH => Ok(()),
        #[cfg(target_os = "macos")]
        Err(error) if error == rustix::io::Errno::PERM => Ok(()),
        Err(error) => Err(SupervisorError::Operation(format!(
            "signal of group {group} failed: {error}"
        ))),
    }
}

/// No process groups exist on Windows; stop the whole tree instead.
#[cfg(windows)]
pub fn kill_group(_group: u32, _signal: SignalName) -> Result<(), SupervisorError> {
    Err(SupervisorError::Unavailable(
        "process groups do not exist on Windows".to_owned(),
    ))
}

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

#[cfg(test)]
mod tests {
    #[test]
    fn kill_group_rejects_bad_groups() {
        assert!(super::kill_group(0, super::SignalName::Kill).is_err());
    }
}
