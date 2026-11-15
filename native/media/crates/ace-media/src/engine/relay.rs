// SPDX-License-Identifier: Apache-2.0
//! Relay media streams (docs/media/plan.md, "Media connection authorization" and "Key
//! hand-over"). Before its keys a stream is the daemon's: ace-media dials it, writes the frames
//! the daemon sealed (`relay.out`) and hands back one inbound frame per `relay.pull`, holding the
//! rest. After `relay.keys` ace-media alone opens and seals it ([`Keyed`]): credits, pings and
//! acks in, pieces and pongs out, each sealed into a pooled buffer. Pure: sockets are the
//! shell's, reached through [`RelayEffect`]s.
use media_noise::{
    CREDIT_FLAG, FragmentKind, Fragments, MessageAssembler, RelayStream, fragment_cost, read_credit,
};
use media_wire::media_link::{ClientMessage, ServerMessage};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use super::Effect;

/// Inbound frames held for a stream before its keys (what the daemon hasn't pulled).
pub const MAX_HELD_FRAMES: usize = 64;
/// Sealed-frame buffers kept for reuse.
const POOL_LIMIT: usize = 512;
/// A sealed fragment: the plaintext's at most 65,519 bytes plus the tag.
pub const FRAME_CAPACITY: usize = 65_535;

/// What the shell does for relay streams.
pub enum RelayEffect {
    /// Open the stream's socket to the relay's `/join` address.
    Dial { stream: String, url: String },
    /// Write one frame (already sealed) on the stream's socket. The buffer comes from the
    /// [`Pool`] and goes back to it once written.
    Send { stream: String, frame: Vec<u8> },
    /// Shut the stream's socket now.
    Close { stream: String },
}

impl std::fmt::Debug for RelayEffect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Dial { stream, .. } => write!(f, "Dial({stream})"),
            Self::Send { stream, frame } => write!(f, "Send({stream}, {} bytes)", frame.len()),
            Self::Close { stream } => write!(f, "Close({stream})"),
        }
    }
}

/// Buffers sealed frames are written into, shared with the socket writers that return them,
/// so sealing a frame allocates nothing once the pool is warm.
#[derive(Clone, Default)]
pub struct Pool(Arc<Mutex<Vec<Vec<u8>>>>);

impl Pool {
    pub fn take(&self) -> Vec<u8> {
        self.0
            .lock()
            .ok()
            .and_then(|mut pool| pool.pop())
            .unwrap_or_else(|| Vec::with_capacity(FRAME_CAPACITY))
    }

    /// A written frame's buffer. It held ciphertext only; it is cleared, not wiped.
    pub fn give(&self, mut buffer: Vec<u8>) {
        buffer.clear();
        if buffer.capacity() < FRAME_CAPACITY {
            return;
        }
        if let Ok(mut pool) = self.0.lock()
            && pool.len() < POOL_LIMIT
        {
            pool.push(buffer);
        }
    }

    #[cfg(test)]
    pub fn held(&self) -> usize {
        self.0.lock().map_or(0, |pool| pool.len())
    }
}

/// A stream before its keys.
#[derive(Default)]
struct Pending {
    dialed: bool,
    /// The daemon asked for a frame that hasn't arrived.
    pull: bool,
    held: VecDeque<Vec<u8>>,
}

/// What a pre-key stream's next step produced for the daemon.
pub enum ToDaemon {
    Nothing,
    /// `relay.in` with this frame.
    Frame(Vec<u8>),
    /// The stream broke its bounds and was closed: `relay.failed` with this reason.
    Failed(&'static str),
}

#[derive(Default)]
pub struct Relays {
    pending: HashMap<String, Pending>,
}

impl Relays {
    /// Streams dialing or waiting for their keys.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    pub fn is_pending(&self, stream: &str) -> bool {
        self.pending.contains_key(stream)
    }

    pub fn is_dialed(&self, stream: &str) -> bool {
        self.pending.get(stream).is_some_and(|p| p.dialed)
    }

