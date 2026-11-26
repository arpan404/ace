// SPDX-License-Identifier: Apache-2.0
//! A real child's last words: every byte it wrote to a piped stream before it
//! exited reaches its consumer before the exit (and the close) are reported,
//! as node's `child_process` does (`close` after both streams end).

#![cfg(unix)]

use super::spawn_child;
use crate::divert::{ChildPorts, DivertTarget, Diverted, OutputConsumer, OutputControl};
use crate::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long one probe may take before it counts as lost.
const WAIT: Duration = Duration::from_secs(20);
/// What one pump may read ahead of a full consumer (`PAUSED_READ_BYTES`):
/// the bytes the paused probes write before their last words, so the pump is
/// spent when the child's tail lands in the pipe.
const READ_AHEAD: usize = 1024 * 1024;
/// The child's last words, written after that and just before it exits.
const LAST_WORDS: &[u8] = b"last words";

/// What the consumer had of both streams when it heard one event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Seen {
    stderr: usize,
    stdout: usize,
}

/// One run of one child: each event with what its streams had delivered at
/// that moment, both streams' bytes, and the leader's end.
#[derive(Default)]
struct Log {
    events: Mutex<Vec<(String, Seen)>>,
    stdout: Mutex<Vec<u8>>,
    stderr: Mutex<Vec<u8>>,
    exit: Mutex<Option<RawExit>>,
}

impl Log {
    fn push(&self, event: &str) {
        let seen = Seen {
            stderr: self.stderr.lock().expect("the stderr locks").len(),
            stdout: self.stdout.lock().expect("the stdout locks").len(),
        };
        self.events
            .lock()
            .expect("the event log locks")
            .push((event.to_owned(), seen));
    }

    fn names(&self) -> Vec<String> {
        self.events
            .lock()
            .expect("the event log locks")
            .iter()
            .map(|(event, _)| event.clone())
            .collect()
    }

    /// What the consumer had of both streams when it heard `event`.
    fn seen_at(&self, event: &str) -> Option<Seen> {
        self.events
            .lock()
            .expect("the event log locks")
            .iter()
            .find(|(name, _)| name == event)
            .map(|(_, seen)| *seen)
    }

    fn stdout(&self) -> Vec<u8> {
        self.stdout.lock().expect("the stdout locks").clone()
    }

    fn stderr(&self) -> Vec<u8> {
        self.stderr.lock().expect("the stderr locks").clone()
    }
}

/// The shell's side: a diverted child's shell hears only ends and exits.
#[derive(Clone)]
struct Shell;

impl EventSink for Shell {
    fn output(&self, _stream: OutputStream, _bytes: Vec<u8>, delivered: Delivered) {
        delivered.taken(true);
    }
    fn end(&self, _stream: OutputStream) {}
    fn exit(&self, _exit: RawExit) {}
    fn close(&self, _exit: RawExit) {}
    fn stdin_written(&self) {}
    fn stdin_error(&self, _error: crate::errors::NodeIoError) {}
    fn hold_limit(&self) {}
    fn held(&self, _message: String) {}
}

/// A consumer that records what it heard; `paused` is a session queue at its
/// bound, whose chunks are answered "no more" so the pump pauses.
struct Recorder {
    log: Arc<Log>,
    paused: AtomicBool,
    /// The child's controls, which a session's read gate holds too.
    output: OnceLock<OutputControl>,
}

impl Recorder {
    fn new(paused: bool) -> Arc<Self> {
        Arc::new(Self {
            log: Arc::new(Log::default()),
            paused: AtomicBool::new(paused),
            output: OnceLock::new(),
        })
    }
}

