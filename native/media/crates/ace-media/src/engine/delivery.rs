// SPDX-License-Identifier: Apache-2.0
//! Delivery to viewers (D1, ADR 0147 §4). Pure: units, acks and grants go in; pieces for each
//! media connection, keyframe requests and `source.want` come out as effects.
//!
//! - **Views.** A granted `viewer.open` is a view of one source on one media connection. It is
//!   paced by its own ack window (`media_core::fanout`) and link estimate
//!   (`media_core::link_rate`), and gets nothing while paused or before its connection's socket
//!   is open; its first picture after either is a keyframe.
//! - **Plans.** Each source's views are planned together (`media_core::plan`): the encodes
//!   they need go to the daemon as `source.want`, which it applies to the producer. Encode ids
//!   start at 0, so a producer with one encode (the Mac screen helper) needs no mapping.
//! - **Video's share.** A view takes at most 70 % of its link estimate, and half that while
//!   `session.link` shows its main session's round trip inflating (smoothed above 1.5 × its
//!   10 s minimum), so live video never starves the session that owns it (ADR 0149).
use super::pieces::{build, captured_ms};
use super::{Effect, normal};
use media_core::fanout::{Event, Piece, Viewer as Fanout, Window};
use media_core::link_rate::{Limits, LinkRate};
use media_core::plan::{Source as PlanSource, VideoViewer, Viewport as PlanViewport, plan_video};
use media_wire::control::{
    EncodeSpec, FromMedia, Id, KeyReason, Nonnegative, Sequence, ViewerTarget, Viewport,
};
use media_wire::frame::MediaFrame;
use media_wire::media_link::{ClientMessage, ServerMessage, close};
use std::collections::{HashMap, VecDeque};

/// The share of a view's link estimate video takes, and while its session's round trip inflates.
pub const VIDEO_SHARE: f64 = 0.7;
pub const VIDEO_SHARE_CUT: f64 = 0.35;
/// A session's round trip counts as inflating above this multiple of its 10 s minimum.
pub const INFLATION: f64 = 1.5;
const RTT_WINDOW_MS: u64 = 10_000;
/// At most one keyframe request per encode in this time.
const KEYFRAME_SPACING_MS: u64 = 200;
const STATS_MS: u64 = 1_000;
const FRAME_AUDIO: u8 = 2;

/// Whose view an ack is for, in the client's ids.
enum Acked {
    Browser(Id),
    Screen(Id),
    Device(Id),
}

impl Acked {
    fn names(&self, target: &ViewerTarget) -> bool {
        match (self, target) {
            (Self::Browser(a), ViewerTarget::Browser { thread_id, .. }) => a == thread_id,
            (Self::Screen(a), ViewerTarget::Screen { session_id }) => a == session_id,
            (Self::Device(a), ViewerTarget::Device { device_id }) => a == device_id,
            _ => false,
        }
    }
}

/// What goes out on a media connection.
#[derive(Debug, PartialEq)]
pub enum MediaOut {
    Binary(Vec<u8>),
    Text(String),
    /// Close with this WebSocket code.
    Close(u16),
}

/// A granted `viewer.open`, as the engine hands it over.
pub struct Open {
    pub viewer: Id,
    pub connection: String,
    pub session: String,
    pub source: String,
    pub target: ViewerTarget,
    pub codecs: Vec<String>,
    pub viewport: Viewport,
    pub audio: bool,
    pub local: bool,
    /// The client's downlink estimate, in bit/s: it may lower where the view starts.
    pub hint_bps: Option<f64>,
}

struct View {
    id: Id,
    connection: String,
    session: String,
    source: String,
    target: ViewerTarget,
    codecs: Vec<String>,
    viewport: Viewport,
    audio: bool,
    paused: bool,
    fanout: Fanout,
    rate: LinkRate,
    hint_bps: Option<f64>,
    /// The encode its plan gives it.
    encode: Option<u32>,
    /// The encode it is sent: its planned one once the producer sends that, else the closest
    /// one the producer does send (a producer still planned by the daemon, D1).
    taking: Option<u32>,
    sequence: u64,
    held: VecDeque<(u64, Vec<Vec<u8>>)>,
    frames: u32,
    dropped: u64,
}

