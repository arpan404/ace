// SPDX-License-Identifier: Apache-2.0
//! ace-media's decisions, with no I/O: every control message and ingest frame goes in, and
//! what to send and which connections to close comes out as [`Effect`]s, in order. The shell
//! executes them; a revocation's answer always follows the closes it caused.
pub mod base64;
pub mod delivery;
pub mod egress;
pub mod grants;
pub mod images;
pub mod ledger;
pub mod pieces;
pub mod recorder;
pub mod relay;
pub mod sources;
pub mod stills;
#[cfg(test)]
mod tests;

use crate::secret::Vault;
use delivery::{Delivery, MediaOut, Open};
use egress::EgressSink;
use grants::{Grant, Grants};
use images::{ImageOutcome, ImageWork, Images};
use media_core::privacy::Decision;
use media_wire::capability::Acceleration;
use media_wire::control::{EncodeSpec, EpochRange, FromMedia, Id, Level, ToMedia};
use media_wire::frame::MediaFrame;
use recorder::{RecordSpec, Recorders};
use relay::{CloseMode, Pool, RelayEffect, Relays, ToDaemon};
use sources::{IngestId, Sources};
use stills::{NoStills, StillMaker, StillOutcome, Stills};
use zeroize::Zeroizing;

#[derive(Debug)]
pub enum Effect {
    /// Send on stdout.
    Normal(FromMedia),
    /// Send on stdout with this payload (a still's JPEG).
    NormalWith(FromMedia, Vec<u8>),
    /// Send on the priority lane.
    Priority(FromMedia),
    /// Send on, or close, a client's media connection (D1).
    Media {
        connection: String,
        out: MediaOut,
    },
    /// Answer a `ping`: the shell adds what only the OS knows.
    Pong(Id),
    CloseIngest(IngestId),
    /// `shutdown`: finish within `grace_ms` and exit.
    Shutdown {
        grace_ms: u32,
    },
    /// A JPEG source's encoder thread (E4).
    Encode(EncodeEffect),
    /// A relay stream's socket (D2).
    Relay(RelayEffect),
    /// A one-shot image job for the image threads (ADR 0201).
    Image(ImageWork),
    /// Bookkeeping that must never forget is full: exit, so the supervisor restarts the
    /// process and every connection ends with it.
    Fatal(&'static str),
}

/// Picture encoder threads stuck past their deadline at which ace-media exits to be restarted.
pub const MAX_STUCK_ENCODERS: usize = 2;

/// What a JPEG source's encoder thread, or a source's reader, is told.
pub enum EncodeEffect {
    /// Start reading a source ace-media reads itself (a Simulator's serve-sim stream) under
    /// `token`; its units come back as encoded units, its end as a drain or a failure.
    Read {
        source: String,
        token: u64,
        url: String,
    },
    Configure {
        source: String,
        /// The encoder this is for (`Sources` gives each encoder one).
        token: u64,
        encodes: Vec<EncodeSpec>,
    },
    Picture {
        source: String,
        /// The encoder this is for (`Sources` gives each encoder one).
        token: u64,
        text: Vec<u8>,
        epoch: u32,
        age_us: u32,
    },
    Key {
        source: String,
        /// The encoder this is for (`Sources` gives each encoder one).
        token: u64,
        encode: u32,
    },
    /// Hand over every unit still pending, then say so (`encoder_drained`).
    Drain {
        source: String,
        /// The encoder this is for (`Sources` gives each encoder one).
        token: u64,
    },
    Close {
        source: String,
        /// The encoder this is for (`Sources` gives each encoder one).
        token: u64,
    },
}

/// Names only: a picture's bytes are never printed.
impl std::fmt::Debug for EncodeEffect {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Configure {
                source, encodes, ..
            } => {
                write!(f, "Configure({source}, {} encodes)", encodes.len())
            }
            Self::Picture { source, epoch, .. } => write!(f, "Picture({source}, epoch {epoch})"),
            Self::Key { source, encode, .. } => write!(f, "Key({source}, {encode})"),
            Self::Drain { source, .. } => write!(f, "Drain({source})"),
            Self::Read { source, .. } => write!(f, "Read({source})"),
            Self::Close { source, .. } => write!(f, "Close({source})"),
        }
    }
}

