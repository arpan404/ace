// SPDX-License-Identifier: Apache-2.0
//! This process, as the kernel names it: the start time another daemon's sweep
//! matches against `daemon-run.json`'s `start` (`owned-evidence.ts:84`–`:88`).
//! macOS and Linux only, through `ace-supervisor`'s one kernel listing; a
//! platform without it records no start, as TS says of such a build.

/// One kernel read of a process, for the caller chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Info {
    pub start: String,
    pub parent: u32,
    pub zombie: bool,
}

/// `info(pid)`: start, parent and state, or none once it is gone.
pub fn info(pid: i64) -> Option<Info> {
    let pid = u32::try_from(pid).ok()?;
    info_of(pid)
}

#[cfg(target_os = "macos")]
fn info_of(pid: u32) -> Option<Info> {
    use ace_supervisor::listing::{DarwinListing, KernelListing};
    DarwinListing.info(pid).map(|info| Info {
        start: info.start,
        parent: info.parent,
        zombie: info.zombie,
    })
}

#[cfg(target_os = "linux")]
fn info_of(pid: u32) -> Option<Info> {
    use ace_supervisor::listing::{KernelListing, LinuxListing, SystemProcFs};
    LinuxListing::new(SystemProcFs).info(pid).map(|info| Info {
        start: info.start,
        parent: info.parent,
        zombie: info.zombie,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn info_of(_pid: u32) -> Option<Info> {
    None
}

/// This process's kernel start, in the platform's own spelling.
pub fn kernel_start() -> Option<String> {
    start(std::process::id())
}

#[cfg(target_os = "macos")]
fn start(pid: u32) -> Option<String> {
    use ace_supervisor::listing::{DarwinListing, KernelListing};
    DarwinListing.info(pid).map(|info| info.start)
}

#[cfg(target_os = "linux")]
fn start(pid: u32) -> Option<String> {
    use ace_supervisor::listing::{KernelListing, LinuxListing, SystemProcFs};
    LinuxListing::new(SystemProcFs)
        .info(pid)
        .map(|info| info.start)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn start(_pid: u32) -> Option<String> {
    None
}
