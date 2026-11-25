// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-clipboard.ts`: the clipboard over one scrcpy control socket. Reads wait for the
//! device's clipboard message, writes for the acknowledgement of their sequence number. Pure
//! apart from the caller's clock: every deadline is a [`ClipboardOut::Timer`] the shell arms and
//! every elapsed one is a [`ClipboardEvent::Tick`]. That keeps the ordering the TypeScript's
//! injected `after` gives it.

use ace_json::JsString;
use serde::{Deserialize, Serialize};

use crate::platform::scrcpy::protocol::{ControlMessage, DeviceMessage, PointerId};
use crate::platform::{Failure, Refusal};

/// How long a clipboard read waits for the device's reply. The server answers a read only when
/// the clipboard holds text, so silence means it is empty.
pub const CLIPBOARD_REPLY_MS: u64 = 1500;
/// How long after it was sent a request whose read gave up may still be answered. scrcpy's
/// clipboard replies name no request, only the text, so until then a reply could be that one's.
pub const CLIPBOARD_SETTLE_MS: u64 = 10_000;
/// How long a clipboard write waits for the server to acknowledge its sequence number.
const ACK_MS: u64 = 5000;

/// What the shell tells the clipboard. Deadlines are relative delays it arms with its own clock,
/// as `after(ms)` schedules them, so a stretch with no deadline cannot leave one stale.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClipboardEvent {
    /// A read for `owner` (a person's or an agent's): its result comes back as
    /// [`ClipboardOut::ReadDone`] with this `id`.
    Read {
        id: u64,
        owner: String,
    },
    Write {
        text: JsString,
        paste: bool,
    },
    /// A message the device sent on the control socket.
    Received {
        message: DeviceMessage,
    },
    /// One of the shell's armed deadlines elapsed.
    Tick {
        id: u64,
    },
    /// A send threw: settle what it belonged to, so the machine is not left waiting.
    SendFailed {
        read: Option<u64>,
        sequence: Option<u64>,
    },
    Close,
}

/// What the clipboard tells the shell: send a message, arm a deadline, or finish a call.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClipboardOut {
    Send {
        message: Box<ControlMessage>,
        /// The read this request belongs to, when it is a clipboard read: the shell rejects
        /// that read alone if the write throws, even when its request was sent while deferred.
        read: Option<u64>,
    },
    /// Arm `after_ms` from now; a [`ClipboardEvent::Tick`] with this `id` fires it.
    Timer { id: u64, after_ms: u64 },
    ReadDone {
        id: u64,
        result: Result<String, Failure>,
    },
    WriteDone {
        sequence: u64,
        result: Result<(), Failure>,
    },
}

/// A request on the socket the device may still answer, and whose read it is.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Request {
    id: u64,
    owner: String,
}

/// The one read in progress: waiting to send its request, then for the reply.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Read {
    id: u64,
    owner: String,
    request: Option<u64>,
}

/// Which deadline a timer is, and what it is for: `kind` is 0 reply, 1 settle, 2 ack, because
/// the shell carries this state as JSON and ace-json reads a tagged struct, not an enum.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Deadline {
    kind: u8,
    id: u64,
}

const REPLY: u8 = 0;
const SETTLE: u8 = 1;
const ACK: u8 = 2;

impl Deadline {
    fn reply(id: u64) -> Self {
        Self { kind: REPLY, id }
    }
    fn settle(id: u64) -> Self {
        Self { kind: SETTLE, id }
    }
    fn ack(id: u64) -> Self {
        Self { kind: ACK, id }
    }
}

/// One armed deadline: the id the shell ticks back, its delay, and what it is for.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Timer {
    id: u64,
    after_ms: u64,
    deadline: Deadline,
}

/// One write waiting for its acknowledgement, and whether it was a paste (its timeout's text).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Ack {
    sequence: u64,
    paste: bool,
}