    /// `relay.dial`: plain `ws://` only. Returns the refusal reason, if any.
    pub fn dial(
        &mut self,
        stream: &str,
        url: &str,
        out: &mut Vec<Effect>,
    ) -> Result<(), &'static str> {
        if self.pending.contains_key(stream) {
            return Err("duplicate");
        }
        if !url.starts_with("ws://") {
            // TLS to the relay lands with a TLS client; the daemon falls back until then.
            return Err("relay-unavailable");
        }
        self.pending.insert(stream.to_owned(), Pending::default());
        out.push(Effect::Relay(RelayEffect::Dial {
            stream: stream.to_owned(),
            url: url.to_owned(),
        }));
        Ok(())
    }

    /// The socket is up. False when the stream was closed meanwhile (the shell drops it).
    pub fn dialed(&mut self, stream: &str) -> bool {
        match self.pending.get_mut(stream) {
            Some(pending) => {
                pending.dialed = true;
                true
            }
            None => false,
        }
    }

    /// `relay.out`: a frame the daemon sealed, written only once dialed.
    pub fn send(&self, stream: &str, frame: Vec<u8>, out: &mut Vec<Effect>) -> bool {
        if !self.is_dialed(stream) {
            return false;
        }
        out.push(Effect::Relay(RelayEffect::Send {
            stream: stream.to_owned(),
            frame,
        }));
        true
    }

    /// `relay.pull`: the next held frame, or a note to hand over the next one to arrive.
    pub fn pull(&mut self, stream: &str) -> ToDaemon {
        let Some(pending) = self.pending.get_mut(stream) else {
            return ToDaemon::Nothing;
        };
        match pending.held.pop_front() {
            Some(frame) => ToDaemon::Frame(frame),
            None => {
                pending.pull = true;
                ToDaemon::Nothing
            }
        }
    }

    /// A frame arrived on a stream without keys: it answers a pull, or is held.
    pub fn arrived(&mut self, stream: &str, frame: Vec<u8>) -> ToDaemon {
        let Some(pending) = self.pending.get_mut(stream) else {
            return ToDaemon::Nothing;
        };
        if pending.pull {
            pending.pull = false;
            return ToDaemon::Frame(frame);
        }
        if pending.held.len() >= MAX_HELD_FRAMES {
            self.pending.remove(stream);
            return ToDaemon::Failed("backlog");
        }
        pending.held.push_back(frame);
        ToDaemon::Nothing
    }

    /// The stream's keys are installed (or it closed): the frames the daemon never pulled, in
    /// order, for the keyed stream to open.
    pub fn take(&mut self, stream: &str) -> VecDeque<Vec<u8>> {
        self.pending
            .remove(stream)
            .map(|p| p.held)
            .unwrap_or_default()
    }
}

/// Why a keyed stream must close.
#[derive(Debug, PartialEq, Eq)]
pub enum Broken {
    /// A frame failed to open, or credit or fragments were malformed.
    Transport,
    /// The client sent something a media connection doesn't take (4400).
    Protocol,
}

/// A stream with its keys installed.
pub struct Keyed {
    pub connection: String,
    pub transport: RelayStream,
    assembler: MessageAssembler,
}

impl Keyed {
    pub fn new(connection: String, transport: RelayStream) -> Self {
        Self {
            connection,
            transport,
            assembler: MessageAssembler::default(),
        }
    }

    /// Opens one inbound frame: a credit (answered at once), or a fragment of a client message.
    /// A whole ping is answered with a pong; a whole ack is returned for delivery.
    pub fn open(
        &mut self,
        stream: &str,
        mut frame: Vec<u8>,
        pool: &Pool,
        out: &mut Vec<Effect>,
    ) -> Result<Option<ClientMessage>, Broken> {
        let plain = self
            .transport
            .open_in_place(&mut frame)
            .map_err(|_| Broken::Transport)?;
        let result = self.take(stream, plain, pool, out);
        // The frame held plaintext: wipe it before it is dropped.
        zeroize::Zeroize::zeroize(&mut frame);
        result
    }