impl OutputConsumer for Recorder {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        match stream {
            OutputStream::Stdout => {
                self.log.push("stdout");
                self.log
                    .stdout
                    .lock()
                    .expect("the stdout locks")
                    .extend_from_slice(&bytes);
            }
            OutputStream::Stderr => {
                self.log.push("stderr");
                self.log
                    .stderr
                    .lock()
                    .expect("the stderr locks")
                    .extend_from_slice(&bytes);
            }
        }
        delivered.taken(!self.paused.load(Ordering::SeqCst));
    }

    fn end(&self, stream: OutputStream) {
        match stream {
            OutputStream::Stdout => self.log.push("end-stdout"),
            OutputStream::Stderr => self.log.push("end-stderr"),
        }
    }

    fn stdin_written(&self) {}

    fn stdin_error(&self, _error: crate::errors::NodeIoError) {}

    fn exit(&self, exit: RawExit) {
        *self.log.exit.lock().expect("the exit locks") = Some(exit);
        self.log.push("exit");
        // What a session's read gate does on the leader's end: read on to EOF.
        if let Some(output) = self.output.get() {
            output.resume(OutputStream::Stdout);
            output.resume(OutputStream::Stderr);
        }
    }

    fn close(&self, exit: RawExit) {
        *self.log.exit.lock().expect("the exit locks") = Some(exit);
        self.log.push("close");
    }
}

/// The spawn a probe runs with: `sh` running `script`, both outputs piped.
fn spec(script: &str) -> SpawnSpec {
    let mut environment = vec![(
        "PATH".to_owned(),
        std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin".to_owned()),
    )];
    if let Ok(home) = std::env::var("HOME") {
        environment.push(("HOME".to_owned(), home));
    }
    SpawnSpec {
        command: "sh".to_owned(),
        args: vec!["-c".to_owned(), script.to_owned()],
        cwd: None,
        env: environment,
        windows_verbatim: false,
        hide_window: true,
        contain: false,
        max_output_bytes: None,
        stdin: StdioMode::Ignore,
        stdout: StdioMode::Piped,
        stderr: StdioMode::Piped,
    }
}

/// Runs `script` with its pipes diverted to a recorder, and waits for the
/// child's `close` (or the deadline). The runtime stays alive with the child.
fn run(script: &str, paused: bool) -> (Arc<Recorder>, tokio::runtime::Runtime) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("the test runtime builds");
    let recorder = Recorder::new(paused);
    let consumer: Arc<dyn OutputConsumer> = Arc::clone(&recorder) as Arc<dyn OutputConsumer>;
    let ports: Arc<OnceLock<ChildPorts>> = Arc::new(OnceLock::new());
    let _child = spawn_child(
        &spec(script),
        Diverted::new(Shell, Arc::clone(&consumer)),
        runtime.handle(),
        Some(&DivertTarget {
            consumer,
            ports: Arc::clone(&ports),
        }),
    )
    .expect("the probe spawns");
    // The spawn fills the ports before it returns; the gate gains its controls then.
    if let Some(child_ports) = ports.get() {
        let _ = recorder.output.set(child_ports.output.clone());
    }
    let deadline = Instant::now() + WAIT;
    while recorder.log.seen_at("close").is_none() {
        assert!(
            Instant::now() < deadline,
            "the child's close never arrived: {:?}",
            recorder.log.names()
        );
        std::thread::sleep(Duration::from_millis(1));
    }
    (recorder, runtime)
}

/// Both streams are whole, and the exit and the close came after every byte.
fn assert_every_byte_before_exit(recorder: &Recorder, stderr_bytes: usize, stdout_bytes: usize) {
    let stderr = recorder.log.stderr();
    let stdout = recorder.log.stdout();
    assert_eq!(
        (stderr.len(), stdout.len()),
        (stderr_bytes, stdout_bytes),
        "the consumer lost bytes: {:?}",
        recorder.log.names()
    );
    let whole = Seen {
        stderr: stderr_bytes,
        stdout: stdout_bytes,
    };
    assert_eq!(
        recorder.log.seen_at("exit"),
        Some(whole),
        "the exit was reported before the bytes the child wrote: {:?}",
        recorder.log.names()
    );
    assert_eq!(
        recorder.log.seen_at("close"),
        Some(whole),
        "the close was reported before the bytes the child wrote: {:?}",
        recorder.log.names()
    );
}

