// SPDX-License-Identifier: Apache-2.0
//! Test-only SQLite scratch files and inventory fakes for the suites that
//! prove the inventory and its recovery. Never compiled into the addon.
#![cfg(test)]

use crate::errors::SupervisorError;
use crate::identity::{ProcessIdentity, ProcessOwner};
use crate::inventory::{InventoryRuntime, ProbeRefused};
use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A scratch directory, removed when the test ends. std only.
pub struct Scratch {
    path: std::path::PathBuf,
}

impl Scratch {
    /// Creates a fresh scratch directory.
    #[allow(clippy::new_without_default)]
    pub fn new() -> Self {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ace-supervisor-inventory-{id}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("scratch dir creates");
        Self { path }
    }

    /// A database file inside the scratch directory.
    pub fn file(&self, name: &str) -> String {
        self.path.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// A fake inventory runtime: scripted identities, liveness and kills.
pub struct Fake {
    /// Processes the kernel reports, by pid.
    pub processes: HashMap<u32, ProcessIdentity>,
    /// Groups the runtime was told to kill, in order.
    pub killed: Rc<RefCell<Vec<u32>>>,
    /// Scripted liveness per pid; unlisted pids answer alive.
    pub alive: HashMap<u32, Result<bool, ProbeRefused>>,
    /// Pids whose identity read throws.
    pub unreadable: Vec<u32>,
    /// Groups a process-table read still finds members in.
    pub occupied: Vec<u32>,
    /// The daemon's own pid: the owner recorded rows name.
    pub owner: u32,
}

impl Fake {
    /// Starts empty, owned by `owner`; returns the kill log with it.
    pub fn new(owner: u32) -> (Self, Rc<RefCell<Vec<u32>>>) {
        let killed = Rc::new(RefCell::new(Vec::new()));
        (
            Self {
                processes: HashMap::new(),
                killed: Rc::clone(&killed),
                alive: HashMap::new(),
                unreadable: Vec::new(),
                occupied: Vec::new(),
                owner,
            },
            killed,
        )
    }

    /// Records a running process the kernel would report.
    pub fn insert(&mut self, pid: u32, start: &str, uid: u32, group: u32) {
        self.processes.insert(
            pid,
            ProcessIdentity {
                pid,
                start: start.to_owned(),
                owner: ProcessOwner::Uid(uid),
                group,
            },
        );
    }
}

impl InventoryRuntime for Fake {
    fn identity(&self, pid: u32) -> Result<Option<ProcessIdentity>, SupervisorError> {
        if self.unreadable.contains(&pid) {
            return Err(SupervisorError::Unavailable(
                "unreadable kernel identity".to_owned(),
            ));
        }
        Ok(self.processes.get(&pid).cloned())
    }

    fn child_exited(&self, _pid: u32) -> bool {
        false
    }

    fn alive(&self, pid: u32) -> Result<bool, ProbeRefused> {
        self.alive.get(&pid).cloned().unwrap_or(Ok(true))
    }

    fn leader_alive(&self, pid: u32, _start: &str) -> Result<bool, ProbeRefused> {
        self.alive.get(&pid).cloned().unwrap_or(Ok(true))
    }

    fn group_snapshot(&self) -> crate::system::GroupSnapshot {
        let mut groups = HashMap::new();
        for group in &self.occupied {
            groups.insert(*group, BTreeSet::from([(9999, "live".to_owned())]));
        }
        crate::system::GroupSnapshot {
            groups,
            complete: true,
        }
    }

    fn kill(&self, group: u32, _start: &str) {
        self.killed.borrow_mut().push(group);
    }

    fn owner_pid(&self) -> u32 {
        self.owner
    }

    fn now_ms(&self) -> u64 {
        0
    }
}

/// A recorded process the kernel would report.
pub fn identity(pid: u32, start: &str) -> ProcessIdentity {
    ProcessIdentity {
        pid,
        start: start.to_owned(),
        owner: ProcessOwner::Uid(1000),
        group: pid,
    }
}

/// One ordered log of sink events, shared by a recording consumer and shell.
pub type Log = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

fn push(log: &Log, entry: String) {
    log.lock().expect("the event log locks").push(entry);
}

/// A Rust consumer that records every event and holds its chunks undelivered.
#[derive(Default)]
pub struct RecordingConsumer {
    pub log: Log,
    /// Chunks stay delivered until the test ends, so a pump's `in_flight` fills.
    pub held: std::sync::Mutex<Vec<crate::spawn::Delivered>>,
}

impl crate::divert::OutputConsumer for RecordingConsumer {
    fn output(
        &self,
        stream: crate::spawn::OutputStream,
        bytes: Vec<u8>,
        delivered: crate::spawn::Delivered,
    ) {
        push(
            &self.log,
            format!(
                "consumer:output:{}:{}",
                stream_name(stream),
                String::from_utf8_lossy(&bytes)
            ),
        );
        self.held.lock().expect("held chunks lock").push(delivered);
    }

    fn end(&self, stream: crate::spawn::OutputStream) {
        push(&self.log, format!("consumer:end:{}", stream_name(stream)));
    }

    fn stdin_written(&self) {
        push(&self.log, "consumer:stdin-written".to_owned());
    }

    fn stdin_error(&self, _error: crate::errors::NodeIoError) {
        push(&self.log, "consumer:stdin-error".to_owned());
    }

    fn exit(&self, _exit: crate::spawn::RawExit) {
        push(&self.log, "consumer:exit".to_owned());
    }

    fn close(&self, _exit: crate::spawn::RawExit) {
        push(&self.log, "consumer:close".to_owned());
    }
}

/// The shell behind a diverted sink: records what reaches JavaScript.
#[derive(Clone)]
pub struct RecordingShell {
    pub log: Log,
}

impl crate::spawn::EventSink for RecordingShell {
    fn output(
        &self,
        stream: crate::spawn::OutputStream,
        _bytes: Vec<u8>,
        delivered: crate::spawn::Delivered,
    ) {
        push(&self.log, format!("shell:output:{}", stream_name(stream)));
        delivered.taken(true);
    }

    fn end(&self, stream: crate::spawn::OutputStream) {
        push(&self.log, format!("shell:end:{}", stream_name(stream)));
    }

    fn exit(&self, _exit: crate::spawn::RawExit) {
        push(&self.log, "shell:exit".to_owned());
    }

    fn close(&self, _exit: crate::spawn::RawExit) {
        push(&self.log, "shell:close".to_owned());
    }

    fn stdin_written(&self) {
        push(&self.log, "shell:stdin-written".to_owned());
    }

    fn stdin_error(&self, _error: crate::errors::NodeIoError) {
        push(&self.log, "shell:stdin-error".to_owned());
    }

    fn hold_limit(&self) {
        push(&self.log, "shell:hold-limit".to_owned());
    }

    fn held(&self, _message: String) {
        push(&self.log, "shell:held".to_owned());
    }
}

/// A stream's name in the log.
pub fn stream_name(stream: crate::spawn::OutputStream) -> &'static str {
    match stream {
        crate::spawn::OutputStream::Stdout => "stdout",
        crate::spawn::OutputStream::Stderr => "stderr",
    }
}

/// A leader's clean end, as the sink reports one.
pub fn exit() -> crate::spawn::RawExit {
    crate::spawn::RawExit {
        code: Some(0),
        signal: None,
    }
}

/// A failed stdin write, as the pump reports one.
pub fn failure() -> crate::errors::NodeIoError {
    crate::errors::NodeIoError::new(
        "write",
        &std::io::Error::from(std::io::ErrorKind::BrokenPipe),
    )
}

/// A reader that never yields and never ends: a pump waits in `read`.
pub struct StalledReader {
    pub polled: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl tokio::io::AsyncRead for StalledReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        _buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        self.polled.store(true, std::sync::atomic::Ordering::SeqCst);
        std::task::Poll::Pending
    }
}

impl crate::pump::HangUp for StalledReader {
    fn hung_up(&self) -> bool {
        false
    }

    fn at_eof(&self) -> bool {
        false
    }
}

/// A reader that always has one byte: a pump fills `MAX_IN_FLIGHT` and waits.
pub struct EndlessReader;

impl tokio::io::AsyncRead for EndlessReader {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        buf.put_slice(b"x");
        std::task::Poll::Ready(Ok(()))
    }
}

impl crate::pump::HangUp for EndlessReader {
    fn hung_up(&self) -> bool {
        false
    }

    fn at_eof(&self) -> bool {
        false
    }
}

/// A current-thread runtime for one pump.
pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test runtime builds")
}
