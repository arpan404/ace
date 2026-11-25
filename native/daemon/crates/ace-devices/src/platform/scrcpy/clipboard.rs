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

/// What the shell tells the clipboard.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClipboardEvent {
    /// A read for `owner` (a person's or an agent's): its result comes back as
    /// [`ClipboardOut::ReadDone`]. `now_ms` is the caller's clock, since a deadline counts from
    /// the moment the request is sent, not from the last tick.
    Read {
        id: u64,
        owner: String,
        now_ms: u64,
    },
    Write {
        text: JsString,
        paste: bool,
        now_ms: u64,
    },
    /// A message the device sent, at the caller's clock.
    Received {
        message: DeviceMessage,
        now_ms: u64,
    },
    Tick {
        now_ms: u64,
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
    },
    Timer {
        at_ms: u64,
    },
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Timer {
    at_ms: u64,
    deadline: Deadline,
}

/// One write waiting for its acknowledgement, and whether it was a paste (its timeout's text).
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Ack {
    sequence: u64,
    paste: bool,
}

/// The clipboard's state and decisions. `Send` carries the message the caller writes; the
/// caller arms each `Timer` and calls back with `Tick` at that time.
#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ScrcpyClipboard {
    acks: Vec<Ack>,
    reading: Option<Read>,
    outstanding: Vec<Request>,
    next_request: u64,
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
            ClipboardEvent::Read { id, owner, now_ms } => {
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
                self.proceed(now_ms, &mut out);
            }
            ClipboardEvent::Write {
                text,
                paste,
                now_ms,
            } => {
                self.sequence += 1;
                let sequence = self.sequence;
                self.acks.push(Ack { sequence, paste });
                let at_ms = now_ms + ACK_MS;
                self.timers.push(Timer {
                    at_ms,
                    deadline: Deadline::ack(sequence),
                });
                out.push(ClipboardOut::Timer { at_ms });
                out.push(ClipboardOut::Send {
                    message: Box::new(ControlMessage::SetClipboard {
                        sequence: PointerId(sequence),
                        text,
                        paste,
                    }),
                });
            }
            ClipboardEvent::Received { message, now_ms } => {
                self.received(message, now_ms, &mut out)
            }
            ClipboardEvent::Tick { now_ms } => {
                self.fire(now_ms, &mut out);
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

    /// A message the device sent on the control socket.
    fn received(&mut self, message: DeviceMessage, now_ms: u64, out: &mut Vec<ClipboardOut>) {
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
                    self.proceed(now_ms, out);
                }
            }
            _ => {}
        }
    }

    /// Sends the waiting read's request once no other owner's may still be answered.
    fn proceed(&mut self, now_ms: u64, out: &mut Vec<ClipboardOut>) {
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
        let settle_at = now_ms + CLIPBOARD_SETTLE_MS;
        let reply_at = now_ms + CLIPBOARD_REPLY_MS;
        self.timers.push(Timer {
            at_ms: settle_at,
            deadline: Deadline::settle(request.id),
        });
        self.timers.push(Timer {
            at_ms: reply_at,
            deadline: Deadline::reply(id),
        });
        out.push(ClipboardOut::Timer { at_ms: settle_at });
        out.push(ClipboardOut::Timer { at_ms: reply_at });
        out.push(ClipboardOut::Send {
            message: Box::new(ControlMessage::GetClipboard),
        });
    }

    /// Runs every deadline at or before `now_ms`, earliest first.
    fn fire(&mut self, now_ms: u64, out: &mut Vec<ClipboardOut>) {
        loop {
            let Some(index) = self
                .timers
                .iter()
                .enumerate()
                .filter(|(_, timer)| timer.at_ms <= now_ms)
                .min_by_key(|(index, timer)| (timer.at_ms, *index))
                .map(|(index, _)| index)
            else {
                return;
            };
            let timer = self.timers.remove(index);
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
                    self.proceed(now_ms, out);
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
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clipboard over a scripted control socket, with a clock the test moves.
    struct Socket {
        clipboard: ScrcpyClipboard,
        now: u64,
        timers: Vec<u64>,
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
                    ClipboardOut::Send { message } => self.sent.push(*message),
                    ClipboardOut::Timer { at_ms } => {
                        if !self.timers.contains(&at_ms) {
                            self.timers.push(at_ms);
                        }
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
                now_ms: self.now,
            });
        }

        fn write(&mut self, text: &str, paste: bool) {
            self.apply(ClipboardEvent::Write {
                text: text.into(),
                paste,
                now_ms: self.now,
            });
        }

        fn reply(&mut self, text: &str) {
            self.apply(ClipboardEvent::Received {
                message: DeviceMessage::Clipboard { text: text.into() },
                now_ms: self.now,
            });
        }

        fn ack(&mut self, sequence: u64) {
            self.apply(ClipboardEvent::Received {
                message: DeviceMessage::ClipboardAck {
                    sequence: PointerId(sequence),
                },
                now_ms: self.now,
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
                let due = self.timers.iter().copied().filter(|at| *at <= end).min();
                let Some(at) = due else { break };
                self.timers.retain(|each| *each != at);
                self.now = at;
                self.apply(ClipboardEvent::Tick { now_ms: at });
            }
            self.now = end;
            // A real clock reaches the end of the window whether or not a timer was armed for
            // it: a deadline that was measured from an earlier instant shows up here.
            self.apply(ClipboardEvent::Tick { now_ms: end });
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
    fn a_read_asked_for_after_an_idle_stretch_still_waits_its_full_reply_window() {
        let mut socket = Socket::new();
        socket.advance(5_000);
        socket.read(1, "agent");
        socket.reply("text");
        assert_eq!(socket.reads, vec![(1, Ok("text".into()))]);
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