/// A diagnostic line with its newline, delivered before the exit it follows.
#[test]
fn a_childs_last_stderr_reaches_the_consumer_before_its_exit() {
    let (recorder, _runtime) = run("printf 'last words\\n' >&2; exit 3", false);
    assert_eq!(recorder.log.stderr(), b"last words\n");
    assert_every_byte_before_exit(&recorder, 11, 0);
    assert_eq!(
        *recorder.log.exit.lock().expect("the exit locks"),
        Some(RawExit {
            code: Some(3),
            signal: None
        })
    );
}

/// No trailing newline: the write is still one write, and it still arrives.
#[test]
fn a_last_stderr_without_a_newline_reaches_the_consumer_before_its_exit() {
    let (recorder, _runtime) = run("printf 'last words' >&2; exit 3", false);
    assert_eq!(recorder.log.stderr(), LAST_WORDS);
    assert_every_byte_before_exit(&recorder, LAST_WORDS.len(), 0);
}

/// A large final write, past the pump's in-flight chunks and the pipe's size.
#[test]
fn a_large_last_stderr_reaches_the_consumer_before_its_exit() {
    let (recorder, _runtime) = run(
        "dd if=/dev/zero bs=65536 count=16 2>/dev/null | tr '\\0' 'x' >&2; \
         printf 'last words' >&2; exit 3",
        false,
    );
    assert!(recorder.log.stderr().ends_with(LAST_WORDS));
    assert_every_byte_before_exit(&recorder, 16 * 64 * 1024 + LAST_WORDS.len(), 0);
}

/// The proof's case: the pump has spent its whole read-ahead while its
/// consumer is paused (a session queue at its bound), so the child's last
/// stderr is still in the pipe when the leader ends. It must reach the
/// consumer before the exit is reported.
///
/// One byte, then a pause: that byte is the pump's only flowing read, so the
/// read-ahead is exactly `PAUSED_READ_BYTES` after it, and the pipe's last
/// words are never read. The sleeps let each step land before the next.
#[test]
fn a_last_stderr_that_lands_while_the_consumer_is_paused_precedes_the_exit() {
    let (recorder, _runtime) = run(
        "printf 'x' >&2; sleep 0.3; \
         dd if=/dev/zero bs=4096 count=256 2>/dev/null | tr '\\0' ' ' >&2; \
         sleep 0.3; printf 'last words' >&2; exit 3",
        true,
    );
    assert!(recorder.log.stderr().ends_with(LAST_WORDS));
    assert_every_byte_before_exit(&recorder, 1 + READ_AHEAD + LAST_WORDS.len(), 0);
}

/// The same for stdout, with a consumer that is paused throughout.
#[test]
fn a_childs_last_stdout_reaches_the_consumer_before_its_exit() {
    let (recorder, _runtime) = run(
        "printf 'x'; sleep 0.3; \
         dd if=/dev/zero bs=4096 count=256 2>/dev/null | tr '\\0' ' ' ; \
         sleep 0.3; printf 'last words'; exit 3",
        true,
    );
    assert!(recorder.log.stdout().ends_with(LAST_WORDS));
    assert_every_byte_before_exit(&recorder, 0, 1 + READ_AHEAD + LAST_WORDS.len());
}

/// The three shapes above, two hundred times each: the last words always
/// arrive before the exit, never by luck.
#[test]
fn two_hundred_runs_deliver_the_last_words_before_the_exit() {
    for attempt in 0..200 {
        for (script, tail) in [
            ("printf 'last words\\n' >&2; exit 3", &b"last words\n"[..]),
            ("printf 'last words' >&2; exit 3", LAST_WORDS),
            (
                "dd if=/dev/zero bs=65536 count=16 2>/dev/null | tr '\\0' 'x' >&2; \
                 printf 'last words' >&2; exit 3",
                LAST_WORDS,
            ),
        ] {
            let (recorder, runtime) = run(script, false);
            assert!(
                recorder.log.stderr().ends_with(tail),
                "run {attempt} lost the last words: {:?}",
                recorder.log.names()
            );
            assert_eq!(
                recorder.log.seen_at("exit"),
                Some(Seen {
                    stderr: recorder.log.stderr().len(),
                    stdout: 0
                }),
                "run {attempt} reported the exit before the stderr: {:?}",
                recorder.log.names()
            );
            drop(runtime);
        }
    }
}