#[derive(Default)]
struct SourceFacts {
    /// The page's CSS size and scale (`source.page`), or the last unit's display size.
    page: Option<(f64, f64, f64)>,
    /// What the producer can encode (`source.codecs`); empty: whatever the views decode.
    codecs: Vec<String>,
    ids: HashMap<String, u32>,
    wanted: Vec<EncodeSpec>,
    keyframes: HashMap<u32, u64>,
    /// The encodes the producer actually sends: coded size, codec and when last seen.
    seen: HashMap<u32, Seen>,
}

struct Seen {
    width: u16,
    height: u16,
    codec: String,
    at_ms: u64,
}

/// An encode not seen for this long no longer counts as produced.
const SEEN_MS: u64 = 2_000;

#[derive(Default)]
struct Session {
    samples: VecDeque<(u64, u32)>,
    inflating: bool,
}

#[derive(Default)]
pub struct Delivery {
    views: HashMap<String, View>,
    sources: HashMap<String, SourceFacts>,
    sockets: HashMap<String, ()>,
    sessions: HashMap<String, Session>,
    message: u32,
    last_stats: u64,
    bytes_out: u64,
    /// The capture time of the unit being delivered.
    stamp: f64,
}

fn media(out: &mut Vec<Effect>, connection: &str, message: MediaOut) {
    out.push(Effect::Media {
        connection: connection.to_owned(),
        out: message,
    });
}

fn id(value: &str) -> Id {
    Id::new(value.chars().take(64).collect()).unwrap_or_else(|_| unreachable!())
}

impl Delivery {
    pub fn bytes_out(&self) -> u64 {
        self.bytes_out
    }

    pub fn views(&self) -> usize {
        self.views.len()
    }

    fn share(&self, session: &str) -> f64 {
        match self.sessions.get(session) {
            Some(s) if s.inflating => VIDEO_SHARE_CUT,
            _ => VIDEO_SHARE,
        }
    }

    /// A granted view. Replacing one with the same id starts it over.
    pub fn open(&mut self, open: Open, now_ms: u64, out: &mut Vec<Effect>) {
        let limits = if open.local {
            Limits {
                initial: 8_000_000.0,
                ..Limits::default()
            }
        } else {
            Limits::default()
        };
        let source = open.source.clone();
        if let Some(old) = self.views.remove(open.viewer.get())
            && old.source != source
        {
            self.replan(&old.source, now_ms, out);
        }
        self.views.insert(
            open.viewer.get().to_owned(),
            View {
                id: open.viewer,
                connection: open.connection,
                session: open.session,
                source: open.source,
                target: open.target,
                codecs: open.codecs,
                viewport: open.viewport,
                audio: open.audio,
                paused: false,
                fanout: Fanout::new(Window::default()),
                rate: LinkRate::new(limits),
                hint_bps: open.hint_bps,
                encode: None,
                taking: None,
                sequence: 0,
                held: VecDeque::new(),
                frames: 0,
                dropped: 0,
            },
        );
        self.replan(&source, now_ms, out);
    }

    pub fn configure(
        &mut self,
        viewer: &str,
        viewport: Viewport,
        audio: bool,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        let Some(view) = self.views.get_mut(viewer) else {
            return;
        };
        view.viewport = viewport;
        view.audio = audio;
        let source = view.source.clone();
        self.replan(&source, now_ms, out);
    }

    pub fn close_view(&mut self, viewer: &str, now_ms: u64, out: &mut Vec<Effect>) {
        if let Some(view) = self.views.remove(viewer) {
            self.replan(&view.source, now_ms, out);
        }
    }

    /// `viewer.pause`: nothing is sent to it until `viewer.resume`, which starts at a keyframe.
    pub fn pause(&mut self, viewer: &str, now_ms: u64, out: &mut Vec<Effect>) {
        let Some(view) = self.views.get_mut(viewer) else {
            return;
        };
        view.paused = true;
        let mut events = Vec::new();
        view.fanout.stop(|e| events.push(e));
        view.encode = None;
        view.taking = None;
        view.held.clear();
        let source = view.source.clone();
        self.events(viewer, events, now_ms, out);
        self.replan(&source, now_ms, out);
    }

