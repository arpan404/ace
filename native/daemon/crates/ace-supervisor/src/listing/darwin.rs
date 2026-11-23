// SPDX-License-Identifier: Apache-2.0
//! macOS listing through libproc: one kernel read per process, children
//! from the kernel's parent index.

use super::{KernelListing, ProcessInfo};
use libproc::libproc::bsd_info::BSDInfo;
use libproc::libproc::proc_pid::pidinfo;
use libproc::processes::{ProcFilter, pids_by_type};

/// SZOMB in <sys/proc.h>.
const ZOMBIE: u32 = 5;

fn bsd(pid: u32) -> Option<BSDInfo> {
    let info: BSDInfo = pidinfo(pid as i32, 0).ok()?;
    if info.pbi_pid != pid {
        return None;
    }
    Some(info)
}

/// One kernel read of a macOS process: start, parent, group, state.
pub fn darwin_info(pid: u32) -> Option<ProcessInfo> {
    let info = bsd(pid)?;
    Some(ProcessInfo {
        start: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
        parent: info.pbi_ppid,
        group: info.pbi_pgid,
        zombie: info.pbi_status == ZOMBIE,
    })
}

/// The macOS listing: libproc for structure, sysinfo for environments.
pub struct DarwinListing;

impl KernelListing for DarwinListing {
    fn platform(&self) -> &str {
        "darwin"
    }

    fn all(&self) -> Vec<u32> {
        pids_by_type(ProcFilter::All).unwrap_or_default()
    }

    fn info(&self, pid: u32) -> Option<ProcessInfo> {
        darwin_info(pid)
    }

    fn group_members(&self, group: u32) -> Vec<u32> {
        pids_by_type(ProcFilter::ByProgramGroup { pgrpid: group }).unwrap_or_default()
    }

    fn environment(&self, pid: u32) -> Option<Vec<String>> {
        environment_of(pid)
    }

    fn arguments(&self, pid: u32) -> Option<Vec<String>> {
        arguments_of(pid)
    }

    fn has_lineage(&self) -> bool {
        false
    }
}

/// One sysinfo snapshot restricted to `pid`: its environment, if visible.
fn snapshot(pid: u32) -> Option<(Vec<String>, Vec<String>)> {
    use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
    let mut system = System::new().ok()?;
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::everything(),
    );
    let process = system.process(Pid::from_u32(pid))?;
    let environ = process
        .environ()
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    let cmd = process
        .cmd()
        .iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    Some((environ, cmd))
}

fn environment_of(pid: u32) -> Option<Vec<String>> {
    snapshot(pid).map(|(environ, _)| environ)
}

fn arguments_of(pid: u32) -> Option<Vec<String>> {
    snapshot(pid).map(|(_, cmd)| cmd)
}

/// The children of `pid`, read from the kernel's parent index.
pub fn children_of(pid: u32) -> Vec<u32> {
    pids_by_type(ProcFilter::ByParentProcess { ppid: pid }).unwrap_or_default()
}