pub(crate) fn normal(out: &mut Vec<Effect>, message: FromMedia) {
    out.push(Effect::Normal(message));
}

/// A pull's answer, or a stream that broke its bounds, for the daemon.
fn relay_in(out: &mut Vec<Effect>, stream: Id, next: ToDaemon) {
    match next {
        ToDaemon::Nothing => {}
        ToDaemon::Frame(frame) => {
            out.push(Effect::NormalWith(FromMedia::RelayIn { stream }, frame))
        }
        ToDaemon::Failed(reason) => normal(
            out,
            FromMedia::RelayFailed {
                stream,
                reason: reason.into(),
            },
        ),
    }
}

pub(crate) fn priority(out: &mut Vec<Effect>, message: FromMedia) {
    out.push(Effect::Priority(message));
}

/// A log line for the daemon. Only ids and states, never payloads.
pub(crate) fn log(out: &mut Vec<Effect>, level: Level, message: &str, id: &Id) {
    normal(
        out,
        FromMedia::Log {
            level,
            message: message.into(),
            fields: serde_json::json!({ "id": id.get() }),
        },
    );
}

/// The two clocks the core is given: ace-media's own monotonic clock (milliseconds for holding
/// bounds, microseconds for timing recorded samples) and the daemon's wall clock in
/// milliseconds, for ticket expiry.
#[derive(Clone, Copy, Debug)]
pub struct Now {
    pub mono_ms: u64,
    pub mono_us: u64,
    pub wall_ms: u64,
}

/// Counts for `pong.stats`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Counts {
    pub sources: u64,
    pub viewers: u64,
    pub connections: u64,
    pub bytes_out: u64,
}

pub struct Engine {
    vault: Vault,
    sources: Sources,
    grants: Grants,
    recorders: Box<dyn Recorders>,
    egress: Box<dyn EgressSink>,
    stills: Stills,
    images: Images,
    relays: Relays,
    pool: Pool,
    delivery: Delivery,
    bytes_out: u64,
    out: Vec<Effect>,
}

impl Engine {
    pub fn new(recorders: Box<dyn Recorders>, egress: Box<dyn EgressSink>) -> Self {
        Self {
            vault: Vault::new(),
            sources: Sources::default(),
            grants: Grants::default(),
            recorders,
            egress,
            stills: Stills::new(Box::new(NoStills)),
            images: Images::default(),
            relays: Relays::default(),
            pool: Pool::default(),
            delivery: Delivery::default(),
            bytes_out: 0,
            out: Vec::new(),
        }
    }

    /// Stills are made by `maker`; without one every `still.take` fails at once.
    pub fn with_stills(mut self, maker: Box<dyn StillMaker>) -> Self {
        self.stills = Stills::new(maker);
        self
    }

    /// `capabilities.changed`: what the probe found now.
    pub fn capabilities_changed(&mut self, capabilities: &[media_wire::control::Capability]) {
        self.stills.capabilities(capabilities);
    }

    /// A still a maker finished.
    pub fn still_finished(&mut self, outcome: StillOutcome) {
        self.stills.finished(outcome, &mut self.out);
    }

    /// An image job an image thread finished (or refused).
    pub fn image_finished(&mut self, outcome: ImageOutcome) {
        self.images.finished(outcome, &mut self.out);
    }

    /// Image jobs waiting on the image threads.
    pub fn images_waiting(&self) -> usize {
        self.images.waiting()
    }

    /// Whether effects are waiting to be carried out.
    pub fn has_effects(&self) -> bool {
        !self.out.is_empty()
    }

