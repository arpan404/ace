//! Starting a command inside its AppContainer and job (ADR 0167 decision 1). The daemon can't put
//! a `SECURITY_CAPABILITIES` attribute on a `std`/`tokio` child, and an AppContainer is set only
//! at creation (unlike Landlock, which a process applies to itself). So, as on Linux, the daemon
//! spawns Spade's own binary as a launcher with the command's stdio piped; the launcher calls
//! [`run`], which creates the command in the container, holds it in a job and waits.
//!
//! When the run has network, the launcher also starts the in-container egress bridge
//! (`spade sandbox-net-bridge`) in the same job, so a loopback endpoint the command can reach
//! lives inside the container; the bridge forwards to the daemon over a named pipe. Both die when
//! the job closes.

use std::ffi::{OsStr, OsString};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
use windows::Win32::Security::SECURITY_CAPABILITIES;
use windows::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use crate::job::{Job, Limits};
use crate::profile;
use crate::sid::Sid;

/// The in-container egress bridge: the loopback port the command's proxy points at, and the named
/// pipe it forwards to.
pub struct Bridge {
    pub pipe: String,
    pub port: u16,
}

/// Creates the AppContainer profile named `name` (if missing) and runs `program args` in it, held
/// in a job with `limits`. When `bridge` is set, the egress bridge runs in the same job first.
/// Returns the command's exit code. The command inherits this process's standard handles.
pub fn run(
    name: &str,
    display: &str,
    limits: Limits,
    bridge: Option<Bridge>,
    program: &OsStr,
    args: &[OsString],
) -> std::io::Result<u32> {
    run_with(name, display, limits, bridge, None, program, args)
}

/// [`run`], with the program that hosts the egress bridge named explicitly (`bridge_exe`); `None`
/// uses Spade's own binary (`current_exe`). Tests pass a helper here.
pub fn run_with(
    name: &str,
    display: &str,
    limits: Limits,
    bridge: Option<Bridge>,
    bridge_exe: Option<&std::path::Path>,
    program: &OsStr,
    args: &[OsString],
) -> std::io::Result<u32> {
    let sid = profile::ensure(name, display)?;
    let mut caps = Capabilities::new(&sid)?;
    let job = Job::create(limits)?;

    // The bridge first, so its loopback endpoint is up before the command runs. No inherited
    // handles: it must not touch the command's stdio.
    let _bridge = match bridge {
        Some(bridge) => Some(spawn_bridge(&mut caps, &job, bridge_exe, &bridge)?),
        None => None,
    };

    let (process, thread) = create(&mut caps, program, args, true)?;
    let process_handle = HANDLE(process.as_raw_handle());
    job.assign(process.as_raw_handle())?;
    // SAFETY: a live thread handle; resuming the one suspended thread of the command.
    unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) };
    drop(thread);

    // SAFETY: a live process handle; waits for the command to exit.
    unsafe { WaitForSingleObject(process_handle, INFINITE) };
    let mut code = 0u32;
    // SAFETY: `code` is a live local the call fills.
    unsafe { GetExitCodeProcess(process_handle, &mut code) }.map_err(crate::io)?;
    drop(job);
    Ok(code)
}

/// `run`, for the bridge: the command line is `spade sandbox-net-bridge <pipe> <port>`.
fn spawn_bridge(
    caps: &mut Capabilities,
    job: &Job,
    bridge_exe: Option<&std::path::Path>,
    bridge: &Bridge,
) -> std::io::Result<OwnedHandle> {
    let exe = match bridge_exe {
        Some(exe) => exe.to_path_buf(),
        None => std::env::current_exe()?,
    };
    let args = [
        OsString::from("sandbox-net-bridge"),
        OsString::from(&bridge.pipe),
        OsString::from(bridge.port.to_string()),
    ];
    let (process, thread) = create(caps, exe.as_os_str(), &args, false)?;
    job.assign(process.as_raw_handle())?;
    // SAFETY: a live thread handle; resuming the bridge's one suspended thread.
    unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) };
    drop(thread);
    Ok(process)
}

/// One proc-thread attribute list carrying a container SID with no capabilities. Held so the SID
/// outlives every process creation that reads it.
struct Capabilities {
    _sid: Sid,
    caps: Box<SECURITY_CAPABILITIES>,
    buffer: Vec<u8>,
}