    fn take(
        &mut self,
        stream: &str,
        plain: &[u8],
        pool: &Pool,
        out: &mut Vec<Effect>,
    ) -> Result<Option<ClientMessage>, Broken> {
        if plain.first() == Some(&CREDIT_FLAG) {
            let amount = read_credit(plain).map_err(|_| Broken::Transport)?;
            let reply = self
                .transport
                .flow
                .credited(amount)
                .map_err(|_| Broken::Transport)?;
            if let Some(reply) = reply {
                self.seal(stream, &reply, pool, out)?;
            }
            return Ok(None);
        }
        let cost = fragment_cost(plain.len());
        if !self.transport.flow.received(cost) {
            return Err(Broken::Transport);
        }
        let message = self.assembler.push(plain).map_err(|_| Broken::Transport)?;
        if let Some(credit) = self
            .transport
            .flow
            .consumed(cost)
            .map_err(|_| Broken::Transport)?
        {
            self.seal(stream, &credit, pool, out)?;
        }
        let Some(message) = message else {
            return Ok(None);
        };
        if message.kind != FragmentKind::Json {
            return Err(Broken::Protocol);
        }
        let text = std::str::from_utf8(&message.data).map_err(|_| Broken::Protocol)?;
        match ClientMessage::parse(text).ok_or(Broken::Protocol)? {
            ClientMessage::Ping { .. } => {
                let pong =
                    serde_json::to_vec(&ServerMessage::Pong).map_err(|_| Broken::Protocol)?;
                // A pong that finds no credit is dropped; the client pings again.
                let _ = self.send(stream, FragmentKind::Json, &pong, pool, out)?;
                Ok(None)
            }
            ack => Ok(Some(ack)),
        }
    }

    /// One message to the client (a piece is binary, a control message JSON), whole or not at
    /// all: false when the client's flow window can't take every fragment of it now.
    pub fn send(
        &mut self,
        stream: &str,
        kind: FragmentKind,
        data: &[u8],
        pool: &Pool,
        out: &mut Vec<Effect>,
    ) -> Result<bool, Broken> {
        let fragments = data.len().div_ceil(media_noise::MAX_MESSAGE - 17).max(1);
        let last = data.len() - (fragments - 1) * (media_noise::MAX_MESSAGE - 17);
        let cost = (fragments - 1) * fragment_cost(media_noise::MAX_MESSAGE - 16)
            + fragment_cost(last + 1);
        if !self.transport.flow.allows(cost) {
            return Ok(false);
        }
        let mut pieces = Fragments::new(data, kind).map_err(|_| Broken::Protocol)?;
        for _ in 0..fragments {
            let mut buffer = pool.take();
            if !pieces.next_into(&mut buffer) {
                pool.give(buffer);
                break;
            }
            self.transport
                .flow
                .spend(fragment_cost(buffer.len()))
                .map_err(|_| Broken::Transport)?;
            self.transport
                .seal_in_place(&mut buffer)
                .map_err(|_| Broken::Transport)?;
            out.push(Effect::Relay(RelayEffect::Send {
                stream: stream.to_owned(),
                frame: buffer,
            }));
        }
        Ok(true)
    }

    /// A credit fragment: never held back by the window.
    fn seal(
        &mut self,
        stream: &str,
        plain: &[u8],
        pool: &Pool,
        out: &mut Vec<Effect>,
    ) -> Result<(), Broken> {
        let mut buffer = pool.take();
        buffer.extend_from_slice(plain);
        self.transport
            .seal_in_place(&mut buffer)
            .map_err(|_| Broken::Transport)?;
        out.push(Effect::Relay(RelayEffect::Send {
            stream: stream.to_owned(),
            frame: buffer,
        }));
        Ok(())
    }
}
