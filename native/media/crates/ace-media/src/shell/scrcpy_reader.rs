// SPDX-License-Identifier: Apache-2.0
//! One scrcpy source's coordinating thread (D1): the handshake and stream behind
//! [`ScrcpyReaders`](super::scrcpy::ScrcpyReaders).
use super::pictures::Encoded;
use super::scrcpy::{CLOSED, Control, Dial, NOT_STARTED, ScrcpyEvent};
use super::watch::Beat;
use crate::encode::worker::Output;
use crate::scrcpy::{DEVICE_NAME_LEN, VideoStreamReader, VideoUnits, device_name, unit_frame};
use std::io::Read;
use std::net::{Shutdown, SocketAddr, TcpStream};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// How long a dial may take: the adb forward is on this machine.
const CONNECT: Duration = Duration::from_secs(2);
/// Least time between dial attempts: adb accepts a TCP connection even while nothing
/// listens on the device, then closes it, so a closed connection means not yet.
const RETRY: Duration = Duration::from_millis(100);
/// Longest a streaming read waits before the coordinator looks at control again.
const IDLE_WAIT: Duration = Duration::from_millis(20);

/// Where one source's handshake is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Connect,
    Greet,
    WaitControl,
    Metadata,
    Stream,
}

pub(crate) struct Coordinator {
    source: String,
    token: u64,
    addr: SocketAddr,
    deadline: Duration,
    control: Receiver<Control>,
    outputs: mpsc::Sender<Encoded>,
    events: mpsc::Sender<(String, u64, ScrcpyEvent)>,
    held: Arc<Mutex<Option<TcpStream>>>,
    socket: Option<TcpStream>,
    phase: Phase,
    reader: VideoStreamReader,
    units: VideoUnits,
    end: Instant,
}

impl Coordinator {
    pub(crate) fn new(
        dial: Dial,
        control: Receiver<Control>,
        outputs: mpsc::Sender<Encoded>,
        events: mpsc::Sender<(String, u64, ScrcpyEvent)>,
        held: Arc<Mutex<Option<TcpStream>>>,
    ) -> Self {
        Self {
            source: dial.source,
            token: dial.token,
            addr: dial.addr,
            deadline: dial.deadline,
            control,
            outputs,
            events,
            held,
            socket: None,
            phase: Phase::Connect,
            reader: VideoStreamReader::new(),
            units: VideoUnits::new(),
            end: Instant::now() + dial.deadline,
        }
    }

    /// The handshake's time left, if any.
    fn remaining(&self) -> Option<Duration> {
        let now = Instant::now();
        if now >= self.end {
            return None;
        }
        Some(self.end - now)
    }

    fn send(&self, output: Output) -> bool {
        self.outputs
            .blocking_send((self.source.clone(), self.token, output))
            .is_ok()
    }

    fn event(&self, event: ScrcpyEvent) -> bool {
        self.events
            .blocking_send((self.source.clone(), self.token, event))
            .is_ok()
    }

    /// What control says, if anything. A dial restarts the handshake at its tunnel; anything
    /// else ends this one.
    fn control(&mut self) -> Option<Control> {
        self.control.try_recv().ok()
    }

    /// Drops the socket and starts the handshake over at `addr`, under a fresh deadline.
    fn redial(&mut self, host: &str, port: u32) {
        self.close_socket();
        self.reader = VideoStreamReader::new();
        self.units = VideoUnits::new();
        self.phase = Phase::Connect;
        if let Some(addr) = super::scrcpy::dial_addr(host, port) {
            self.addr = addr;
        }
        self.end = Instant::now() + self.deadline;
    }

    fn close_socket(&mut self) {
        if let Some(socket) = self.socket.take() {
            let _ = socket.shutdown(Shutdown::Both);
        }
        if let Ok(mut held) = self.held.lock() {
            held.take();
        }
    }

    fn hold(&mut self) {
        if let Ok(mut held) = self.held.lock() {
            *held = self
                .socket
                .as_ref()
                .and_then(|socket| socket.try_clone().ok());
        }
    }
}

