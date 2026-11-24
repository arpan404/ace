// SPDX-License-Identifier: Apache-2.0
//! A supervised child behind a handle the shell holds: the spec crosses as
//! JSON, events come back in order on one threadsafe function, and the
//! shell's answers (a stream that is full, an exit it has heard) go back to
//! the crate. Behaviour lives in `ace_supervisor::child`.

use super::{bind_error, guarded, input_error, runtime};
use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use napi::bindgen_prelude::{FnArgs, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::sync::Arc;

/// The shell's event listener: `(kind, data)`; for output it returns
/// whether its stream wants more.
type Events = ThreadsafeFunction<FnArgs<(String, Uint8Array)>, Option<bool>>;

#[derive(Clone)]
struct TsfnSink {
    events: Arc<Events>,
}

impl TsfnSink {
    fn send(&self, kind: &str, data: Vec<u8>) {
        let _ = self.events.call(
            Ok(FnArgs::from((kind.to_owned(), Uint8Array::new(data)))),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

fn exit_json(exit: &RawExit) -> Vec<u8> {
    let code = exit
        .code
        .map_or_else(|| "null".to_owned(), |code| code.to_string());
    let signal = exit
        .signal
        .as_ref()
        .map_or_else(|| "null".to_owned(), |signal| format!("\"{signal}\""));
    format!("{{\"code\":{code},\"signal\":{signal}}}").into_bytes()
}

impl EventSink for TsfnSink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        let kind = match stream {
            OutputStream::Stdout => "stdout",
            OutputStream::Stderr => "stderr",
        };
        // The answer runs on the JS thread right after the listener; a
        // listener that throws stays an uncaught exception.
        let _ = self.events.call_with_return_value(
            Ok(FnArgs::from((kind.to_owned(), Uint8Array::new(bytes)))),
            ThreadsafeFunctionCallMode::NonBlocking,
            move |more, _env| {
                let more = more?;
                delivered.taken(more.unwrap_or(true));
                Ok(())
            },
        );
    }

    fn end(&self, stream: OutputStream) {
        let kind = match stream {
            OutputStream::Stdout => "stdout-end",
            OutputStream::Stderr => "stderr-end",
        };
        self.send(kind, Vec::new());
    }

    fn exit(&self, exit: RawExit) {
        self.send("exit", exit_json(&exit));
    }

    fn close(&self, exit: RawExit) {
        self.send("close", exit_json(&exit));
    }

    fn stdin_written(&self) {
        self.send("stdin-written", Vec::new());
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.send("stdin-error", error.to_json().into_bytes());
    }

    fn hold_limit(&self) {
        self.send("hold-limit", Vec::new());
    }

    fn held(&self, message: String) {
        self.send("held", message.into_bytes());
    }
}

/// A spawn request from the shell. `env` is the child's whole environment.
#[derive(Debug, serde::Deserialize)]
struct SpecJson {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
    #[serde(default)]
    verbatim: bool,
    #[serde(default = "yes")]
    hide: bool,
    #[serde(default)]
    contain: bool,
    #[serde(default)]
    max_output_bytes: Option<u64>,
    stdin: String,
    stdout: String,
    stderr: String,
}

fn yes() -> bool {
    true
}

fn stdio_mode(name: &str) -> napi::Result<StdioMode> {
    match name {
        "piped" => Ok(StdioMode::Piped),
        "ignore" => Ok(StdioMode::Ignore),
        "inherit" => Ok(StdioMode::Inherit),
        "stderr" => Ok(StdioMode::ToStderr),
        other => Err(napi::Error::from_reason(format!(
            "unknown stdio mode {other}"
        ))),
    }
}

fn stream(kind: &str) -> napi::Result<OutputStream> {
    match kind {
        "stdout" => Ok(OutputStream::Stdout),
        "stderr" => Ok(OutputStream::Stderr),
        other => Err(napi::Error::from_reason(format!("unknown stream {other}"))),
    }
}

/// Spawns a supervised child; its events arrive on `events` in order.
#[napi(catch_unwind)]
pub fn supervisor_spawn(spec_json: String, events: Events) -> napi::Result<NativeChild> {
    guarded("supervisor spawn", || {
        let spec: SpecJson = serde_json::from_str(&spec_json).map_err(input_error)?;
        let spec = SpawnSpec {
            command: spec.command,
            args: spec.args,
            cwd: spec.cwd,
            env: spec.env,
            windows_verbatim: spec.verbatim,
            hide_window: spec.hide,
            contain: spec.contain,
            max_output_bytes: spec.max_output_bytes,
            stdin: stdio_mode(&spec.stdin)?,
            stdout: stdio_mode(&spec.stdout)?,
            stderr: stdio_mode(&spec.stderr)?,
        };
        let sink = TsfnSink {
            events: Arc::new(events),
        };
        let child = spawn_child(&spec, sink, runtime()?.handle()).map_err(bind_error)?;
        Ok(NativeChild { child })
    })
}

/// A supervised child behind a handle the shell holds.
#[napi]
pub struct NativeChild {
    child: SupervisedChild,
}

#[napi]
impl NativeChild {
    /// The leader's pid.
    #[napi(catch_unwind)]
    pub fn pid(&self) -> napi::Result<u32> {
        guarded("supervisor child pid", || Ok(self.child.pid()))
    }

    /// Queues stdin bytes; `stdin-written` follows once they are in the pipe.
    #[napi(catch_unwind)]
    pub fn write_stdin(&self, data: Uint8Array) -> napi::Result<()> {
        guarded("supervisor stdin write", || {
            self.child.write_stdin(data.to_vec()).map_err(bind_error)
        })
    }

    /// EOF after every queued write.
    #[napi(catch_unwind)]
    pub fn end_stdin(&self) -> napi::Result<()> {
        guarded("supervisor stdin end", || {
            self.child.end_stdin();
            Ok(())
        })
    }

    /// Closes stdin now: the shell destroyed it.
    #[napi(catch_unwind)]
    pub fn abort_stdin(&self) -> napi::Result<()> {
        guarded("supervisor stdin abort", || {
            self.child.abort_stdin();
            Ok(())
        })
    }

    /// The shell's `kind` stream wants more.
    #[napi(catch_unwind)]
    pub fn resume_output(&self, kind: String) -> napi::Result<()> {
        guarded("supervisor output resume", || {
            self.child.resume_output(stream(&kind)?);
            Ok(())
        })
    }

    /// The shell destroyed its `kind` stream: its pump stops.
    #[napi(catch_unwind)]
    pub fn close_output(&self, kind: String) -> napi::Result<()> {
        guarded("supervisor output close", || {
            self.child.close_output(stream(&kind)?);
            Ok(())
        })
    }

    /// Signals the leader through its own handle; false once it is reaped.
    #[napi(catch_unwind)]
    pub fn kill(&self, signal: String) -> napi::Result<bool> {
        guarded("supervisor child kill", || {
            let signal = SignalName::parse(&signal).map_err(bind_error)?;
            Ok(self.child.kill(signal))
        })
    }

    /// Signals the whole group while its id is provably this tree's:
    /// `"sent"`, `"gone"`, or `"released"` (nothing sent: the group emptied
    /// and its id may be someone else's now).
    #[napi(catch_unwind)]
    pub fn signal_group(&self, signal: String) -> napi::Result<String> {
        guarded("supervisor group signal", || {
            let signal = SignalName::parse(&signal).map_err(bind_error)?;
            #[cfg(unix)]
            {
                use ace_supervisor::leader::GroupSignal;
                Ok(match self.child.signal_group(signal).map_err(bind_error)? {
                    GroupSignal::Sent => "sent",
                    GroupSignal::Gone => "gone",
                    GroupSignal::Released => "released",
                }
                .to_owned())
            }
            #[cfg(not(unix))]
            {
                let _ = signal;
                Err(napi::Error::from_reason(
                    "process groups do not exist on Windows",
                ))
            }
        })
    }

    /// Whether nothing of the group runs any more.
    #[napi(catch_unwind)]
    pub fn group_gone(&self) -> napi::Result<bool> {
        guarded("supervisor group probe", || Ok(self.child.group_gone()))
    }

    /// The leader's kernel start, read at spawn: the identity its group is
    /// owned by.
    #[napi(catch_unwind)]
    pub fn leader_start(&self) -> napi::Result<Option<String>> {
        guarded("supervisor leader start", || Ok(self.child.leader_start()))
    }

    /// The shell gave the group up: the hold limit starts; release still
    /// waits for the group to be confirmed empty.
    #[napi(catch_unwind)]
    pub fn disown(&self) -> napi::Result<()> {
        guarded("supervisor group disown", || {
            self.child.disown();
            Ok(())
        })
    }

    /// Starts a stop: true while the group id is still this tree's, and the
    /// leader stays held until `unhold`. False once released.
    #[napi(catch_unwind)]
    pub fn hold(&self) -> napi::Result<bool> {
        guarded("supervisor group hold", || Ok(self.child.hold()))
    }

    /// Ends a stop started with `hold`.
    #[napi(catch_unwind)]
    pub fn unhold(&self) -> napi::Result<()> {
        guarded("supervisor group unhold", || {
            self.child.unhold();
            Ok(())
        })
    }

    /// Releases the pipes; the leader stays held while its group may still
    /// be signalled.
    #[napi(catch_unwind)]
    pub fn dispose(&self) -> napi::Result<()> {
        guarded("supervisor dispose", || {
            self.child.dispose();
            Ok(())
        })
    }

    /// Whether the child joined a kernel job before it ran. Windows only.
    #[napi(catch_unwind)]
    pub fn has_job(&self) -> napi::Result<bool> {
        guarded("supervisor job", || {
            #[cfg(windows)]
            {
                Ok(self.child.job().is_some())
            }
            #[cfg(not(windows))]
            {
                Ok(false)
            }
        })
    }

    /// Whether the job still has members; undefined when nothing joined.
    #[napi(catch_unwind)]
    pub fn job_running(&self) -> napi::Result<Option<bool>> {
        guarded("supervisor job running", || {
            #[cfg(windows)]
            {
                use ace_supervisor::contain::{JobRunning, WindowsJob as _};
                let Some(job) = self.child.job() else {
                    return Ok(None);
                };
                let Ok(mut job) = job.lock() else {
                    return Ok(None);
                };
                Ok(match job.running() {
                    JobRunning::Running(alive) => Some(alive),
                    JobRunning::Unjoined | JobRunning::Closed | JobRunning::Unreadable => None,
                })
            }
            #[cfg(not(windows))]
            {
                Ok(None)
            }
        })
    }

    /// Ends every job member now; never throws.
    #[napi(catch_unwind)]
    pub fn job_terminate(&self) -> napi::Result<()> {
        guarded("supervisor job terminate", || {
            #[cfg(windows)]
            {
                use ace_supervisor::contain::WindowsJob as _;
                if let Some(job) = self.child.job()
                    && let Ok(mut job) = job.lock()
                {
                    job.terminate();
                }
            }
            Ok(())
        })
    }

    /// Closes the job: the kernel ends whatever is still in it.
    #[napi(catch_unwind)]
    pub fn job_dispose(&self) -> napi::Result<()> {
        guarded("supervisor job dispose", || {
            #[cfg(windows)]
            {
                use ace_supervisor::contain::WindowsJob as _;
                if let Some(job) = self.child.job()
                    && let Ok(mut job) = job.lock()
                {
                    job.dispose();
                }
            }
            Ok(())
        })
    }
}