    pub fn resume(&mut self, viewer: &str, now_ms: u64, out: &mut Vec<Effect>) {
        let Some(view) = self.views.get_mut(viewer) else {
            return;
        };
        view.paused = false;
        let source = view.source.clone();
        self.replan(&source, now_ms, out);
    }

    /// `source.page`: the size views are planned against.
    pub fn page(&mut self, source: &str, width: u32, height: u32, scale: f64) {
        let facts = self.sources.entry(source.to_owned()).or_default();
        facts.page = Some((f64::from(width), f64::from(height), scale.max(0.1)));
    }

    /// `source.codecs`: what the producer's encoder supports.
    pub fn codecs(&mut self, source: &str, codecs: &[String], now_ms: u64, out: &mut Vec<Effect>) {
        self.sources.entry(source.to_owned()).or_default().codecs = codecs.to_vec();
        self.replan(source, now_ms, out);
    }

    /// The source closed: its views stay granted and get its replacement's units (a reopened
    /// source has the same id), starting at a keyframe.
    pub fn source_closed(&mut self, source: &str) {
        self.sources.remove(source);
        for view in self.views.values_mut().filter(|v| v.source == source) {
            let mut ignored = Vec::new();
            view.fanout.stop(|e| ignored.push(e));
            view.encode = None;
            view.taking = None;
            view.held.clear();
        }
    }

    /// A client presented its ticket: the connection is open, and its views start at a keyframe.
    pub fn socket_open(&mut self, connection: &Id, now_ms: u64, out: &mut Vec<Effect>) {
        self.sockets.insert(connection.get().to_owned(), ());
        let welcome = ServerMessage::Welcome {
            connection: connection.clone(),
        };
        if let Ok(text) = serde_json::to_string(&welcome) {
            media(out, connection.get(), MediaOut::Text(text));
        }
        let sources: Vec<String> = self
            .views
            .values()
            .filter(|v| v.connection == connection.get())
            .map(|v| v.source.clone())
            .collect();
        for source in sources {
            self.replan(&source, now_ms, out);
        }
    }

    /// The connection closed for `reason` (revoked, its session closed, expired, shutdown): its
    /// views go, and its socket closes with the matching code.
    pub fn connection_closed(
        &mut self,
        connection: &str,
        reason: &str,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        if self.sockets.remove(connection).is_some() {
            let code = match reason {
                "revoked" => close::REVOKED,
                "shutdown" => close::GOING_AWAY,
                _ => close::CLOSED,
            };
            media(out, connection, MediaOut::Close(code));
        }
        let gone: Vec<String> = self
            .views
            .iter()
            .filter(|(_, v)| v.connection == connection)
            .map(|(k, _)| k.clone())
            .collect();
        let mut sources = Vec::new();
        for key in gone {
            if let Some(view) = self.views.remove(&key) {
                sources.push(view.source);
            }
        }
        sources.sort();
        sources.dedup();
        for source in sources {
            self.replan(&source, now_ms, out);
        }
    }

    /// `session.link`: the main session's smoothed round trip, for video's share of the link.
    pub fn session_link(&mut self, session: &str, rtt_ms: u32, now_ms: u64, out: &mut Vec<Effect>) {
        let entry = self.sessions.entry(session.to_owned()).or_default();
        entry.samples.push_back((now_ms, rtt_ms));
        while entry
            .samples
            .front()
            .is_some_and(|(at, _)| now_ms.saturating_sub(*at) > RTT_WINDOW_MS)
        {
            entry.samples.pop_front();
        }
        let floor = entry
            .samples
            .iter()
            .map(|(_, r)| *r)
            .min()
            .unwrap_or(rtt_ms);
        let inflating = floor > 0 && f64::from(rtt_ms) > INFLATION * f64::from(floor);
        if inflating == entry.inflating {
            return;
        }
        entry.inflating = inflating;
        let mut sources: Vec<String> = self
            .views
            .values()
            .filter(|v| v.session == session)
            .map(|v| v.source.clone())
            .collect();
        sources.sort();
        sources.dedup();
        for source in sources {
            self.replan(&source, now_ms, out);
        }
    }

