// SPDX-License-Identifier: Apache-2.0
//! The one seam between the host's decisions and a socket: a binary frame in, a binary frame out.
//! The relay link is the real one; tests wire two ends with a pipe, so the control session and a
//! channel's codec are proven without a network.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};

use crate::error::RelayError;

use super::link::{Incoming, Link};

/// A relay socket's data frames and its liveness.
pub trait FrameIo: Send {
    fn send(&mut self, frame: &[u8]) -> Result<(), RelayError>;
    fn read(&mut self) -> Result<Incoming, RelayError>;
    fn ping(&mut self) -> Result<(), RelayError> {
        Ok(())
    }
    /// The close handshake once what was queued has gone out.
    fn close(&mut self);
    /// Drop the connection without a close handshake.
    fn terminate(&mut self);
    fn buffered(&self) -> usize {
        0
    }
}

impl FrameIo for Link {
    fn send(&mut self, frame: &[u8]) -> Result<(), RelayError> {
        Link::send(self, frame)
    }

    fn read(&mut self) -> Result<Incoming, RelayError> {
        Link::read(self)
    }

    fn ping(&mut self) -> Result<(), RelayError> {
        Link::ping(self)
    }

    fn close(&mut self) {
        Link::close(self)
    }

    fn terminate(&mut self) {
        Link::terminate(self)
    }

    fn buffered(&self) -> usize {
        Link::buffered(self)
    }
}

type Queue = (Mutex<PipeState>, Condvar);

#[derive(Default)]
struct PipeState {
    frames: VecDeque<Vec<u8>>,
    closed: bool,
    dropped: bool,
}

/// One end of an in-memory pair, for tests: a frame one end writes the other reads.
pub struct Pipe {
    inbound: Arc<Queue>,
    outbound: Arc<Queue>,
}

impl Pipe {
    /// Two ends wired back to back.
    pub fn pair() -> (Self, Self) {
        let first = Arc::new((Mutex::new(PipeState::default()), Condvar::new()));
        let second = Arc::new((Mutex::new(PipeState::default()), Condvar::new()));
        (
            Self {
                inbound: Arc::clone(&first),
                outbound: Arc::clone(&second),
            },
            Self {
                inbound: second,
                outbound: first,
            },
        )
    }
}

impl FrameIo for Pipe {
    fn send(&mut self, frame: &[u8]) -> Result<(), RelayError> {
        let (state, ready) = &*self.outbound;
        let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
        if state.dropped || state.closed {
            return Err(RelayError::Protocol("Relay connection closed"));
        }
        state.frames.push_back(frame.to_vec());
        ready.notify_all();
        Ok(())
    }

    fn read(&mut self) -> Result<Incoming, RelayError> {
        let (state, ready) = &*self.inbound;
        let mut state = state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if let Some(frame) = state.frames.pop_front() {
                return Ok(Incoming::Data(frame));
            }
            if state.dropped {
                return Err(RelayError::Closed {
                    code: 1006,
                    reason: String::new(),
                });
            }
            if state.closed {
                return Ok(Incoming::Closed {
                    code: 1000,
                    reason: String::new(),
                });
            }
            state = ready.wait(state).unwrap_or_else(|error| error.into_inner());
        }
    }

    fn close(&mut self) {
        let (state, ready) = &*self.outbound;
        state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closed = true;
        ready.notify_all();
    }

    fn terminate(&mut self) {
        let (state, ready) = &*self.outbound;
        state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .dropped = true;
        ready.notify_all();
    }
}
