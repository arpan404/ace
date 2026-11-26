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
        self.stop_signal(signal)
    }
}

impl SupervisedHelper {
    /// Stop the helper's whole process group: a descendant that survives its leader can still
    /// hold the wire or act on the screen, so the stop must reach it too
    /// (`helper-connection.ts:430`-`:468`, through `ace-supervisor`'s held group).
    pub fn stop_signal(&self, signal: SignalName) -> bool {
        #[cfg(unix)]
        {
            match self.child.signal_group(signal) {
                // The group is ours and took it; `Gone` means nothing is left to take it.
                Ok(ace_supervisor::leader::GroupSignal::Sent)
                | Ok(ace_supervisor::leader::GroupSignal::Gone) => true,
                // The leader was released (its group id may be reused): its own handle is the
                // only safe target left.
                Ok(ace_supervisor::leader::GroupSignal::Released) => self.child.kill(signal),
                Err(_) => false,
            }
        }
        #[cfg(not(unix))]
        {
            // Windows has no groups: the job object holds the tree (E2's containment).
            self.child.kill(signal)
        }
    }

    /// Whether nothing of the helper's group runs any more (`ace-supervisor`).
    pub fn group_gone(&self) -> bool {
        self.child.group_gone()
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
        supervised_helper(spec, events, &handle)
            .map(|helper| Box::new(helper) as Box<dyn HelperProcess>)
    })
}

/// Spawn one supervised helper with the supervisor's own process shape.
fn supervised_helper(
    spec: SpawnSpec,
    events: Arc<dyn ChildEvents>,
    handle: &tokio::runtime::Handle,
) -> Result<SupervisedHelper, ComputerError> {
    let sink = Sink {
        events: Arc::clone(&events),
    };
    match spawn_child(&spec, sink, handle, None) {
        Ok(child) => Ok(SupervisedHelper { child, events }),
        Err(error) => Err(start_error(&error)),
    }
}

/// A start the supervisor refused, as the model reads it (`helper-connection.ts:219`-`:225`).
fn start_error(error: &SupervisorError) -> ComputerError {
    ComputerError::helper_unavailable_with(&error.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use ace_supervisor::signal::SignalName;

    use super::SpawnSpec;
    use super::supervised_helper;
    use crate::computer::connection::ChildEvents;
    use ace_supervisor::spawn::{EventSink, OutputStream, RawExit, StdioMode};

    /// A sink that keeps nothing: these tests read the process group, not the wire.
    struct Quiet;

    impl ChildEvents for Quiet {
        fn output(&self, _bytes: Vec<u8>) {}
        fn exit(&self) {}
        fn stdin_error(&self) {}
    }

    impl EventSink for Quiet {
        fn output(
            &self,
            _stream: OutputStream,
            _bytes: Vec<u8>,
            _delivered: ace_supervisor::spawn::Delivered,
        ) {
        }
        fn end(&self, _stream: OutputStream) {}
        fn exit(&self, _exit: RawExit) {}
        fn close(&self, _exit: RawExit) {}
        fn stdin_written(&self) {}
        fn stdin_error(&self, _error: ace_supervisor::errors::NodeIoError) {}
        fn hold_limit(&self) {}
        fn held(&self, _message: String) {}
    }

    fn shell(script: &str) -> SpawnSpec {
        SpawnSpec {
            command: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), script.to_owned()],
            cwd: None,
            env: vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())],
            windows_verbatim: false,
            hide_window: true,
            contain: false,
            max_output_bytes: None,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        }
    }

    /// A helper's stop reaches its whole process group, not only the leader: a descendant that
    /// outlives the leader would otherwise keep running and hold the wire (`helper-connection.ts`
    /// `:430`-`:468`; the supervisor's group signal).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_stop_signals_the_helpers_whole_process_group() {
        // The shell forks a grandchild and waits: with a leader-only signal the grandchild
        // would stay in the group for its full sleep.
        let helper = supervised_helper(
            shell("sleep 30 & wait"),
            Arc::new(Quiet),
            &tokio::runtime::Handle::current(),
        )
        .unwrap_or_else(|error| panic!("{error}"));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!helper.group_gone(), "the grandchild runs");
        assert!(
            helper.stop_signal(SignalName::Term),
            "the group took SIGTERM"
        );
        for _ in 0..300 {
            if helper.group_gone() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let _ = helper.stop_signal(SignalName::Kill);
        panic!("the helper's grandchild outlived the stop");
    }
}