    /// A message from a client on its open media connection. False: close it (`4400`).
    pub fn client(
        &mut self,
        connection: &str,
        message: ClientMessage,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) -> bool {
        let (sequence, keyframe, acked) = match message {
            ClientMessage::Ping { .. } => {
                if let Ok(text) = serde_json::to_string(&ServerMessage::Pong) {
                    media(out, connection, MediaOut::Text(text));
                }
                return true;
            }
            ClientMessage::BrowserAck {
                thread_id,
                sequence,
                keyframe,
                ..
            } => (sequence, keyframe, Acked::Browser(thread_id)),
            ClientMessage::ScreenAck {
                session_id,
                sequence,
                keyframe,
                ..
            } => (sequence, keyframe, Acked::Screen(session_id)),
            ClientMessage::DevicesAck {
                device_id,
                sequence,
                keyframe,
                ..
            } => (sequence, keyframe, Acked::Device(device_id)),
        };
        let (sequence, keyframe) = (sequence.get(), keyframe == Some(true));
        let Some(key) = self
            .views
            .iter()
            .find(|(_, v)| v.connection == connection && acked.names(&v.target))
            .map(|(k, _)| k.clone())
        else {
            // An ack for a view that just closed is harmless.
            return true;
        };
        self.ack(&key, sequence, keyframe, now_ms, out);
        true
    }

    fn ack(
        &mut self,
        key: &str,
        sequence: u64,
        keyframe: bool,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        let Some(view) = self.views.get_mut(key) else {
            return;
        };
        let at = now_ms as f64;
        view.rate.acknowledged(sequence, at);
        let mut events = Vec::new();
        let mut sent = 0;
        {
            let View {
                fanout,
                held,
                connection,
                ..
            } = view;
            fanout.acknowledge(
                sequence,
                |piece| match send(out, connection, held, piece) {
                    Some(bytes) => {
                        sent += bytes;
                        true
                    }
                    None => false,
                },
                |e| events.push(e),
            );
            if keyframe {
                fanout.keyframe(|e| events.push(e));
            }
            // A unit's bytes live exactly as long as the fanout queues it.
            held.retain(|(sequence, _)| fanout.queued(*sequence));
        }
        self.bytes_out += sent;
        self.events(key, events, now_ms, out);
    }

