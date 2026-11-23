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

    /// What control says, if anything: a close or drain ends this reader.
    fn control(&mut self) -> Option<Control> {
        self.control.try_recv().ok()
    }

    /// How a read that failed ends: a queued close or drain shut the socket to interrupt
    /// it, so that ending wins; otherwise the server went away and the reader fails at once.
    fn interrupted(&mut self, reason: &'static str) -> Next {
        loop {
            match self.control() {
                Some(Control::Close) => return Next::Closed,
                Some(Control::Drain) => return Next::Drained,
                // A stray connection (a reopen's, say) changes nothing.
                Some(Control::Connected) => {}
                None => return Next::Failed(reason),
            }
        }
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
        Ok(Control::Close) => Next::Closed,
        Ok(Control::Drain) => Next::Drained,
        Err(_) => Next::Failed(NOT_STARTED),
    }
}

/// What a bounded metadata read ended with.
enum ReadError {
    TimedOut,
    Closed,
}

fn metadata(coordinator: &mut Coordinator) -> Next {
    let Some(remaining) = coordinator.remaining() else {
        return Next::Failed(NOT_STARTED);
    };
    // One absolute deadline for the whole read: trickling bytes must not stretch it.
    let end = Instant::now() + remaining;
    let mut meta = [0u8; DEVICE_NAME_LEN + 4];
    let mut got = 0;
    let read = loop {
        if Instant::now() >= end {
            break Err(ReadError::TimedOut);
        }
        let Some(socket) = coordinator.socket.as_mut() else {
            break Err(ReadError::Closed);
        };
        if socket
            .set_read_timeout(Some(end.saturating_duration_since(Instant::now())))
            .is_err()
        {
            break Err(ReadError::Closed);
        }
        match socket.read(&mut meta[got..]) {
            Ok(0) => break Err(ReadError::Closed),
            Ok(read) => {
                got += read;
                if got >= meta.len() {
                    break Ok(());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => {
                break Err(ReadError::TimedOut);
            }
            Err(_) => break Err(ReadError::Closed),
        }
    };
    match read {
        // A close or drain interrupts the read by shutting the socket: it wins. Otherwise
        // the server went away mid-handshake: fail at once, not at the deadline.
        Err(ReadError::Closed) => return coordinator.interrupted(CLOSED),
        Err(ReadError::TimedOut) => return coordinator.interrupted(NOT_STARTED),
        Ok(()) => {}
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
        // A shutdown (close, drain) ends the read: control first. Otherwise the server went
        // away mid-stream: fail at once, not at the deadline.
        Ok(0) => coordinator.interrupted(CLOSED),
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
        // A shutdown (close, drain) interrupts the read: control first.
        Err(_) => coordinator.interrupted(CLOSED),
    }
}