/// The clipboard's state and decisions. The shell arms each `Timer` and ticks its id back.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ScrcpyClipboard {
    acks: Vec<Ack>,
    reading: Option<Read>,
    outstanding: Vec<Request>,
    next_request: u64,
    next_timer: u64,
    sequence: u64,
    timers: Vec<Timer>,
}

fn failure(key: &str) -> Failure {
    let word = Refusal::word(key);
    Failure {
        code: word.code,
        message: word.message.to_string(),
        hint: word.hint.to_string(),
    }
}

impl ScrcpyClipboard {
    pub fn new() -> Self {
        Self::default()
    }

    /// One event, and everything it makes the shell do.
    pub fn step(&mut self, event: ClipboardEvent) -> Vec<ClipboardOut> {
        let mut out = Vec::new();
        match event {
            ClipboardEvent::Read { id, owner } => {
                if self.reading.is_some() {
                    out.push(ClipboardOut::ReadDone {
                        id,
                        result: Err(failure("clipboardReadWaiting")),
                    });
                    return out;
                }
                self.reading = Some(Read {
                    id,
                    owner,
                    request: None,
                });
                self.proceed(&mut out);
            }
            ClipboardEvent::Write { text, paste } => {
                self.sequence += 1;
                let sequence = self.sequence;
                self.acks.push(Ack { sequence, paste });
                self.arm(ACK_MS, Deadline::ack(sequence), &mut out);
                out.push(ClipboardOut::Send {
                    message: Box::new(ControlMessage::SetClipboard {
                        sequence: PointerId(sequence),
                        text,
                        paste,
                    }),
                    read: None,
                });
            }
            ClipboardEvent::Received { message } => self.received(message, &mut out),
            ClipboardEvent::Tick { id } => self.fire(id, &mut out),
            ClipboardEvent::SendFailed { read, sequence } => {
                if let (Some(id), Some(reading)) = (read, self.reading.as_ref())
                    && reading.id == id
                {
                    let request = reading.request;
                    self.reading = None;
                    if let Some(request) = request {
                        self.outstanding.retain(|each| each.id != request);
                        self.timers.retain(|timer| {
                            timer.deadline != Deadline::settle(request)
                                && timer.deadline != Deadline::reply(id)
                        });
                    }
                }
                if let Some(sequence) = sequence {
                    self.acks.retain(|ack| ack.sequence != sequence);
                    self.timers
                        .retain(|timer| timer.deadline != Deadline::ack(sequence));
                }
            }
            ClipboardEvent::Close => {
                for ack in std::mem::take(&mut self.acks) {
                    out.push(ClipboardOut::WriteDone {
                        sequence: ack.sequence,
                        result: Ok(()),
                    });
                }
                self.timers.clear();
                self.outstanding.clear();
                if let Some(reading) = self.reading.take() {
                    out.push(ClipboardOut::ReadDone {
                        id: reading.id,
                        result: Err(failure("androidControlRestarted")),
                    });
                }
            }
        }
        out
    }

    /// Arms a deadline `after_ms` from now and tells the shell to schedule it.
    fn arm(&mut self, after_ms: u64, deadline: Deadline, out: &mut Vec<ClipboardOut>) {
        self.next_timer += 1;
        let id = self.next_timer;
        self.timers.push(Timer {
            id,
            after_ms,
            deadline,
        });
        out.push(ClipboardOut::Timer { id, after_ms });
    }