    /// A unit of `source`: to every view of it that takes this encode.
    /// `wall_ms` is the wall clock in Unix ms: pieces carry the unit's capture time on it.
    pub fn unit(
        &mut self,
        source: &str,
        frame: &MediaFrame,
        now_ms: u64,
        wall_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        if frame.kind != 1 && frame.kind != FRAME_AUDIO {
            return;
        }
        self.stamp = captured_ms(frame, wall_ms);
        if frame.kind == 1 {
            let facts = self.sources.entry(source.to_owned()).or_default();
            facts.seen.insert(
                frame.encode,
                Seen {
                    width: frame.width,
                    height: frame.height,
                    codec: frame.codec_string.clone(),
                    at_ms: now_ms,
                },
            );
            if facts.page.is_none() && frame.display_width > 0 && frame.display_height > 0 {
                facts.page = Some((
                    f64::from(frame.display_width),
                    f64::from(frame.display_height),
                    f64::from(frame.scale.max(1)) / 1000.0,
                ));
                self.replan(source, now_ms, out);
            }
        }
        let keys: Vec<String> = self
            .views
            .iter()
            .filter(|(_, v)| {
                v.source == source && !v.paused && self.sockets.contains_key(&v.connection)
            })
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.message = self.message.wrapping_add(1);
            let message = self.message;
            let Some(view) = self.views.get_mut(&key) else {
                continue;
            };
            if frame.kind == FRAME_AUDIO {
                if !view.audio {
                    continue;
                }
                view.sequence += 1;
                let Some(built) = build(
                    &view.target,
                    source,
                    message,
                    view.sequence,
                    self.stamp,
                    frame,
                ) else {
                    continue;
                };
                for piece in built.pieces {
                    self.bytes_out += piece.len() as u64;
                    media(out, &view.connection, MediaOut::Binary(piece));
                }
                continue;
            }
            let wanted = self.sources.get(source).and_then(|facts| {
                let taking = taking(facts, view.encode, &view.codecs, now_ms);
                Some((taking?, facts))
            });
            let taking_now = wanted.map(|(t, _)| t);
            if view.taking != taking_now {
                view.taking = taking_now;
                view.held.clear();
                let mut events = Vec::new();
                view.fanout
                    .assign(taking_now.map(u64::from), |e| events.push(e));
                self.events(&key, events, now_ms, out);
                let Some(view) = self.views.get_mut(&key) else {
                    continue;
                };
                if view.taking != Some(frame.encode) {
                    continue;
                }
                self.deliver(&key, source, message, frame, now_ms, out);
                continue;
            }
            if view.taking != Some(frame.encode) {
                continue;
            }
            self.deliver(&key, source, message, frame, now_ms, out);
        }
    }

    /// One video unit to one view, through its window.
    fn deliver(
        &mut self,
        key: &str,
        source: &str,
        message: u32,
        frame: &MediaFrame,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        {
            let Some(view) = self.views.get_mut(key) else {
                return;
            };
            view.sequence += 1;
            let sequence = view.sequence;
            let Some(built) = build(&view.target, source, message, sequence, self.stamp, frame)
            else {
                return;
            };
            let mut events = Vec::new();
            let mut sent = 0;
            {
                let View {
                    fanout,
                    held,
                    connection,
                    ..
                } = view;
                held.push_back((sequence, built.pieces));
                fanout.publish(
                    u64::from(frame.encode),
                    Piece {
                        sequence,
                        key: built.key,
                        bytes: built.bytes,
                    },
                    |piece| match send(out, connection, held, piece) {
                        Some(bytes) => {
                            sent += bytes;
                            true
                        }
                        None => false,
                    },
                    |e| events.push(e),
                );
                // A unit's bytes live exactly as long as the fanout queues it: what it dropped,
                // or never took, goes with it. So the held bytes never outgrow its window.
                held.retain(|(sequence, _)| fanout.queued(*sequence));
            }
            self.bytes_out += sent;
            self.events(key, events, now_ms, out);
        }
    }

    fn events(&mut self, key: &str, events: Vec<Event>, now_ms: u64, out: &mut Vec<Effect>) {
        let Some(view) = self.views.get_mut(key) else {
            return;
        };
        let at = now_ms as f64;
        let mut keyframe = false;
        for event in events {
            match event {
                Event::Sent(piece) => {
                    view.rate.sent(piece.sequence, piece.bytes, at);
                    view.frames += 1;
                }
                Event::Dropped => {
                    view.rate.dropped(at);
                    view.dropped += 1;
                }
                Event::Keyframe => keyframe = true,
                Event::Playing(playing) => normal(
                    out,
                    FromMedia::ViewerPlaying {
                        viewer: view.id.clone(),
                        playing,
                    },
                ),
            }
        }
        let (source, encode) = (view.source.clone(), view.taking.or(view.encode));
        if keyframe && let Some(encode) = encode {
            self.request_keyframe(&source, encode, KeyReason::Viewer, now_ms, out);
        }
    }

    fn request_keyframe(
        &mut self,
        source: &str,
        encode: u32,
        reason: KeyReason,
        now_ms: u64,
        out: &mut Vec<Effect>,
    ) {
        let facts = self.sources.entry(source.to_owned()).or_default();
        let last = facts.keyframes.get(&encode).copied();
        if last.is_some_and(|at| now_ms.saturating_sub(at) < KEYFRAME_SPACING_MS) {
            return;
        }
        facts.keyframes.insert(encode, now_ms);
        normal(
            out,
            FromMedia::SourceKeyframe {
                source: id(source),
                encode,
                reason,
            },
        );
    }

    /// Plans `source`'s views again, sends `source.want` when the encodes changed, and moves
    /// each view onto its encode (a move starts at a keyframe).
    fn replan(&mut self, source: &str, now_ms: u64, out: &mut Vec<Effect>) {
        let share = |s: &str| self.share(s);
        let facts = self.sources.get(source);
        let (width, height, scale) = facts.and_then(|f| f.page).unwrap_or((1280.0, 800.0, 1.0));
        let live: Vec<&View> = self
            .views
            .values()
            .filter(|v| v.source == source && !v.paused && self.sockets.contains_key(&v.connection))
            .collect();
        let mut codecs: Vec<&str> = facts
            .map(|f| f.codecs.iter().map(String::as_str).collect())
            .unwrap_or_default();
        if codecs.is_empty() {
            codecs = live
                .iter()
                .flat_map(|v| v.codecs.iter().map(String::as_str))
                .collect();
        }
        let lists: Vec<Vec<&str>> = live
            .iter()
            .map(|v| v.codecs.iter().map(String::as_str).collect())
            .collect();
        let viewers: Vec<VideoViewer<'_>> = live
            .iter()
            .zip(lists.iter())
            .map(|(v, list)| {
                let measured = v.rate.rate();
                let link = v.hint_bps.map_or(measured, |h| h.min(measured));
                VideoViewer {
                    id: v.id.get(),
                    viewport: PlanViewport {
                        width: f64::from(v.viewport.width.max(1)),
                        height: f64::from(v.viewport.height.max(1)),
                        device_pixel_ratio: v.viewport.dpr.get().max(1.0),
                        native_shown: false,
                    },
                    codecs: list,
                    link: link * share(&v.session),
                    scale: v.viewport.scale.get().clamp(0.05, 1.0),
                }
            })
            .collect();
        let plan = plan_video(
            &PlanSource {
                width,
                height,
                scale,
                codecs: &codecs,
            },
            &viewers,
        );
        drop(viewers);
        drop(live);
        let facts = self.sources.entry(source.to_owned()).or_default();
        facts
            .ids
            .retain(|key, _| plan.encodes.iter().any(|e| e.key == *key));
        let mut wanted = Vec::with_capacity(plan.encodes.len());
        for encode in &plan.encodes {
            // A new encode takes the lowest id no kept encode holds, so a source with one
            // encode stays on 0 as it is resized.
            let id = match facts.ids.get(&encode.key) {
                Some(id) => *id,
                None => {
                    let free = (0..)
                        .find(|n| !facts.ids.values().any(|v| v == n))
                        .unwrap_or(0);
                    facts.ids.insert(encode.key.clone(), free);
                    free
                }
            };
            wanted.push(EncodeSpec {
                id,
                codec: encode.codec.clone(),
                width: encode.width,
                height: encode.height,
                fps: encode.fps,
                bitrate: encode.bitrate,
                quantizer: None,
            });
        }
        if changed(&facts.wanted, &wanted) {
            facts.wanted = wanted.clone();
            normal(
                out,
                FromMedia::SourceWant {
                    source: id(source),
                    encodes: wanted,
                },
            );
        }
        let assigned: HashMap<&str, u32> = plan
            .viewers
            .iter()
            .filter_map(|(viewer, key)| Some((viewer.as_str(), *facts.ids.get(key)?)))
            .collect();
        let keys: Vec<String> = self
            .views
            .iter()
            .filter(|(_, v)| v.source == source)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            let Some(view) = self.views.get_mut(&key) else {
                continue;
            };
            let next = if view.paused || !self.sockets.contains_key(&view.connection) {
                None
            } else {
                assigned.get(view.id.get()).copied()
            };
            if view.encode == next {
                continue;
            }
            view.encode = next;
            let produced = next.filter(|id| {
                self.sources
                    .get(source)
                    .and_then(|f| f.seen.get(id))
                    .is_some_and(|seen| now_ms.saturating_sub(seen.at_ms) < SEEN_MS)
            });
            // Its new encode is taken at once when the producer sends it; otherwise the next
            // unit picks what it can take.
            if next.is_none() || produced.is_some() {
                view.taking = produced;
                view.held.clear();
                let mut events = Vec::new();
                view.fanout
                    .assign(produced.map(u64::from), |e| events.push(e));
                self.events(&key, events, now_ms, out);
            } else {
                let source = source.to_owned();
                self.request_keyframe(&source, next.unwrap_or(0), KeyReason::Viewer, now_ms, out);
            }
        }
    }

    /// Every 100 ms: `viewer.stats` once a second, and plans that follow the links' rates.
    pub fn tick(&mut self, now_ms: u64, out: &mut Vec<Effect>) {
        if now_ms.saturating_sub(self.last_stats) < STATS_MS {
            return;
        }
        let elapsed = now_ms.saturating_sub(self.last_stats).max(1) as f64 / 1000.0;
        self.last_stats = now_ms;
        let mut sources: Vec<String> = Vec::new();
        for view in self.views.values_mut() {
            let stats = FromMedia::ViewerStats {
                viewer: view.id.clone(),
                rate: view.rate.rate().clamp(0.0, f64::from(u32::MAX)) as u32,
                fps: Nonnegative::new(f64::from(view.frames) / elapsed)
                    .unwrap_or_else(|_| unreachable!()),
                dropped: Sequence::new(view.dropped.min(9_007_199_254_740_991))
                    .unwrap_or_else(|_| unreachable!()),
                rtt_ms: Nonnegative::new(view.rate.rtt().unwrap_or(0.0).max(0.0))
                    .unwrap_or_else(|_| unreachable!()),
            };
            view.frames = 0;
            normal(out, stats);
            sources.push(view.source.clone());
        }
        sources.sort();
        sources.dedup();
        for source in sources {
            self.replan(&source, now_ms, out);
        }
    }
}

