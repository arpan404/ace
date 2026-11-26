// SPDX-License-Identifier: Apache-2.0

//! The production helper start (`client.ts:255`): every helper is spawned through
//! `ace-supervisor`, so it joins the daemon's process inventory and containment. The helper is
//! still its own native process (Swift on macOS, Rust on Windows and Linux); nothing links it in.

use std::sync::Arc;

use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::errors::{NodeIoError, SupervisorError};
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};

use super::client::Spawner;
use super::connection::{ChildEvents, HelperProcess};
use crate::error::ComputerError;

/// One supervised helper process, as the connection drives it (`HelperProcess`).
pub struct SupervisedHelper {
    child: SupervisedChild,
    /// Where a write that no longer reaches the helper is reported (`:344`-`:351`).
    events: Arc<dyn ChildEvents>,
}

impl HelperProcess for SupervisedHelper {
    fn pid(&self) -> u32 {
        self.child.pid()
    }

    fn write(&self, bytes: Vec<u8>) {
        // A pipe that closed mid-write (the helper exited) makes it unusable: the connection
        // hears it now, not only when the exit is reported (`helper-connection.ts:344`).
        if self.child.write_stdin(bytes).is_err() {
            self.events.stdin_error();
        }
    }

    fn end_stdin(&self) {
        self.child.end_stdin();
    }

    fn kill(&self, signal: SignalName) -> bool {
        self.child.kill(signal)
    }
}

/// A helper's streams into its connection (`ChildEvents`).
#[derive(Clone)]
struct Sink {
    events: Arc<dyn ChildEvents>,
}

impl EventSink for Sink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        if stream == OutputStream::Stdout {
            self.events.output(bytes);
        }
        // The connection splits and parses as it goes; it is never back-pressured.
        delivered.taken(true);
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, _exit: RawExit) {
        self.events.exit();
    }

    fn close(&self, _exit: RawExit) {}

    fn stdin_written(&self) {}

    fn stdin_error(&self, _error: NodeIoError) {
        self.events.stdin_error();
    }

    fn hold_limit(&self) {}

    fn held(&self, _message: String) {}
}

/// Starts helpers with one command line and environment read per start
/// (`client.ts:33`, `:171`). The pool passes the helper's path, arguments and environment; this
/// adds the supervisor's own process shape.
pub fn supervised_spawner(
    handle: tokio::runtime::Handle,
    cwd: Option<String>,
    contain: bool,
) -> Spawner {
    Arc::new(move |command, args, environment, events| {
        let spec = SpawnSpec {
            command,
            args,
            cwd: cwd.clone(),
            env: environment,
            windows_verbatim: false,
            hide_window: true,
            // Windows: the helper joins a kill-on-close job before it runs (E2).
            contain,
            max_output_bytes: None,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        };
        let sink = Sink {
            events: Arc::clone(&events),
        };
        match spawn_child(&spec, sink, &handle, None) {
            Ok(child) => Ok(Box::new(SupervisedHelper { child, events }) as Box<dyn HelperProcess>),
            Err(error) => Err(start_error(&error)),
        }
    })
}

/// A start the supervisor refused, as the model reads it (`helper-connection.ts:219`-`:225`).
fn start_error(error: &SupervisorError) -> ComputerError {
    ComputerError::helper_unavailable_with(&error.to_string())
}