    /// The effects produced so far, in the order they must happen.
    pub fn effects(&mut self) -> std::vec::Drain<'_, Effect> {
        self.route_relay();
        self.out.drain(..)
    }

    /// Delivery speaks to connections; a relay connection's messages are sealed for its stream
    /// here, in place, so they keep their order among the other effects.
    fn route_relay(&mut self) {
        if !self.out.iter().any(|e| matches!(e, Effect::Media { connection, .. } if self.grants.relay_stream_of(connection).is_some())) {
            return;
        }
        let pending = std::mem::take(&mut self.out);
        for effect in pending {
            match effect {
                Effect::Media { connection, out } if self.is_relay(&connection) => {
                    self.relay_media(&connection, out)
                }
                other => self.out.push(other),
            }
        }
    }

    pub fn counts(&self) -> Counts {
        Counts {
            sources: self.sources.len() as u64,
            viewers: self.delivery.views() as u64,
            connections: self.grants.connections() as u64,
            bytes_out: self.bytes_out + self.delivery.bytes_out(),
        }
    }

    /// One control message from either lane. Its payload is wiped when this returns, unless it
    /// was handed on (pictures).
    pub fn control(&mut self, message: ToMedia, payload: Zeroizing<Vec<u8>>, now: Now) {
        self.apply_control(message, payload, now);
        self.closed_connections(now);
    }

    /// Connections the grants dropped: delivery ends their views and closes their sockets.
    fn closed_connections(&mut self, now: Now) {
        for (connection, reason) in self.grants.take_closed() {
            self.delivery
                .connection_closed(&connection, &reason, now.mono_ms, &mut self.out);
        }
    }

    fn apply_control(&mut self, message: ToMedia, payload: Zeroizing<Vec<u8>>, now: Now) {
        let out = &mut self.out;
        let vault = &mut self.vault;
        match message {
            ToMedia::Init { .. } => log(out, Level::Warn, "init repeated", &id("init")),
            ToMedia::Ping { id } => out.push(Effect::Pong(id)),
            ToMedia::Shutdown { grace_ms } => out.push(Effect::Shutdown { grace_ms }),
            // The listener for clients is D1's; ace-media takes the certificate and drops it.
            ToMedia::Listen { .. } => {}
            ToMedia::SourceOpen {
                source,
                handle,
                epoch,
                origin,
                ..
            } => {
                self.sources.open(
                    &source,
                    handle,
                    epoch,
                    &origin,
                    &payload,
                    vault,
                    now.mono_ms,
                    self.egress.as_mut(),
                    out,
                );
                match self.sources.handle(source.get()) {
                    Some(handle) => self.stills.open(source.get(), handle),
                    None => self.stills.close(source.get(), out),
                }
            }
            ToMedia::SourcePage {
                source,
                width,
                height,
                scale,
            } => self.delivery.page(source.get(), width, height, scale.get()),
            ToMedia::SourceCodecs { source, codecs } => {
                self.delivery
                    .codecs(source.get(), &codecs, now.mono_ms, out)
            }
            ToMedia::SourcePicture {
                source,
                epoch,
                age_ms,
            } => {
                let mut payload = payload;
                let bytes = std::mem::take(&mut *payload);
                self.stills.picture(source.get(), &bytes, epoch);
                self.sources.picture(
                    source.get(),
                    epoch,
                    age_ms,
                    bytes,
                    now,
                    self.egress.as_mut(),
                    out,
                );
            }
            ToMedia::SourceEpoch {
                source,
                seq,
                epoch,
                follows_private,
            } => self
                .sources
                .epoch(&source, &seq, epoch, follows_private, now.mono_ms, out),
            ToMedia::RecordEpochs {
                source,
                recording,
                seq,
                decided,
                clear,
                discard,
            } => {
                let ranges =
                    |r: Vec<EpochRange>| r.iter().map(|r| (r.get()[0], r.get()[1])).collect();
                let discard: Vec<(u32, u32)> = ranges(discard);
                // A discarded epoch is a fact about the source: posters stop showing it at
                // once, whatever order the recording applies its decisions in.
                self.stills.discard(source.get(), &discard);
                let decision = Decision {
                    seq: seq.get(),
                    decided,
                    clear: ranges(clear),
                    discard,
                };
                self.sources
                    .decide(&source, &recording, decision, now.mono_ms, out);
            }
            ToMedia::SourceClose { source } => {
                self.sources.close_source(
                    source.get(),
                    vault,
                    now.mono_ms,
                    self.egress.as_mut(),
                    out,
                );
                self.stills.close(source.get(), out);
                self.delivery.source_closed(source.get());
            }
            ToMedia::SourceEgress { source, on } => self.sources.egress(&source, on, out),
            ToMedia::SourceEncodes { source, encodes } => {
                self.sources.encodes(&source, encodes, out)
            }
            ToMedia::SourceKey { source, encode } => self.sources.key(&source, encode, out),
            ToMedia::MediaTicket {
                connection,
                owner,
                issued,
                expires_at,
            } => self.grants.ticket(
                Grant {
                    kind: "media.ticket",
                    id: &connection,
                    connection: &connection,
                    owner: &owner,
                    issued: issued.get(),
                },
                expires_at.get(),
                &payload,
                vault,
                now.wall_ms,
                out,
            ),
            ToMedia::ViewerOpen {
                viewer,
                connection,
                owner,
                issued,
                source,
                target,
                codecs,
                viewport,
                local,
                audio,
                link,
            } => {
                let granted = self.grants.viewer(
                    Grant {
                        kind: "viewer.open",
                        id: &viewer,
                        connection: &connection,
                        owner: &owner,
                        issued: issued.get(),
                    },
                    out,
                );
                if granted {
                    let hint_bps = link
                        .and_then(|l| l.downlink_kbps)
                        .map(|kbps| f64::from(kbps) * 1000.0);
                    let replaced = self.delivery.open(
                        Open {
                            viewer,
                            connection: connection.get().to_owned(),
                            session: owner.session.get().to_owned(),
                            source: source.get().to_owned(),
                            target,
                            codecs,
                            viewport,
                            audio,
                            local,
                            hint_bps,
                        },
                        now.mono_ms,
                        out,
                    );
                    for viewer in replaced {
                        self.grants.viewer_close(&viewer);
                    }
                }
            }
            ToMedia::ViewerConfigure {
                viewer,
                viewport,
                audio,
            } => self
                .delivery
                .configure(viewer.get(), viewport, audio, now.mono_ms, out),
            ToMedia::ViewerPause { viewer } => self.delivery.pause(viewer.get(), now.mono_ms, out),
            ToMedia::ViewerResume { viewer } => {
                self.delivery.resume(viewer.get(), now.mono_ms, out)
            }
            ToMedia::SessionLink {
                session, rtt_ms, ..
            } => self
                .delivery
                .session_link(session.get(), rtt_ms, now.mono_ms, out),
            ToMedia::ViewerClose { viewer } => {
                self.grants.viewer_close(viewer.get());
                self.delivery.close_view(viewer.get(), now.mono_ms, out);
            }
            ToMedia::RelayDial { stream, url } => {
                let refused = if self.grants.stream_closed(stream.get()) {
                    Err("closed")
                } else if self.relays.pending() + self.grants.streams() >= grants::MAX_STREAMS {
                    Err("limit")
                } else {
                    self.relays.dial(stream.get(), &url, out)
                };
                if let Err(reason) = refused {
                    normal(
                        out,
                        FromMedia::RelayFailed {
                            stream,
                            reason: reason.into(),
                        },
                    );
                }
            }
            ToMedia::RelayOut { stream } => {
                let mut payload = payload;
                let frame = std::mem::take(&mut *payload);
                self.relays.send(stream.get(), frame, out);
            }
            ToMedia::RelayPull { stream } => {
                let next = self.relays.pull(stream.get());
                relay_in(out, stream, next);
            }
            ToMedia::RelayKeys {
                stream,
                connection,
                owner,
                issued,
            } => {
                let dialed = self.relays.is_dialed(stream.get());
                let installed = self.grants.relay_keys(
                    Grant {
                        kind: "relay.keys",
                        id: &stream,
                        connection: &connection,
                        owner: &owner,
                        issued: issued.get(),
                    },
                    payload,
                    dialed,
                    vault,
                    now.wall_ms,
                    out,
                );
                if !installed {
                    // A stream that isn't this process's stays as it was.
                    if !dialed {
                        return;
                    }
                    self.relays.take(stream.get());
                    self.grants
                        .close_stream(stream.get(), CloseMode::Forced, out);
                    return;
                }
                // The relay channel's welcome was the daemon's; the views start now.
                self.delivery.attached(&connection, now.mono_ms, out);
                // What the client sent after its hello, which the daemon never pulled.
                for frame in self.relays.take(stream.get()) {
                    self.relay_opened(stream.get(), frame, now);
                }
            }
            ToMedia::RelayClose { id, stream, .. } => {
                self.relays.take(stream.get());
                // The daemon's close: what it sent (a refusal) still reaches the client.
                self.grants
                    .close_stream(stream.get(), CloseMode::Graceful, out);
                priority(out, FromMedia::Closed { id });
            }
            ToMedia::ConnectionClose {
                id,
                connection,
                reason,
            } => {
                self.grants.close(connection.get(), &reason, vault, out);
                priority(out, FromMedia::Closed { id });
            }
            ToMedia::Revoke {
                id,
                issued,
                device,
                admission,
            } => {
                self.grants
                    .revoke(issued.get(), &device, admission.as_ref(), vault, out);
                priority(out, FromMedia::Revoked { id });
            }
            ToMedia::RecordStart {
                recording,
                source,
                directory,
                max_bytes,
                pointer_track,
            } => {
                let spec = RecordSpec {
                    recording: recording.get(),
                    source: source.get(),
                    directory: &directory,
                    max_bytes: max_bytes.get(),
                    pointer_track,
                };
                self.sources.record_start(
                    &spec,
                    &recording,
                    self.recorders.as_mut(),
                    now.mono_ms,
                    out,
                );
            }
            ToMedia::RecordCut { recording, .. } => self.sources.record_cut(recording.get()),
            ToMedia::RecordMeta {
                recording,
                epoch,
                data,
            } => self
                .sources
                .record_meta(recording.get(), epoch, data, now, out),
            ToMedia::RecordStop { recording } => self.sources.record_stop(&recording, out),
            ToMedia::StillTake {
                request,
                source,
                max_width,
                max_height,
                max_pixels,
                quality,
                deadline_ms,
            } => self.stills.take(
                request,
                &source,
                media_codec::Size {
                    width: max_width,
                    height: max_height,
                },
                max_pixels,
                quality,
                deadline_ms,
                now.mono_ms,
                out,
            ),
            ToMedia::StillPoster {
                request,
                source,
                width,
                height,
                deadline_ms,
                clear,
            } => self.stills.poster(
                request,
                &source,
                media_codec::Size { width, height },
                deadline_ms,
                clear.iter().map(|r| (r.get()[0], r.get()[1])).collect(),
                now.mono_ms,
                out,
            ),
            ToMedia::ImageJob {
                request,
                deadline_ms,
                inputs,
                op,
            } => self
                .images
                .job(request, deadline_ms, inputs, op, payload, now.mono_ms, out),
            ToMedia::ImageCancel { request } => self.images.cancel(&request, out),
        }
    }

    /// The pooled buffers relay frames are sealed into; the shell gives each back once written.
    pub fn relay_pool(&self) -> Pool {
        self.pool.clone()
    }

    /// A relay stream's socket is up. False when the stream closed meanwhile: drop the socket.
    pub fn relay_dialed(&mut self, stream: &Id) -> bool {
        if !self.relays.dialed(stream.get()) {
            return false;
        }
        normal(
            &mut self.out,
            FromMedia::RelayDialed {
                stream: stream.clone(),
            },
        );
        true
    }

    /// A frame arrived on a relay stream's socket.
    pub fn relay_frame(&mut self, stream: &Id, frame: Vec<u8>, now: Now) {
        if self.relays.is_pending(stream.get()) {
            let next = self.relays.arrived(stream.get(), frame);
            if matches!(next, ToDaemon::Failed(_)) {
                self.grants
                    .close_stream(stream.get(), CloseMode::Forced, &mut self.out);
            }
            return relay_in(&mut self.out, stream.clone(), next);
        }
        self.relay_opened(stream.get(), frame, now);
        self.closed_connections(now);
    }

    /// A keyed stream's frame: its client message goes to delivery, as a direct connection's.
    fn relay_opened(&mut self, stream: &str, frame: Vec<u8>, now: Now) {
        let opened =
            self.grants
                .relay_frame(stream, frame, &self.pool, &mut self.vault, &mut self.out);
        let Some((connection, message)) = opened else {
            return;
        };
        if !self
            .delivery
            .client(&connection, message, now.mono_ms, &mut self.out)
        {
            log(
                &mut self.out,
                Level::Warn,
                "media connection closed: a message it doesn't take",
                &id_of(&connection),
            );
            self.grants
                .close(&connection, "protocol", &mut self.vault, &mut self.out);
        }
    }

    /// Whether a connection is a relay stream's (its delivery goes through [`Self::relay_media`]).
    pub fn is_relay(&self, connection: &str) -> bool {
        self.grants.relay_stream_of(connection).is_some()
    }

    /// What delivery sends on a relay connection: sealed for its stream, or its stream shut.
    /// A piece the client's flow window can't take now is dropped; delivery's acks and keyframe
    /// requests recover the picture.
    pub fn relay_media(&mut self, connection: &str, message: MediaOut) {
        match message {
            MediaOut::Binary(bytes) => {
                self.relay_send(connection, true, &bytes);
            }
            MediaOut::Text(text) => {
                self.relay_send(connection, false, text.as_bytes());
            }
            MediaOut::Close(code) => {
                use media_wire::media_link::close;
                let mode = match code {
                    close::REVOKED | close::PROTOCOL => CloseMode::Forced,
                    _ => CloseMode::Graceful,
                };
                if let Some(stream) = self.grants.relay_stream_of(connection).map(str::to_owned) {
                    self.grants.close_stream(&stream, mode, &mut self.out);
                }
            }
        }
    }

    /// A relay stream's socket failed to open or dropped. Before its keys the daemon hears
    /// `relay.failed`; after them the stream's connection ends.
    pub fn relay_ended(&mut self, stream: &Id, reason: &str, now: Now) {
        let out = &mut self.out;
        if self.relays.is_pending(stream.get()) {
            self.relays.take(stream.get());
            // The socket is gone already.
            self.grants
                .close_stream(stream.get(), CloseMode::Forced, out);
            return normal(
                out,
                FromMedia::RelayFailed {
                    stream: stream.clone(),
                    reason: reason.into(),
                },
            );
        }
        if let Some(connection) = self
            .grants
            .stream_connection(stream.get())
            .map(str::to_owned)
        {
            self.grants
                .close(&connection, "relay-closed", &mut self.vault, out);
        }
        self.closed_connections(now);
    }

    /// A relay stream's socket is gone (the shell's close finished).
    pub fn relay_closed(&mut self, stream: &Id) {
        self.grants.relay_closed(stream.get());
    }

    /// One message to a relay connection's client (D1's delivery): false when it can't go now.
    pub fn relay_send(&mut self, connection: &str, binary: bool, data: &[u8]) -> bool {
        let kind = if binary {
            media_noise::FragmentKind::Binary
        } else {
            media_noise::FragmentKind::Json
        };
        let sent = self
            .grants
            .relay_send(connection, kind, data, &self.pool, &mut self.out);
        if sent {
            self.bytes_out += data.len() as u64;
        }
        sent
    }

    /// An ingest connection's hello token. True when it named an open source, which the
    /// connection now feeds; otherwise the connection is to be closed.
    pub fn ingest_hello(&mut self, conn: IngestId, token: &[u8]) -> bool {
        self.sources
            .hello(conn, token, &mut self.vault, &mut self.out)
    }

    /// A frame from an ingest connection the engine admitted.
    pub fn ingest(&mut self, conn: IngestId, frame: MediaFrame, now: Now) {
        if let Some(source) = self.sources.bound(conn) {
            self.stills.frame(source, &frame, &mut self.out);
            self.delivery
                .unit(source, &frame, now.mono_ms, now.wall_ms, &mut self.out);
        }
        self.sources
            .ingest(conn, frame, now, self.egress.as_mut(), &mut self.out);
    }

    /// A unit a JPEG source's encoder thread finished.
    pub fn encoded(&mut self, source: &str, token: u64, frame: MediaFrame, now: Now) {
        if self.sources.encoder_is(source, token) {
            self.delivery
                .unit(source, &frame, now.mono_ms, now.wall_ms, &mut self.out);
        }
        self.sources.encoded(
            source,
            token,
            frame,
            now,
            self.egress.as_mut(),
            &mut self.out,
        );
    }

    /// A JPEG source's steps, as its encoder thread chose them.
    pub fn encoder_steps(&mut self, source: &str, token: u64, acceleration: Acceleration) {
        self.sources
            .encoder_steps(source, token, acceleration, &mut self.out);
    }

    /// A closed JPEG source's encoder handed over its last output: the source ends cleanly.
    pub fn encoder_drained(&mut self, source: &str, token: u64) {
        self.sources
            .encoder_drained(source, token, self.egress.as_mut(), &mut self.out);
    }

    /// The shell's count of picture encoder threads still alive past their deadline. They hold
    /// their slots until they exit; two or more and ace-media exits, so the supervisor restarts
    /// it and the OS frees what they hold (a thread can't be stopped safely from outside).
    pub fn encoders_stuck(&mut self, stuck: usize) {
        self.sources.encoders_stuck(stuck);
        if stuck >= MAX_STUCK_ENCODERS {
            self.out
                .push(Effect::Fatal("picture encoder threads are stuck"));
        }
    }

    /// A JPEG source's encoder could not run: the source ends, so the daemon takes it back.
    pub fn encoder_failed(&mut self, source: &str, token: u64, reason: &str) {
        self.sources
            .encoder_failed(source, token, reason, self.egress.as_mut(), &mut self.out);
    }

    pub fn ingest_closed(&mut self, conn: IngestId, now: Now) {
        self.sources
            .ingest_closed(conn, now.mono_ms, self.egress.as_mut(), &mut self.out);
    }

    /// A client presented a ticket on the direct listener (D1).
    pub fn claim_ticket(&mut self, presented: &[u8], now: Now) -> Option<Id> {
        let claimed = self
            .grants
            .claim(presented, &mut self.vault, now.wall_ms, &mut self.out);
        if let Some(connection) = &claimed {
            self.delivery
                .socket_open(connection, now.mono_ms, &mut self.out);
        }
        self.closed_connections(now);
        claimed
    }

    /// A text message on an open media connection. A message a media connection doesn't take
    /// closes it (`4400`), and the daemon hears `connection.closed`.
    pub fn media_message(&mut self, connection: &str, text: &str, now: Now) {
        let accepted = media_wire::media_link::ClientMessage::parse(text).is_some_and(|message| {
            self.delivery
                .client(connection, message, now.mono_ms, &mut self.out)
        });
        if !accepted {
            log(
                &mut self.out,
                Level::Warn,
                "media connection closed: a message it doesn't take",
                &id_of(connection),
            );
            self.out.push(Effect::Media {
                connection: connection.to_owned(),
                out: MediaOut::Close(media_wire::media_link::close::PROTOCOL),
            });
            self.grants
                .close(connection, "protocol", &mut self.vault, &mut self.out);
            self.closed_connections(now);
        }
    }

    /// A client's media connection closed: the connection ends for good.
    pub fn media_closed(&mut self, connection: &str, now: Now) {
        self.grants
            .close(connection, "client-closed", &mut self.vault, &mut self.out);
        self.closed_connections(now);
    }

    /// Periodic: barrier hold bounds and ticket expiry.
    pub fn tick(&mut self, now: Now) {
        self.sources
            .tick(now.mono_ms, self.egress.as_mut(), &mut self.out);
        self.stills.tick(now.mono_ms, &mut self.out);
        self.images.tick(now.mono_ms, &mut self.out);
        self.grants
            .tick(&mut self.vault, now.wall_ms, &mut self.out);
        self.closed_connections(now);
        self.delivery.tick(now.mono_ms, &mut self.out);
    }

    /// Shutdown or stdin closing: close every recording and connection.
    pub fn finish(&mut self) {
        self.sources.finish_all(&mut self.out);
        self.stills.finish(&mut self.out);
        self.images.finish(&mut self.out);
        self.grants
            .close_all("shutdown", &mut self.vault, &mut self.out);
        let now = Now {
            mono_ms: 0,
            mono_us: 0,
            wall_ms: 0,
        };
        self.closed_connections(now);
    }
}

fn id_of(value: &str) -> Id {
    Id::new(value.chars().take(64).collect()).unwrap_or_else(|_| unreachable!())
}

fn id(value: &str) -> Id {
    Id::new(value.to_owned()).unwrap_or_else(|_| unreachable!())
}
