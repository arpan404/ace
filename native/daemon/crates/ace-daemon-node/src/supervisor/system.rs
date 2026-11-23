// SPDX-License-Identifier: Apache-2.0
//! Windows command mapping and tree stops, the private-directory sweep, and
//! the daemon's own process-group and subreaper setup.

use super::{bind_error, guarded, input_error, quote};
use ace_supervisor::{dir, owner, reaper};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// Maps one program through `cmd.exe` on Windows; passes others through.
#[napi(catch_unwind)]
pub fn supervisor_to_windows_command(command: String, args: Vec<String>) -> napi::Result<String> {
    guarded("supervisor windows command", || {
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let mapped = owner::to_windows_command(&command, &borrowed)
            .map_err(ace_supervisor::errors::SupervisorError::InvalidInput)
            .map_err(bind_error)?;
        let args: Vec<String> = mapped.args.iter().map(|arg| quote(arg)).collect();
        Ok(format!(
            "{{\"command\":{},\"args\":[{}],\"verbatim\":{}}}",
            quote(&mapped.command),
            args.join(","),
            mapped.verbatim
        ))
    })
}

/// A file in Windows' own System32, located by the kernel.
#[napi(catch_unwind)]
pub fn supervisor_windows_system_executable(name: String) -> napi::Result<String> {
    guarded("supervisor system executable", || {
        #[cfg(windows)]
        {
            owner::windows_system_executable(&name).map_err(bind_error)
        }
        #[cfg(not(windows))]
        {
            let _ = name;
            Err(napi::Error::from_reason(
                "Windows system executables need Windows",
            ))
        }
    })
}

/// Whole-tree stop on Windows, where process groups do not exist.
#[napi(catch_unwind)]
pub fn supervisor_kill_windows_tree(pid: u32, force: bool) -> napi::Result<()> {
    guarded("supervisor kill windows tree", || {
        #[cfg(windows)]
        {
            ace_supervisor::stop::kill_windows_tree(pid, force).map_err(bind_error)
        }
        #[cfg(not(windows))]
        {
            let _ = (pid, force);
            Err(napi::Error::from_reason("Windows tree stops need Windows"))
        }
    })
}

/// Ends every process in private directories on a thread; `done` hears
/// `"ok"` or the error message.
#[napi(catch_unwind)]
pub fn supervisor_terminate_directory_processes(
    directories_json: String,
    self_pid: u32,
    done: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    guarded("supervisor terminate directory", || {
        let directories: Vec<String> =
            serde_json::from_str(&directories_json).map_err(input_error)?;
        // The thread owns the wait; dropping the function releases it.
        std::thread::spawn(move || {
            let outcome =
                dir::terminate_directory_processes(&dir::SystemDirectoryIo, &directories, self_pid)
                    .map_or_else(|error| error.to_string(), |()| "ok".to_owned());
            let _ = done.call(Ok(outcome), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    })
}

/// Moves this process into a process group of its own.
#[napi(catch_unwind)]
pub fn supervisor_leave_process_group() -> napi::Result<bool> {
    guarded("supervisor leave group", || {
        #[cfg(unix)]
        {
            Ok(ace_supervisor::signal::leave_process_group())
        }
        #[cfg(not(unix))]
        {
            Ok(false)
        }
    })
}

/// Makes this process a child subreaper. False where the platform can't.
#[napi(catch_unwind)]
pub fn supervisor_become_subreaper() -> napi::Result<bool> {
    guarded("supervisor subreaper", || Ok(reaper::become_subreaper()))
}
