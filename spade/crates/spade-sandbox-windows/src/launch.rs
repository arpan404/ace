//! Starting one command inside its AppContainer and job (ADR 0167 decision 1). The daemon can't
//! put a `SECURITY_CAPABILITIES` attribute on a `std`/`tokio` child, and an AppContainer is set
//! only at creation (unlike Landlock, which a process applies to itself). So, as on Linux, the
//! daemon spawns Spade's own binary as a launcher with the command's stdio piped; the launcher
//! calls [`run`], which creates the real command in the container, holds it in a job and waits.
//! The launcher's own standard handles become the command's, so the daemon's streaming is
//! unchanged.

use std::ffi::OsStr;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows::Win32::Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation};
use windows::Win32::Security::SECURITY_CAPABILITIES;
use windows::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows::Win32::System::Threading::{
    CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{PCWSTR, PWSTR};

use crate::job::{Job, Limits};
use crate::profile;

/// Creates the AppContainer profile named `name` (if missing) and runs `program args` in it,
/// held in a job with `limits`. Returns the command's exit code. The command inherits this
/// process's standard handles.
pub fn run(
    name: &str,
    display: &str,
    limits: Limits,
    program: &OsStr,
    args: &[std::ffi::OsString],
) -> std::io::Result<u32> {
    let sid = profile::ensure(name, display)?;

    // One proc-thread attribute: the container SID with no capabilities.
    let mut caps = SECURITY_CAPABILITIES {
        AppContainerSid: sid.as_psid(),
        Capabilities: std::ptr::null_mut(),
        CapabilityCount: 0,
        Reserved: 0,
    };
    let mut size = 0usize;
    // SAFETY: the documented two-call pattern; the first fails on purpose to size the list.
    let _ = unsafe { InitializeProcThreadAttributeList(None, 1, None, &mut size) };
    let mut buffer = vec![0u8; size];
    let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
    // SAFETY: `list` has `size` bytes; one attribute is declared.
    unsafe { InitializeProcThreadAttributeList(Some(list), 1, None, &mut size) }
        .map_err(crate::io)?;
    let guard = AttributeList(list);
    // SAFETY: `caps` outlives the process creation below (it lives to end of function).
    unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
            Some(std::ptr::from_mut(&mut caps).cast()),
            std::mem::size_of::<SECURITY_CAPABILITIES>(),
            None,
            None,
        )
    }
    .map_err(crate::io)?;

    // Our own standard handles become the command's, so the daemon streams it directly.
    let (stdin, stdout, stderr) = std_handles()?;
    for handle in [stdin, stdout, stderr] {
        // SAFETY: a live standard handle; making it inheritable so the child receives it.
        let _ = unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) };
    }

    let mut info = STARTUPINFOEXW::default();
    info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    info.StartupInfo.hStdInput = stdin;
    info.StartupInfo.hStdOutput = stdout;
    info.StartupInfo.hStdError = stderr;
    info.lpAttributeList = list;

    let mut line = command_line(program, args);
    let mut pi = PROCESS_INFORMATION::default();
    // SAFETY: `line` is a writable NUL-terminated wide buffer; `info`/`pi` are live locals;
    // the attribute list and `caps` live until after this returns.
    unsafe {
        windows::Win32::System::Threading::CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            true,
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
    drop(guard);

    // SAFETY: a fresh process handle the call returned; owning it closes it on drop.
    let process = unsafe { OwnedHandle::from_raw_handle(pi.hProcess.0) };
    // SAFETY: a fresh thread handle the call returned; owning it closes it on drop.
    let thread = unsafe { OwnedHandle::from_raw_handle(pi.hThread.0) };
    let process_handle = HANDLE(process.as_raw_handle());

    // The job holds the suspended process and everything it will start; then it runs.
    let job = Job::create(limits)?;
    job.assign(process_handle)?;
    // SAFETY: a live thread handle; resuming the one suspended thread.
    unsafe { ResumeThread(HANDLE(thread.as_raw_handle())) };
    drop(thread);

    // SAFETY: a live process handle; waits for it to exit.
    unsafe { WaitForSingleObject(process_handle, INFINITE) };
    let mut code = 0u32;
    // SAFETY: `code` is a live local the call fills.
    unsafe { GetExitCodeProcess(process_handle, &mut code) }.map_err(crate::io)?;
    // Hold the job until the tree has exited, then let it close.
    drop(job);
    Ok(code)
}

/// Frees a proc-thread attribute list on drop.
struct AttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the list was initialized by InitializeProcThreadAttributeList.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
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
fn command_line(program: &OsStr, args: &[std::ffi::OsString]) -> Vec<u16> {
    let mut line: Vec<u16> = Vec::new();
    let mut push = |part: &OsStr, first: bool| {
        if !first {
            line.push(u16::from(b' '));
        }
        quote(part, &mut line);
    };
    push(program, true);
    for arg in args {
        push(arg, false);
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
            for _ in 0..backslashes {
                line.push(u16::from(b'\\'));
            }
            line.push(u16::from(b'\\'));
        }
        backslashes = 0;
        line.push(unit);
    }
    for _ in 0..backslashes {
        line.push(u16::from(b'\\'));
    }
    line.push(u16::from(b'"'));
}