/// What the coordinator does next.
enum Next {
    /// The handshake or stream continues.
    Again,
    /// The reader ends quietly: the engine already ended its source.
    Closed,
    /// The reader ends after saying every unit read has gone out.
    Drained,
    /// The reader ends as failed with this daemon-facing reason.
    Failed(&'static str),
}

pub(crate) fn run(mut coordinator: Coordinator, beat: Beat) {
    loop {
        beat.turn();
        match step(&mut coordinator) {
            Next::Again => {}
            Next::Closed => break,
            Next::Drained => {
                let _ = coordinator.send(Output::Drained);
                break;
            }
            Next::Failed(reason) => {
                let _ = coordinator.send(Output::Failed(reason.into()));
                break;
            }
        }
    }
    coordinator.close_socket();
}

fn step(coordinator: &mut Coordinator) -> Next {
    match coordinator.control() {
        Some(Control::Close) => return Next::Closed,
        Some(Control::Drain) => return Next::Drained,
        Some(Control::Dial { host, port }) => {
            coordinator.redial(&host, port);
            return Next::Again;
        }
        Some(Control::Connected) => {
            if coordinator.phase == Phase::WaitControl {
                coordinator.phase = Phase::Metadata;
            }
            // A stray connection (a reopen's, say) changes nothing.
            return Next::Again;
        }
        None => {}
    }
    match coordinator.phase {
        Phase::Connect => connect(coordinator),
        Phase::Greet => greet(coordinator),
        Phase::WaitControl => wait_control(coordinator),
        Phase::Metadata => metadata(coordinator),
        Phase::Stream => stream(coordinator),
    }
}

/// Sleeps past a failed dial: woken by control, over at the deadline.
fn rest(coordinator: &mut Coordinator) -> Next {
    let Some(remaining) = coordinator.remaining() else {
        return Next::Failed(NOT_STARTED);
    };
    match coordinator.control.recv_timeout(remaining.min(RETRY)) {
        Ok(Control::Close) => Next::Closed,
        Ok(Control::Drain) => Next::Drained,
        Ok(Control::Dial { host, port }) => {
            coordinator.redial(&host, port);
            Next::Again
        }
        // Nothing waits on control yet; stay dialling.
        Ok(Control::Connected) => Next::Again,
        Err(RecvTimeoutError::Timeout) => Next::Again,
        Err(RecvTimeoutError::Disconnected) => Next::Closed,
    }
}

fn connect(coordinator: &mut Coordinator) -> Next {
    let Some(remaining) = coordinator.remaining() else {
        return Next::Failed(NOT_STARTED);
    };
    match TcpStream::connect_timeout(&coordinator.addr, remaining.min(CONNECT)) {
        Ok(socket) => {
            coordinator.socket = Some(socket);
            coordinator.hold();
            coordinator.phase = Phase::Greet;
            Next::Again
        }
        Err(_) => rest(coordinator),
    }
}

fn greet(coordinator: &mut Coordinator) -> Next {
    let Some(remaining) = coordinator.remaining() else {
        coordinator.close_socket();
        return Next::Failed(NOT_STARTED);
    };
    let read = match coordinator.socket.as_mut() {
        None => {
            coordinator.phase = Phase::Connect;
            return Next::Again;
        }
        Some(socket) => {
            if socket.set_read_timeout(Some(remaining)).is_err() {
                coordinator.close_socket();
                coordinator.phase = Phase::Connect;
                return rest(coordinator);
            }
            socket.read_exact(&mut [0u8; 1])
        }
    };
    match read {
        Ok(()) => {
            if coordinator.event(ScrcpyEvent::Greeted) {
                coordinator.phase = Phase::WaitControl;
                Next::Again
            } else {
                Next::Closed
            }
        }
        // adb accepts a TCP connection even while nothing listens on the device, then
        // closes it: not yet. A reset retries the same way, until the deadline.
        Err(_) => {
            coordinator.close_socket();
            coordinator.phase = Phase::Connect;
            rest(coordinator)
        }
    }
}

fn wait_control(coordinator: &mut Coordinator) -> Next {
    let Some(remaining) = coordinator.remaining() else {
        return Next::Failed(NOT_STARTED);
    };
    match coordinator.control.recv_timeout(remaining) {
        Ok(Control::Connected) => {
            coordinator.phase = Phase::Metadata;
            Next::Again
        }
        Ok(Control::Dial { host, port }) => {
            coordinator.redial(&host, port);
            Next::Again
        }
        Ok(Control::Close) => Next::Closed,
        Ok(Control::Drain) => Next::Drained,
        Err(_) => Next::Failed(NOT_STARTED),
    }
}

fn metadata(coordinator: &mut Coordinator) -> Next {
    let Some(remaining) = coordinator.remaining() else {
        return Next::Failed(NOT_STARTED);
    };
    let mut meta = [0u8; DEVICE_NAME_LEN + 4];
    let read = match coordinator.socket.as_mut() {
        None => return Next::Failed(CLOSED),
        Some(socket) => {
            if socket.set_read_timeout(Some(remaining)).is_err() {
                return Next::Failed(CLOSED);
            }
            socket.read_exact(&mut meta)
        }
    };
    if read.is_err() {
        // The server went away mid-handshake: fail at once, not at the deadline.
        return Next::Failed(CLOSED);
    }
    let mut name = [0u8; DEVICE_NAME_LEN];
    name.copy_from_slice(&meta[..DEVICE_NAME_LEN]);
    let name = device_name(&name);
    let mut events = Vec::new();
    if coordinator
        .reader
        .push(&meta[DEVICE_NAME_LEN..], &mut events)
        .is_err()
    {
        return Next::Failed(CLOSED);
    }
    let mut out = Vec::new();
    for event in events {
        if coordinator.units.push(event, &mut out).is_err() {
            return Next::Failed(CLOSED);
        }
    }
    if let Some(socket) = coordinator.socket.as_mut() {
        let _ = socket.set_read_timeout(Some(IDLE_WAIT));
    }
    if coordinator.event(ScrcpyEvent::Ready { name }) {
        coordinator.phase = Phase::Stream;
        Next::Again
    } else {
        Next::Closed
    }
}

fn stream(coordinator: &mut Coordinator) -> Next {
    let mut chunk = [0u8; 64 * 1024];
    let read = match coordinator.socket.as_mut() {
        None => return Next::Failed(CLOSED),
        Some(socket) => socket.read(&mut chunk),
    };
    match read {
        Ok(0) => Next::Failed(CLOSED),
        Ok(read) => {
            let mut events = Vec::new();
            if coordinator
                .reader
                .push(&chunk[..read], &mut events)
                .is_err()
            {
                return Next::Failed(CLOSED);
            }
            let mut out = Vec::new();
            for event in events {
                if coordinator.units.push(event, &mut out).is_err() {
                    return Next::Failed(CLOSED);
                }
            }
            for unit in &out {
                match unit_frame(unit) {
                    Ok(frame) => {
                        if !coordinator.send(Output::Unit(frame)) {
                            return Next::Closed;
                        }
                    }
                    Err(_) => return Next::Failed(CLOSED),
                }
            }
            Next::Again
        }
        Err(error)
            if error.kind() == std::io::ErrorKind::TimedOut
                || error.kind() == std::io::ErrorKind::WouldBlock =>
        {
            Next::Again
        }
        // A shutdown (close, dial, drain) interrupts the read: honor control first.
        Err(_) => match coordinator.control() {
            Some(Control::Close) => Next::Closed,
            Some(Control::Drain) => Next::Drained,
            Some(Control::Dial { host, port }) => {
                coordinator.redial(&host, port);
                Next::Again
            }
            Some(Control::Connected) => Next::Again,
            None => Next::Failed(CLOSED),
        },
    }
}
