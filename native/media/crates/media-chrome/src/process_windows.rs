// SPDX-License-Identifier: Apache-2.0
//! Windows: Chrome's debugging pipe on C runtime descriptors 3 and 4, the browser in a job.
//!
//! - **The pipe.** Chrome reads its pipe from C runtime descriptors 3 and 4 there too
//!   (`_get_osfhandle`). A parent hands descriptors to a child's C runtime through
//!   `STARTUPINFO.lpReserved2`: an `i32` count, one flag byte per descriptor, then one `HANDLE`
//!   per descriptor, packed (`crt_fd_table`). Only the handles in the
//!   `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` are inherited, so nothing else of ours leaks.
//! - **The tree.** The process starts suspended, joins a job with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then resumes. `kill_tree` terminates the job. When
//!   this process dies the job handle closes and Windows ends every process in it.
#![allow(unsafe_code)]

use crate::cmdline::{crt_fd_table, windows_command_line};
use media_codec::CodecError;
use std::ffi::c_void;
use std::io::{Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::Path;
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    GENERIC_READ, GENERIC_WRITE, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    SetHandleInformation, WAIT_OBJECT_0,
};
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, InitializeProcThreadAttributeList,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION,
    ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

pub type Spawned = (Browser, Box<dyn Write + Send>, Box<dyn Read + Send>);

pub struct Browser {
    pid: u32,
    process: OwnedHandle,
    job: OwnedHandle,
}

fn last_error(what: &str) -> CodecError {
    CodecError::Backend(format!("{what}: {}", std::io::Error::last_os_error()))
}

fn owned(handle: HANDLE, what: &str) -> Result<OwnedHandle, CodecError> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_error(what));
    }
    // SAFETY: `handle` was just returned to us by Windows and nothing else owns it.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) })
}

fn raw(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn pipe() -> Result<(OwnedHandle, OwnedHandle), CodecError> {
    let mut read: HANDLE = std::ptr::null_mut();
    let mut write: HANDLE = std::ptr::null_mut();
    // SAFETY: both out-pointers are valid; no security attributes, so neither end inherits.
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        return Err(last_error("CreatePipe"));
    }
    Ok((
        owned(read, "pipe read end")?,
        owned(write, "pipe write end")?,
    ))
}

fn inheritable(handle: &OwnedHandle) -> Result<(), CodecError> {
    // SAFETY: a valid handle we own.
    if unsafe { SetHandleInformation(raw(handle), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
        return Err(last_error("SetHandleInformation"));
    }
    Ok(())
}

fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// An inheritable handle on `NUL`, for the child's standard streams.
fn null_device() -> Result<OwnedHandle, CodecError> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: 1,
    };
    let name = wide(std::ffi::OsStr::new("NUL"));
    // SAFETY: `name` is NUL-terminated and `attributes` outlives the call.
    let handle = unsafe {
        CreateFileW(
            name.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            &attributes,
            OPEN_EXISTING,
            0,
            std::ptr::null_mut(),
        )
    };
    owned(handle, "open NUL")
}

