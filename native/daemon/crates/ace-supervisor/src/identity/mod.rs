// SPDX-License-Identifier: Apache-2.0
//! Kernel process identity: pid plus start time, so a reused pid is never
//! signalled. Ports `process-identity.ts`. `start` is encoded exactly as
//! today: Linux `<boot_id>:<ticks>` (stat read twice, compared),
//! macOS `<tv_sec>:<tv_usec>`, Windows creation FILETIME plus owner SID.

use crate::errors::SupervisorError;
use crate::reaper::{child_has_exited, process_alive};

/// A process's owner: a numeric uid on POSIX, a token-user SID on Windows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessOwner {
    Uid(u32),
    Sid(String),
}

/// The strict process identity: pid, kernel start, owner, group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub start: String,
    pub owner: ProcessOwner,
    pub group: u32,
}

/// Whether a probe proved absence, or refused to say.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeRefused {
    /// The kernel refused the probe (macOS does this while a group exits).
    Refused,
}

/// Kernel start identity and uid, without inspecting arguments, environment
/// or credentials. `None` once no such process exists; other native failures
/// throw, after proving the process didn't just exit.
pub fn process_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    if pid == 0 {
        return Err(SupervisorError::InvalidInput("bad pid 0".to_owned()));
    }
    match platform_identity(pid) {
        Ok(Some(identity)) => {
            if identity.pid != pid {
                return Err(SupervisorError::Unavailable(
                    "process identity mismatch".to_owned(),
                ));
            }
            Ok(Some(identity))
        }
        Ok(None) => Ok(None),
        Err(error) => {
            // An unreaped child still answers kill(pid, 0) but cannot run or
            // have its pid reused. Other identity failures stay fail-closed.
            if child_has_exited(pid) {
                return Ok(None);
            }
            match process_alive(pid) {
                Ok(false) => Ok(None),
                Ok(true) => Err(error),
                Err(gone) => Err(gone),
            }
        }
    }
}

/// ESRCH proves a process group gone; other refusals fail closed.
pub fn process_group_is_gone(group: u32) -> Result<bool, SupervisorError> {
    match crate::reaper::process_group_alive(group) {
        Ok(alive) => Ok(!alive),
        Err(SupervisorError::Unavailable(_)) => Err(SupervisorError::Unavailable(
            "signal probe of group refused".to_owned(),
        )),
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn platform_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    let first = procfs::process::Process::new(pid as i32)
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let stat = first
        .stat()
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let status = first
        .status()
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let boot = procfs::sys::kernel::random::boot_id()
        .map_err(|error| SupervisorError::Unavailable(format!("boot id failed: {error}")))?;
    let boot = boot.trim().to_owned();
    validate_boot_id(&boot)?;
    // Identity must not change while assembling fields from separate reads.
    let second = procfs::process::Process::new(pid as i32)
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    let confirmed = second
        .stat()
        .map_err(|error| SupervisorError::Unavailable(format!("stat of {pid} failed: {error}")))?;
    if confirmed.pid != stat.pid
        || confirmed.starttime != stat.starttime
        || confirmed.pgrp != stat.pgrp
    {
        return Err(SupervisorError::Unavailable(
            "process changed during inspection".to_owned(),
        ));
    }
    let ticks = stat.starttime.to_string();
    let group = u32::try_from(stat.pgrp)
        .map_err(|_| SupervisorError::Unavailable(format!("stat of {pid} failed: bad group")))?;
    if group == 0 {
        return Err(SupervisorError::Unavailable(format!(
            "stat of {pid} failed: bad group"
        )));
    }
    Ok(Some(ProcessIdentity {
        pid: stat.pid as u32,
        start: format!("{boot}:{ticks}"),
        owner: ProcessOwner::Uid(status.ruid),
        group,
    }))
}

#[cfg(target_os = "linux")]
fn validate_boot_id(boot: &str) -> Result<(), SupervisorError> {
    // A 128-bit uuid in 8-4-4-4-12 hex, as /proc/sys/kernel/random/boot_id holds.
    let mut groups = boot.split('-');
    let want = [8, 4, 4, 4, 12];
    for length in want {
        let Some(group) = groups.next() else {
            return Err(SupervisorError::Unavailable("bad boot id".to_owned()));
        };
        if group.len() != length || !group.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(SupervisorError::Unavailable("bad boot id".to_owned()));
        }
    }
    if groups.next().is_some() {
        return Err(SupervisorError::Unavailable("bad boot id".to_owned()));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn platform_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    use libproc::libproc::bsd_info::BSDInfo;
    use libproc::libproc::proc_pid::pidinfo;
    let info: BSDInfo = pidinfo(
        i32::try_from(pid).map_err(|_| SupervisorError::InvalidInput(format!("bad pid {pid}")))?,
        0,
    )
    .map_err(|error| SupervisorError::Unavailable(format!("identity of {pid} failed: {error}")))?;
    if info.pbi_pid == 0 {
        return Ok(None);
    }
    Ok(Some(ProcessIdentity {
        pid: info.pbi_pid,
        start: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        owner: ProcessOwner::Uid(info.pbi_uid),
        group: info.pbi_pgid,
    }))
}

#[cfg(target_os = "windows")]
fn platform_identity(pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    let api = WindowsApi::load().map_err(SupervisorError::Unavailable)?;
    let found = read_windows_identity(pid, &api)?;
    Ok(found.map(|identity| ProcessIdentity {
        pid,
        start: identity.start,
        owner: ProcessOwner::Sid(identity.owner),
        group: pid,
    }))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_identity(_pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
    Err(SupervisorError::Unavailable(
        "kernel process identity requires Linux or macOS".to_owned(),
    ))
}

mod win;
pub use win::*;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
mod win_api;
#[cfg(target_os = "windows")]
pub(crate) use win_api::WindowsApi;

#[cfg(test)]
mod tests;
