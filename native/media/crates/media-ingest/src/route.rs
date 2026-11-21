// SPDX-License-Identifier: Apache-2.0
//! Where a producer's video goes: ace-media's ingest, the only place it goes. With no connection
//! a unit is dropped (stills take the daemon's path, outside the route). A unit is routed and
//! written in one call, so a switch has an exact boundary: the sequence of the last video unit
//! the previous connection took.
//!
//! Every connection has a generation of its own, carried by every event and action about it,
//! so a report about a replaced connection never touches its successor (an address or a
//! descriptor can be reused; a generation never is). A replaced writer is retired: it finishes,
//! writing what it had queued and then its end frame, so ace-media ends that path cleanly. A
//! retirement is bounded by the writer's own finish deadline, and at most `max_retired` writers
//! or `max_retired_bytes` of backlog are kept; past either the oldest is closed and its path
//! cut. Retired writers' failures are their own: only the current writer's cut stops video,
//! reported once with its boundary.
use crate::VideoUnit;
use crate::frame::{TOKEN_LEN, video_frame};
use crate::writer::{Action, Bytes, Cut, DRAIN_LIMIT_MS, QUEUE_LIMIT, Writer, WriterState};
use std::collections::BTreeMap;
use zeroize::Zeroizing;

/// ace-media's ingest socket (or named pipe) and a source's single-use token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Address {
    pub socket: String,
    pub token: Zeroizing<[u8; TOKEN_LEN]>,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub limit: usize,
    pub drain_limit_ms: u64,
    pub max_retired: usize,
    pub max_retired_bytes: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            limit: QUEUE_LIMIT,
            drain_limit_ms: DRAIN_LIMIT_MS,
            max_retired: 4,
            max_retired_bytes: 16 * 1024 * 1024,
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum RouteAction {
    /// Hand these bytes to connection `generation`'s socket, in order; report it with `id`.
    Write {
        generation: u64,
        id: u64,
        bytes: Bytes,
    },
    /// Close connection `generation` gracefully: its end frame is written.
    Shutdown { generation: u64 },
    /// Close connection `generation` at once.
    Destroy { generation: u64 },
    /// The current connection was cut: video goes nowhere until a new address. `boundary` is
    /// the last sequence that connection took.
    IngestClosed { boundary: Option<u64>, cut: Cut },
    /// The producer should send a keyframe next.
    Keyframe,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Switch {
    /// Already there: nothing changes.
    Same,
    /// Open a connection to `socket`, then report `connected` or `connect_failed` with
    /// `generation`. Video stays where it is until then.
    Connect { generation: u64, socket: String },
    /// Video moved. `boundary` is the last sequence the previous connection took, if any.
    Switched { boundary: Option<u64> },
    /// A connection superseded before it was reported open: destroy it.
    Stale,
}

pub struct Route {
    config: Config,
    current: Option<(u64, Writer)>,
    address: Option<Address>,
    pending: Option<(u64, Address)>,
    retired: BTreeMap<u64, Writer>,
    next_generation: u64,
    last_ingest: Option<u64>,
}

impl Route {
    pub fn new(config: Config) -> Self {
        Self {
            config,
            current: None,
            address: None,
            pending: None,
            retired: BTreeMap::new(),
            next_generation: 1,
            last_ingest: None,
        }
    }

    /// Whether video goes to ace-media now.
    pub fn ingesting(&self) -> bool {
        self.current.is_some()
    }

    /// Retired writers still finishing.
    pub fn retiring(&self) -> usize {
        self.retired.len()
    }

    /// Sends to `target` from now on (nowhere for `None`, at once); an address needs its
    /// connection opened first.
    pub fn begin(
        &mut self,
        target: Option<Address>,
        now: u64,
        out: &mut Vec<RouteAction>,
    ) -> Switch {
        if self.pending.is_none() && target == self.address {
            return Switch::Same;
        }
        self.pending = None;
        let Some(target) = target else {
            let boundary = self.last_ingest;
            if let Some((generation, previous)) = self.current.take() {
                self.address = None;
                self.retire(generation, previous, now, out);
            }
            return Switch::Switched { boundary };
        };
        let generation = self.next_generation;
        self.next_generation += 1;
        let socket = target.socket.clone();
        self.pending = Some((generation, target));
        Switch::Connect { generation, socket }
    }

    /// The connection for `generation` is open: its hello goes first, and video moves to it.
    pub fn connected(&mut self, generation: u64, now: u64, out: &mut Vec<RouteAction>) -> Switch {
        let Some((_, address)) = self.pending.take_if(|(g, _)| *g == generation) else {
            return Switch::Stale;
        };
        let (writer, actions) = Writer::new(
            &address.token,
            self.config.limit,
            self.config.drain_limit_ms,
        );
        let previous = self.current.replace((generation, writer));
        let boundary = previous.as_ref().and(self.last_ingest);
        self.address = Some(address);
        self.last_ingest = None;
        self.apply(generation, actions, out);
        if let Some((old, previous)) = previous {
            self.retire(old, previous, now, out);
        }
        Switch::Switched { boundary }
    }

    /// The connection for `generation` could not be opened: video stays where it is.
    pub fn connect_failed(&mut self, generation: u64) {
        self.pending.take_if(|(g, _)| *g == generation);
    }

    /// Writes one unit to the current connection; with none it is dropped.
    pub fn publish(
        &mut self,
        unit: &VideoUnit,
        now_ms: u64,
        now_us: u64,
        out: &mut Vec<RouteAction>,
    ) {
        let Some((generation, writer)) = &mut self.current else {
            return;
        };
        let generation = *generation;
        let Some(bytes) = video_frame(unit, now_us) else {
            return;
        };
        let mut actions = Vec::new();
        if writer.unit(now_ms, bytes, unit.key, &mut actions) {
            self.last_ingest = Some(unit.sequence);
        }
        self.apply(generation, actions, out);
    }

    pub fn written(&mut self, generation: u64, id: u64, out: &mut Vec<RouteAction>) {
        self.event(generation, out, |w, a| w.written(id, a));
    }

    pub fn write_failed(&mut self, generation: u64, out: &mut Vec<RouteAction>) {
        self.event(generation, out, Writer::write_failed);
    }

    pub fn socket_closed(&mut self, generation: u64, out: &mut Vec<RouteAction>) {
        self.event(generation, out, Writer::socket_closed);
    }

    /// The clock moved on: finish deadlines and backlogs are judged.
    pub fn tick(&mut self, now: u64, out: &mut Vec<RouteAction>) {
        let generations: Vec<u64> = self
            .current
            .iter()
            .map(|(g, _)| *g)
            .chain(self.retired.keys().copied())
            .collect();
        for generation in generations {
            self.event(generation, out, |w, a| w.tick(now, a));
        }
    }

    /// Closes every connection at once, dropping what is queued.
    pub fn close(&mut self, out: &mut Vec<RouteAction>) {
        self.pending = None;
        self.address = None;
        let mut actions = Vec::new();
        if let Some((generation, mut writer)) = self.current.take() {
            writer.close(&mut actions);
            Self::map(generation, actions.drain(..), out);
        }
        for (generation, mut writer) in std::mem::take(&mut self.retired) {
            writer.close(&mut actions);
            Self::map(generation, actions.drain(..), out);
        }
    }

    fn event(
        &mut self,
        generation: u64,
        out: &mut Vec<RouteAction>,
        event: impl FnOnce(&mut Writer, &mut Vec<Action>),
    ) {
        let mut actions = Vec::new();
        if let Some((g, writer)) = &mut self.current
            && *g == generation
        {
            event(writer, &mut actions);
        } else if let Some(writer) = self.retired.get_mut(&generation) {
            event(writer, &mut actions);
        } else {
            return;
        }
        self.apply(generation, actions, out);
    }

    /// One writer's actions, as the route's; a current writer's cut stops video.
    fn apply(&mut self, generation: u64, actions: Vec<Action>, out: &mut Vec<RouteAction>) {
        let current = self.current.as_ref().is_some_and(|(g, _)| *g == generation);
        for action in actions {
            match action {
                Action::Cut(cut) if current => {
                    self.current = None;
                    self.address = None;
                    out.push(RouteAction::IngestClosed {
                        boundary: self.last_ingest,
                        cut,
                    });
                }
                Action::Keyframe if !current => {}
                other => Self::map(generation, std::iter::once(other), out),
            }
        }
        if self
            .retired
            .get(&generation)
            .is_some_and(|w| matches!(w.state(), WriterState::Ended | WriterState::Cut))
        {
            self.retired.remove(&generation);
        }
    }

    fn map(generation: u64, actions: impl Iterator<Item = Action>, out: &mut Vec<RouteAction>) {
        for action in actions {
            out.push(match action {
                Action::Write { id, bytes } => RouteAction::Write {
                    generation,
                    id,
                    bytes,
                },
                Action::Shutdown => RouteAction::Shutdown { generation },
                Action::Destroy => RouteAction::Destroy { generation },
                Action::Keyframe => RouteAction::Keyframe,
                Action::Ended | Action::Cut(_) => continue,
            });
        }
    }

    fn retire(
        &mut self,
        generation: u64,
        mut writer: Writer,
        now: u64,
        out: &mut Vec<RouteAction>,
    ) {
        let mut actions = Vec::new();
        writer.finish(now, &mut actions);
        self.retired.insert(generation, writer);
        self.apply(generation, actions, out);
        while self.retired.len() > self.config.max_retired
            || self.retired.values().map(Writer::backlog).sum::<usize>()
                > self.config.max_retired_bytes
        {
            let Some((oldest, mut writer)) = self.retired.pop_first() else {
                break;
            };
            let mut actions = Vec::new();
            writer.close(&mut actions);
            Self::map(oldest, actions.into_iter(), out);
        }
    }
}

#[cfg(test)]
#[path = "route_tests.rs"]
mod tests;
