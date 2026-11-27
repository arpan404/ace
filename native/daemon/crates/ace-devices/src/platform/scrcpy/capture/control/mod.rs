// SPDX-License-Identifier: Apache-2.0
//! Control dispatch: when a control message may be written, when a keyframe is asked for, and
//! what one input step does. The socket, the clipboard and the held pointers are the shell's;
//! this decides the refusals, the retry window and the step's kind.

use crate::platform::Error;

use super::{CONTROL_BACKLOG, KEYFRAME_RETRY_MS, input_backlog, unavailable};

/// What a keyframe request does now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyframeStep {
    /// Asked within the retry window, or nothing streams yet.
    Skip,
    /// The picture is encoded on the host: ask its encoder.
    Host,
    /// The device's own encoder: send the server's video reset.
    ResetVideo,
}

/// The last keyframe request, so a restarting encoder is not asked again and again.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeyframeAsker {
    last_asked: f64,
}

impl KeyframeAsker {
    pub fn new() -> Self {
        Self {
            last_asked: f64::NEG_INFINITY,
        }
    }

    /// The request to make now, if any; a request inside the retry window is skipped.
    pub fn step(&mut self, now: f64, streaming: bool, has_host_frames: bool) -> KeyframeStep {
        if now - self.last_asked < KEYFRAME_RETRY_MS {
            return KeyframeStep::Skip;
        }
        if !streaming {
            return KeyframeStep::Skip;
        }
        self.last_asked = now;
        if has_host_frames {
            KeyframeStep::Host
        } else {
            KeyframeStep::ResetVideo
        }
    }

    /// A keyframe arrived: the encoder is healthy and a later request may be made at once.
    pub fn delivered(&mut self) {
        self.last_asked = f64::NEG_INFINITY;
    }

    pub fn last_asked(&self) -> f64 {
        self.last_asked
    }
}

impl Default for KeyframeAsker {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether one control message may be written: a control socket that is open and not backed up.
pub fn writable(has_control: bool, queued_bytes: usize, stopped: bool) -> Result<(), Error> {
    if !has_control {
        return Err(unavailable(stopped));
    }
    if queued_bytes > CONTROL_BACKLOG {
        return Err(input_backlog());
    }
    Ok(())
}

/// What one planned input step does with the link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputStep {
    /// The clipboard numbers its own writes, so it is written through the clipboard machine.
    Clipboard,
    /// Everything else is encoded and written to the control socket.
    Send,
}

pub fn input_step(set_clipboard: bool) -> InputStep {
    if set_clipboard {
        InputStep::Clipboard
    } else {
        InputStep::Send
    }
}

#[cfg(test)]
mod tests;