    /// A message the device sent on the control socket.
    fn received(&mut self, message: DeviceMessage, out: &mut Vec<ClipboardOut>) {
        match message {
            DeviceMessage::ClipboardAck { sequence } => {
                let sequence = sequence.0;
                if !self.acks.iter().any(|ack| ack.sequence == sequence) {
                    return;
                }
                self.acks.retain(|ack| ack.sequence != sequence);
                self.timers
                    .retain(|timer| timer.deadline != Deadline::ack(sequence));
                out.push(ClipboardOut::WriteDone {
                    sequence,
                    result: Ok(()),
                });
            }
            DeviceMessage::Clipboard { text } => {
                // Nothing asked: not an answer to anyone.
                if self.outstanding.is_empty() {
                    return;
                }
                self.outstanding.remove(0);
                let answered = self
                    .reading
                    .as_ref()
                    .is_some_and(|reading| reading.request.is_some());
                if answered {
                    let Some(reading) = self.reading.take() else {
                        return;
                    };
                    self.timers
                        .retain(|timer| timer.deadline != Deadline::reply(reading.id));
                    out.push(ClipboardOut::ReadDone {
                        id: reading.id,
                        result: Ok(text.to_string()),
                    });
                } else {
                    self.proceed(out);
                }
            }
            _ => {}
        }
    }

    /// Sends the waiting read's request once no other owner's may still be answered.
    fn proceed(&mut self, out: &mut Vec<ClipboardOut>) {
        let Some(reading) = self.reading.as_ref() else {
            return;
        };
        if reading.request.is_some() {
            return;
        }
        if self
            .outstanding
            .iter()
            .any(|request| request.owner != reading.owner)
        {
            return;
        }
        self.next_request += 1;
        let request = Request {
            id: self.next_request,
            owner: reading.owner.clone(),
        };
        self.outstanding.push(request.clone());
        let id = reading.id;
        if let Some(reading) = self.reading.as_mut() {
            reading.request = Some(request.id);
        }
        self.arm(CLIPBOARD_SETTLE_MS, Deadline::settle(request.id), out);
        self.arm(CLIPBOARD_REPLY_MS, Deadline::reply(id), out);
        out.push(ClipboardOut::Send {
            message: Box::new(ControlMessage::GetClipboard),
            read: Some(id),
        });
    }