impl Capabilities {
    fn new(sid: &Sid) -> std::io::Result<Self> {
        let caps = Box::new(SECURITY_CAPABILITIES {
            AppContainerSid: sid.as_psid(),
            Capabilities: std::ptr::null_mut(),
            CapabilityCount: 0,
            Reserved: 0,
        });
        let mut size = 0usize;
        // SAFETY: the documented two-call pattern; the first fails on purpose to size the list.
        let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
        let mut buffer = vec![0u8; size];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
        // SAFETY: `list` has `size` bytes; one attribute is declared.
        unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut size) }
            .map_err(crate::io)?;
        // SAFETY: `caps` is boxed, so its address is stable while this struct lives.
        unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
                Some(std::ptr::from_ref(caps.as_ref()).cast()),
                std::mem::size_of::<SECURITY_CAPABILITIES>(),
                None,
                None,
            )
        }
        .map_err(crate::io)?;
        Ok(Self {
            _sid: sid.clone(),
            caps,
            buffer,
        })
    }

    fn list(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        LPPROC_THREAD_ATTRIBUTE_LIST(self.buffer.as_mut_ptr().cast())
    }
}

impl Drop for Capabilities {
    fn drop(&mut self) {
        // SAFETY: the list was initialized in `new`; the boxed caps outlive this.
        unsafe { DeleteProcThreadAttributeList(self.list()) };
        let _ = &self.caps;
    }
}

/// Creates `program args` suspended in the container. When `inherit_std`, the command inherits
/// this process's standard handles (so the daemon streams it); otherwise it gets none.
fn create(
    caps: &mut Capabilities,
    program: &OsStr,
    args: &[OsString],
    inherit_std: bool,
) -> std::io::Result<(OwnedHandle, OwnedHandle)> {
    let mut info = STARTUPINFOEXW::default();
    info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    info.lpAttributeList = caps.list();
    if inherit_std {
        let (stdin, stdout, stderr) = std_handles()?;
        for handle in [stdin, stdout, stderr] {
            // SAFETY: a live standard handle; making it inheritable so the child receives it.
            let _ =
                unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) };
        }
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = stdin;
        info.StartupInfo.hStdOutput = stdout;
        info.StartupInfo.hStdError = stderr;
    }

    let mut line = command_line(program, args);
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY: `line` is a writable NUL-terminated wide buffer; `info`/`pi` are live locals; the
    // attribute list and its SID live until after this returns.
    unsafe {
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            inherit_std,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_NEW_PROCESS_GROUP
                | CREATE_UNICODE_ENVIRONMENT,
            None,
            PCWSTR::null(),
            &info.StartupInfo,
            &mut pi,
        )
    }
    .map_err(crate::io)?;
    // SAFETY: fresh handles the call returned; owning them closes them on drop.
    let process = unsafe { OwnedHandle::from_raw_handle(pi.hProcess.0) };
    // SAFETY: as above, the thread handle.
    let thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread.0) };
    Ok((process, thread))
}

fn std_handles() -> std::io::Result<(HANDLE, HANDLE, HANDLE)> {
    // SAFETY: each returns this process's standard handle, or an error.
    let get = |which| unsafe { GetStdHandle(which) }.map_err(crate::io);
    Ok((
        get(STD_INPUT_HANDLE)?,
        get(STD_OUTPUT_HANDLE)?,
        get(STD_ERROR_HANDLE)?,
    ))
}

/// `program args` as one command line, each part quoted by the rules `CommandLineToArgvW` reads.
fn command_line(program: &OsStr, args: &[OsString]) -> Vec<u16> {
    let mut line: Vec<u16> = Vec::new();
    quote(program, &mut line);
    for arg in args {
        line.push(u16::from(b' '));
        quote(arg, &mut line);
    }
    line.push(0);
    line
}

/// Appends `arg` to `line`, wrapping it in quotes and escaping as `CommandLineToArgvW` expects.
fn quote(arg: &OsStr, line: &mut Vec<u16>) {
    use std::os::windows::ffi::OsStrExt;
    let units: Vec<u16> = arg.encode_wide().collect();
    let needs = units.is_empty()
        || units
            .iter()
            .any(|&u| u == u16::from(b' ') || u == u16::from(b'\t') || u == u16::from(b'"'));
    if !needs {
        line.extend_from_slice(&units);
        return;
    }
    line.push(u16::from(b'"'));
    let mut backslashes = 0usize;
    for &unit in &units {
        if unit == u16::from(b'\\') {
            backslashes += 1;
            line.push(unit);
            continue;
        }
        if unit == u16::from(b'"') {
            for _ in 0..=backslashes {
                line.push(u16::from(b'\\'));
            }
        }
        backslashes = 0;
        line.push(unit);
    }
    for _ in 0..backslashes {
        line.push(u16::from(b'\\'));
    }
    line.push(u16::from(b'"'));
}