/// Sends one unit's held pieces when the fanout lets it go. `None` when its bytes aren't held:
/// the fanout is told the piece wasn't accepted, never that it was.
fn send(
    out: &mut Vec<Effect>,
    connection: &str,
    held: &mut VecDeque<(u64, Vec<Vec<u8>>)>,
    piece: Piece,
) -> Option<u64> {
    let at = held
        .iter()
        .position(|(sequence, _)| *sequence == piece.sequence)?;
    let (_, pieces) = held.remove(at)?;
    let mut bytes = 0;
    for piece in pieces {
        bytes += piece.len() as u64;
        media(out, connection, MediaOut::Binary(piece));
    }
    Some(bytes)
}

/// Whether a new plan differs enough to tell the producer: other encodes, sizes or codecs, or a
/// bit rate more than 20 % away.
fn changed(old: &[EncodeSpec], new: &[EncodeSpec]) -> bool {
    old.len() != new.len()
        || old.iter().zip(new).any(|(a, b)| {
            a.id != b.id
                || a.codec != b.codec
                || a.width != b.width
                || a.height != b.height
                || a.fps != b.fps
                || (f64::from(a.bitrate) - f64::from(b.bitrate)).abs() > 0.2 * f64::from(a.bitrate)
        })
}

/// The encode a view takes: its planned one while the producer sends it, else the produced encode
/// in a codec it decodes whose size is nearest its plan's.
fn taking(
    facts: &SourceFacts,
    planned: Option<u32>,
    codecs: &[String],
    now_ms: u64,
) -> Option<u32> {
    let planned_id = planned?;
    let live = |seen: &Seen| now_ms.saturating_sub(seen.at_ms) < SEEN_MS;
    if facts.seen.get(&planned_id).is_some_and(live) {
        return Some(planned_id);
    }
    let spec = facts.wanted.iter().find(|w| w.id == planned_id);
    let area = |w: f64, h: f64| w * h;
    let target = spec.map_or(f64::MAX, |s| area(f64::from(s.width), f64::from(s.height)));
    facts
        .seen
        .iter()
        .filter(|(_, seen)| live(seen))
        .filter(|(_, seen)| codecs.is_empty() || codecs.iter().any(|c| same_family(c, &seen.codec)))
        .min_by(|(a_id, a), (b_id, b)| {
            let da = (area(f64::from(a.width), f64::from(a.height)) - target).abs();
            let db = (area(f64::from(b.width), f64::from(b.height)) - target).abs();
            da.total_cmp(&db).then(a_id.cmp(b_id))
        })
        .map(|(id, _)| *id)
}

/// Two WebCodecs strings of one codec family (`avc1`, `hvc1`/`hev1`, `vp09`, `vp8`, `av01`): a
/// decoder for one profile of H.264 takes the others a producer sends.
fn same_family(a: &str, b: &str) -> bool {
    let family = |c: &str| match c.get(..4) {
        Some("hev1") => "hvc1".to_owned(),
        Some(f) => f.to_owned(),
        None => c.to_owned(),
    };
    family(a) == family(b)
}