    /// Runs the deadline `id` names, when the shell's clock reaches it.
    fn fire(&mut self, id: u64, out: &mut Vec<ClipboardOut>) {
        let Some(timer) = self.timers.iter().find(|timer| timer.id == id).copied() else {
            return;
        };
        self.timers.retain(|each| each.id != id);
        match timer.deadline.kind {
            REPLY => {
                let id = timer.deadline.id;
                if self
                    .reading
                    .as_ref()
                    .is_some_and(|reading| reading.id == id)
                {
                    self.reading = None;
                    out.push(ClipboardOut::ReadDone {
                        id,
                        result: Ok(String::new()),
                    });
                }
            }
            SETTLE => {
                let request = timer.deadline.id;
                self.outstanding.retain(|each| each.id != request);
                self.proceed(out);
            }
            _ => {
                let sequence = timer.deadline.id;
                let ack = self
                    .acks
                    .iter()
                    .find(|ack| ack.sequence == sequence)
                    .copied();
                if let Some(ack) = ack {
                    self.acks.retain(|each| each.sequence != sequence);
                    out.push(ClipboardOut::WriteDone {
                        sequence,
                        result: Err(failure(if ack.paste {
                            "pasteTimedOut"
                        } else {
                            "clipboardWriteTimedOut"
                        })),
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clipboard over a scripted control socket, with a clock the test moves.
    struct Socket {
        clipboard: ScrcpyClipboard,
        now: u64,
        timers: Vec<(u64, u64)>,
        sent: Vec<ControlMessage>,
        reads: Vec<(u64, Result<String, Failure>)>,
        writes: Vec<(u64, Result<(), Failure>)>,
    }

    impl Socket {
        fn new() -> Self {
            Self {
                clipboard: ScrcpyClipboard::new(),
                now: 0,
                timers: Vec::new(),
                sent: Vec::new(),
                reads: Vec::new(),
                writes: Vec::new(),
            }
        }

        fn apply(&mut self, event: ClipboardEvent) {
            for out in self.clipboard.step(event) {
                match out {
                    ClipboardOut::Send { message, .. } => self.sent.push(*message),
                    ClipboardOut::Timer { id, after_ms } => {
                        self.timers.push((id, self.now + after_ms))
                    }
                    ClipboardOut::ReadDone { id, result } => self.reads.push((id, result)),
                    ClipboardOut::WriteDone { sequence, result } => {
                        self.writes.push((sequence, result))
                    }
                }
            }
        }

        fn read(&mut self, id: u64, owner: &str) {
            self.apply(ClipboardEvent::Read {
                id,
                owner: owner.into(),
            });
        }

        fn write(&mut self, text: &str, paste: bool) {
            self.apply(ClipboardEvent::Write {
                text: text.into(),
                paste,
            });
        }

        fn reply(&mut self, text: &str) {
            self.apply(ClipboardEvent::Received {
                message: DeviceMessage::Clipboard { text: text.into() },
            });
        }

        fn ack(&mut self, sequence: u64) {
            self.apply(ClipboardEvent::Received {
                message: DeviceMessage::ClipboardAck {
                    sequence: PointerId(sequence),
                },
            });
        }

        fn close(&mut self) {
            self.apply(ClipboardEvent::Close);
        }

        fn asked(&self) -> usize {
            self.sent
                .iter()
                .filter(|message| matches!(message, ControlMessage::GetClipboard))
                .count()
        }

        fn advance(&mut self, ms: u64) {
            let end = self.now + ms;
            loop {
                let due = self
                    .timers
                    .iter()
                    .copied()
                    .filter(|timer| timer.1 <= end)
                    .min_by_key(|timer| timer.1);
                let Some((id, at)) = due else { break };
                self.timers.retain(|timer| timer.0 != id);
                self.now = at;
                self.apply(ClipboardEvent::Tick { id });
            }
            self.now = end;
        }

        fn send_failed(&mut self, read: Option<u64>, sequence: Option<u64>) {
            self.apply(ClipboardEvent::SendFailed { read, sequence });
        }
    }

    #[test]
    fn a_read_takes_the_devices_reply_to_it() {
        let mut socket = Socket::new();
        socket.read(1, "agent");
        assert_eq!(socket.asked(), 1);
        socket.reply("text");
        assert_eq!(socket.reads, vec![(1, Ok("text".into()))]);
    }

    #[test]
    fn a_device_that_does_not_answer_reads_as_empty() {
        let mut socket = Socket::new();
        socket.read(1, "agent");
        socket.advance(CLIPBOARD_REPLY_MS);
        assert_eq!(socket.reads, vec![(1, Ok(String::new()))]);
    }

    #[test]
    fn a_persons_late_reply_never_reaches_an_agents_read_and_the_agent_gets_its_own() {
        let mut socket = Socket::new();
        socket.read(1, "person");
        socket.advance(CLIPBOARD_REPLY_MS);
        assert_eq!(socket.reads, vec![(1, Ok(String::new()))]);

        socket.read(2, "agent");
        assert_eq!(socket.asked(), 1);
        socket.reply("the person's password");
        assert!(socket.reads.iter().all(|(id, _)| *id != 2));
        assert_eq!(socket.asked(), 2);
        socket.reply("the agent's text");
        assert_eq!(
            socket.reads.last(),
            Some(&(2, Ok("the agent's text".into())))
        );
    }

    #[test]
    fn a_persons_read_the_device_never_answered_holds_an_agents_back_only_until_it_settles() {
        let mut socket = Socket::new();
        socket.read(1, "person");
        socket.advance(CLIPBOARD_REPLY_MS);
        socket.read(2, "agent");
        socket.advance(CLIPBOARD_SETTLE_MS - CLIPBOARD_REPLY_MS - 1);
        assert_eq!(socket.asked(), 1);
        socket.advance(1);
        assert_eq!(socket.asked(), 2);
        socket.reply("the agent's text");
        assert_eq!(
            socket.reads.last(),
            Some(&(2, Ok("the agent's text".into())))
        );
    }

    #[test]
    fn one_readers_own_unanswered_read_does_not_hold_back_its_next_one() {
        let mut socket = Socket::new();
        socket.read(1, "agent");
        socket.advance(CLIPBOARD_REPLY_MS);
        assert_eq!(socket.reads, vec![(1, Ok(String::new()))]);
        socket.read(2, "agent");
        assert_eq!(socket.asked(), 2);
        socket.reply("now there is text");
        assert_eq!(
            socket.reads.last(),
            Some(&(2, Ok("now there is text".into())))
        );
    }

    #[test]
    fn an_agents_late_reply_never_reaches_the_persons_read_either() {
        let mut socket = Socket::new();
        socket.read(1, "agent");
        socket.advance(CLIPBOARD_REPLY_MS);
        socket.read(2, "person");
        socket.reply("the agent's late answer");
        socket.reply("the person's answer");
        assert_eq!(
            socket.reads.last(),
            Some(&(2, Ok("the person's answer".into())))
        );
    }

    #[test]
    fn a_read_asked_for_after_an_idle_stretch_waits_its_own_reply_window() {
        let mut socket = Socket::new();
        socket.write("hi", false);
        // Four idle seconds: no deadline fires, and the shell's clock moves on.
        socket.advance(4_000);
        socket.read(1, "agent");
        // The write's own deadline fires at five seconds, and the read is only one second old.
        socket.advance(1_000);
        assert_eq!(
            socket.writes,
            vec![(1, Err(failure("clipboardWriteTimedOut")))]
        );
        assert!(socket.reads.is_empty(), "the read is not due yet");
        socket.advance(500);
        assert_eq!(socket.reads, vec![(1, Ok(String::new()))]);
    }

    #[test]
    fn a_failed_send_settles_what_it_belonged_to() {
        let mut socket = Socket::new();
        socket.read(1, "agent");
        socket.send_failed(Some(1), None);
        assert!(socket.reads.is_empty());
        // The machine is not left reading, so the next read is not refused as busy.
        socket.read(2, "agent");
        assert_eq!(socket.asked(), 2);

        socket.write("hi", false);
        socket.send_failed(None, Some(1));
        // The write is the caller's to reject; the machine keeps no acknowledgement for it.
        socket.advance(ACK_MS);
        assert!(socket.writes.is_empty());
    }

    #[test]
    fn a_write_finishes_on_the_acknowledgement_of_its_sequence_number() {
        let mut socket = Socket::new();
        socket.write("hi", true);
        assert_eq!(socket.writes, Vec::new());
        assert!(matches!(
            socket.sent.first(),
            Some(ControlMessage::SetClipboard {
                sequence: PointerId(1),
                paste: true,
                ..
            })
        ));
        socket.ack(1);
        assert_eq!(socket.writes, vec![(1, Ok(()))]);
    }

    #[test]
    fn a_second_read_while_one_waits_is_refused_as_busy() {
        let mut socket = Socket::new();
        socket.read(1, "agent");
        socket.read(2, "person");
        assert_eq!(
            socket.reads,
            vec![(2, Err(failure("clipboardReadWaiting")))]
        );
    }

    #[test]
    fn a_closed_socket_finishes_waiting_writes_and_fails_a_waiting_read() {
        let mut socket = Socket::new();
        socket.write("hi", false);
        socket.read(1, "agent");
        socket.close();
        assert_eq!(socket.writes, vec![(1, Ok(()))]);
        assert_eq!(
            socket.reads,
            vec![(1, Err(failure("androidControlRestarted")))]
        );
    }

    #[test]
    fn a_paste_that_is_never_acknowledged_says_it_was_a_paste() {
        let mut socket = Socket::new();
        socket.write("hi", true);
        socket.advance(ACK_MS);
        assert_eq!(socket.writes, vec![(1, Err(failure("pasteTimedOut")))]);
    }
}
