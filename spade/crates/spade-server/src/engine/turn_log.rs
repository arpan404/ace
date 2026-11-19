//! A running turn's events, kept in memory so each step reads only what was stored since
//! (ADR 0158), up to a size: a turn of any length keeps at most `Limits::turn_log_bytes` of them.
//! Past it the kept events are let go and every read for the rest of the turn goes to SQLite,
//! so memory stays bounded however long the turn runs, and readers always see every event.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use spade_core::Event;
use spade_store::StoreError;

use super::{Engine, Events};

/// An event's `(seq, at_ms)`.
pub(super) type Stamp = (i64, i64);

/// Each event's stamp, beside [`Events`].
pub(super) type Stamps = Arc<Vec<Stamp>>;

/// What a running turn keeps of its conversation's events.
#[derive(Default)]
pub(super) enum Log {
    /// Nothing read yet in this turn (and between turns).
    #[default]
    Empty,
    Kept(Kept),
    /// Grew past the limit: nothing is kept, and reads go to SQLite until the turn ends.
    Spilled,
}

/// The conversation's events as read so far, with each one's stamp and their stored size.
pub(super) struct Kept {
    events: Events,
    stamps: Stamps,
    bytes: usize,
}

/// A read of a conversation's events in two parts, `base` then `tail` (see `read_split`).
pub(super) struct Split {
    pub(super) base: Events,
    pub(super) stamps: Stamps,
    tail: Vec<Event>,
    tail_stamps: Vec<Stamp>,
}

impl Split {
    fn whole(base: Events, stamps: Stamps) -> Self {
        Self {
            base,
            stamps,
            tail: Vec::new(),
            tail_stamps: Vec::new(),
        }
    }

    pub(super) fn len(&self) -> usize {
        self.base.len() + self.tail.len()
    }

    pub(super) fn iter(&self) -> impl DoubleEndedIterator<Item = &Event> + Clone {
        self.base.iter().chain(self.tail.iter())
    }

    /// The event at `at`, with its seq and time.
    pub(super) fn at(&self, at: usize) -> (&Event, i64, i64) {
        let (event, (seq, at_ms)) = match at.checked_sub(self.base.len()) {
            None => (
                &self.base[at],
                self.stamps.get(at).copied().unwrap_or_default(),
            ),
            Some(i) => (
                &self.tail[i],
                self.tail_stamps.get(i).copied().unwrap_or_default(),
            ),
        };
        (event, seq, at_ms)
    }
}

/// A read from SQLite: the events, their stamps and their stored size in bytes.
struct Read {
    events: Vec<Event>,
    stamps: Vec<Stamp>,
    bytes: usize,
}

impl Read {
    fn whole(self) -> Split {
        Split::whole(Arc::new(self.events), Arc::new(self.stamps))
    }
}

impl Engine {
    /// The conversation's events while a turn runs: what is kept in memory, and what was stored
    /// since. With `join`, the new events are added to the kept ones (copying them only if a
    /// reader still holds an earlier read) and `tail` is empty; without, a held read is never
    /// copied and the new events come apart in `tail`, so a frequent reader like the roster
    /// costs what was added, not the whole history. A turn whose events outgrow the limit keeps
    /// none of them from then on and reads them whole each time.
    pub(super) fn read_split(&self, id: &str, join: bool) -> Result<Split, StoreError> {
        let live = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned();
        let Some(live) = live.filter(|l| l.turn_running.load(Ordering::SeqCst)) else {
            return Ok(self.read_weighed(id, 0)?.whole());
        };
        let limit = self.limits.turn_log_bytes;
        let mut log = live.log.lock().unwrap_or_else(|p| p.into_inner());
        let kept = match std::mem::take(&mut *log) {
            Log::Spilled => {
                *log = Log::Spilled;
                return Ok(self.read_weighed(id, 0)?.whole());
            }
            Log::Empty => {
                let read = self.read_weighed(id, 0)?;
                if read.bytes > limit {
                    *log = Log::Spilled;
                    return Ok(read.whole());
                }
                let split = Split::whole(Arc::new(read.events), Arc::new(read.stamps));
                *log = Log::Kept(Kept {
                    events: split.base.clone(),
                    stamps: split.stamps.clone(),
                    bytes: read.bytes,
                });
                return Ok(split);
            }
            Log::Kept(kept) => kept,
        };
        let last = kept.stamps.last().map_or(0, |(seq, _)| *seq);
        let read = match self.read_weighed(id, last) {
            Ok(read) => read,
            Err(error) => {
                *log = Log::Kept(kept);
                return Err(error);
            }
        };
        if read.events.is_empty() {
            let split = Split::whole(kept.events.clone(), kept.stamps.clone());
            *log = Log::Kept(kept);
            return Ok(split);
        }
        let before = kept.bytes;
        let bytes = before.saturating_add(read.bytes);
        if bytes > limit {
            // `log` is already empty of them: the kept events go once this read is dropped.
            *log = Log::Spilled;
            if !join {
                return Ok(Split {
                    base: kept.events,
                    stamps: kept.stamps,
                    tail: read.events,
                    tail_stamps: read.stamps,
                });
            }
            let mut events = Arc::unwrap_or_clone(kept.events);
            let mut stamps = Arc::unwrap_or_clone(kept.stamps);
            events.extend(read.events);
            stamps.extend(read.stamps);
            return Ok(Split::whole(Arc::new(events), Arc::new(stamps)));
        }
        let Kept {
            mut events,
            mut stamps,
            ..
        } = kept;
        let held = Arc::strong_count(&events) > 1 || Arc::strong_count(&stamps) > 1;
        if join || !held {
            Arc::make_mut(&mut events).extend(read.events);
            Arc::make_mut(&mut stamps).extend(read.stamps);
            let split = Split::whole(events.clone(), stamps.clone());
            *log = Log::Kept(Kept {
                events,
                stamps,
                bytes,
            });
            return Ok(split);
        }
        // The new events are not kept apart from the held ones; the next read adds them.
        let split = Split {
            base: events.clone(),
            stamps: stamps.clone(),
            tail: read.events,
            tail_stamps: read.stamps,
        };
        *log = Log::Kept(Kept {
            events,
            stamps,
            bytes: before,
        });
        Ok(split)
    }

    /// The conversation's events after seq `after`, with their stamps and stored size.
    fn read_weighed(&self, id: &str, after: i64) -> Result<Read, StoreError> {
        let (stored, bytes) = self.store.events_weighed(id, after)?;
        let stamps = stored.iter().map(|e| (e.seq, e.at_ms)).collect();
        Ok(Read {
            events: stored.into_iter().map(|e| e.event).collect(),
            stamps,
            bytes,
        })
    }

    /// The stored size of the events running turns keep in memory, across conversations.
    /// For tests: a turn of any length keeps this bounded.
    #[doc(hidden)]
    pub fn kept_turn_bytes(&self) -> usize {
        let live: Vec<_> = self
            .live
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .values()
            .cloned()
            .collect();
        live.iter()
            .map(
                |l| match &*l.log.lock().unwrap_or_else(|p| p.into_inner()) {
                    Log::Kept(kept) => kept.bytes,
                    Log::Empty | Log::Spilled => 0,
                },
            )
            .sum()
    }
}