/// A job whose processes all end when its last handle closes.
fn kill_on_close_job() -> Result<OwnedHandle, CodecError> {
    // SAFETY: no attributes and no name.
    let job = owned(
        unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) },
        "CreateJobObject",
    )?;
    // SAFETY: a zeroed limit structure is valid; only the flag below is set.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: `limits` is the structure this information class takes, with its exact size.
    let set = unsafe {
        SetInformationJobObject(
            raw(&job),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if set == 0 {
        return Err(last_error("SetInformationJobObject"));
    }
    Ok(job)
}

/// A process-thread attribute list holding only `handles` as the inheritable set.
struct HandleList {
    buffer: Vec<usize>,
    _handles: Vec<HANDLE>,
}

impl HandleList {
    fn new(handles: Vec<HANDLE>) -> Result<Self, CodecError> {
        let mut size = 0usize;
        // SAFETY: the sizing call; it fails with ERROR_INSUFFICIENT_BUFFER and sets `size`.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let mut list = Self {
            buffer: vec![0usize; size.div_ceil(std::mem::size_of::<usize>()).max(1)],
            _handles: handles,
        };
        // SAFETY: the buffer is at least `size` bytes and pointer-aligned.
        if unsafe { InitializeProcThreadAttributeList(list.pointer(), 1, 0, &mut size) } == 0 {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        // SAFETY: the handle array lives in `self` as long as the list does.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list.pointer(),
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                list._handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val(list._handles.as_slice()),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if updated == 0 {
            return Err(last_error("UpdateProcThreadAttribute"));
        }
        Ok(list)
    }

    fn pointer(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
}

impl Drop for HandleList {
    fn drop(&mut self) {
        // SAFETY: initialised in `new` (a failed init leaves a zeroed buffer, which is harmless).
        unsafe { DeleteProcThreadAttributeList(self.pointer()) };
    }
}

pub fn spawn(executable: &Path, args: Vec<String>) -> Result<Spawned, CodecError> {
    let (chrome_reads, ours_writes) = pipe()?;
    let (ours_reads, chrome_writes) = pipe()?;
    inheritable(&chrome_reads)?;
    inheritable(&chrome_writes)?;
    let null = null_device()?;
    let fds = [
        raw(&null) as usize,
        raw(&null) as usize,
        raw(&null) as usize,
        raw(&chrome_reads) as usize,
        raw(&chrome_writes) as usize,
    ];
    let mut table = crt_fd_table(&fds);
    let mut list = HandleList::new(vec![raw(&null), raw(&chrome_reads), raw(&chrome_writes)])?;
    let job = kill_on_close_job()?;

    // SAFETY: a zeroed STARTUPINFOEXW is valid; the fields below are filled in.
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = raw(&null);
    startup.StartupInfo.hStdOutput = raw(&null);
    startup.StartupInfo.hStdError = raw(&null);
    startup.StartupInfo.cbReserved2 = table.len() as u16;
    startup.StartupInfo.lpReserved2 = table.as_mut_ptr();
    startup.lpAttributeList = list.pointer();

    let application = wide(executable.as_os_str());
    let mut line: Vec<u16> = windows_command_line(&executable.to_string_lossy(), &args)
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: a zeroed PROCESS_INFORMATION is valid output space.
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every pointer is valid for the call; `line` is mutable as CreateProcessW requires;
    // `table`, `list` and the handles it names outlive the call.
    let created = unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_NO_WINDOW
                | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            std::ptr::null(),
            &startup.StartupInfo,
            &mut info,
        )
    };
    if created == 0 {
        return Err(last_error("Chrome failed to start"));
    }
    let process = owned(info.hProcess, "process handle")?;
    let thread = owned(info.hThread, "thread handle")?;
    // SAFETY: both handles are valid; the process is suspended until ResumeThread.
    if unsafe { AssignProcessToJobObject(raw(&job), raw(&process)) } == 0 {
        let error = last_error("AssignProcessToJobObject");
        // SAFETY: the job holds nothing else.
        unsafe { TerminateJobObject(raw(&job), 1) };
        let browser = Browser {
            pid: info.dwProcessId,
            process,
            job,
        };
        browser.terminate_process();
        return Err(error);
    }
    // SAFETY: the main thread of the suspended process we created.
    unsafe { ResumeThread(raw(&thread)) };
    drop((chrome_reads, chrome_writes, null, thread, list));
    let writer = std::fs::File::from(ours_writes);
    let reader = std::fs::File::from(ours_reads);
    Ok((
        Browser {
            pid: info.dwProcessId,
            process,
            job,
        },
        Box::new(writer),
        Box::new(reader),
    ))
}

impl Browser {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn exited(&self) -> bool {
        self.wait(Duration::ZERO)
    }

    pub fn wait(&self, timeout: Duration) -> bool {
        let millis = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX - 1);
        // SAFETY: a valid process handle.
        unsafe { WaitForSingleObject(raw(&self.process), millis) == WAIT_OBJECT_0 }
    }

    /// Ends every process in the browser's job.
    pub fn kill_tree(&self) {
        // SAFETY: a valid job handle.
        unsafe { TerminateJobObject(raw(&self.job), 1) };
    }

    fn terminate_process(&self) {
        // SAFETY: a valid process handle.
        unsafe { windows_sys::Win32::System::Threading::TerminateProcess(raw(&self.process), 1) };
    }
}

/// The process is still running.
pub fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::STILL_ACTIVE;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: a query-only open of a process id; the handle is owned below.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    let Ok(handle) = owned(handle, "OpenProcess") else {
        return false;
    };
    let mut code = 0u32;
    // SAFETY: a valid process handle and out-pointer.
    let read = unsafe { GetExitCodeProcess(raw(&handle), &mut code) };
    read != 0 && code == STILL_ACTIVE as u32
}
