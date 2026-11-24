// SPDX-License-Identifier: Apache-2.0
//! The binding for phase 5 (docs/store/porting-guide.md). One method per task; 5.1 owns
//! `fold_thread`, 5.2b owns `sequences`, 5.3a owns `event_writer`, 5.3b-2 owns
//! `thread_column_writer`, 5.4a owns `compact_deltas` and `live_retry_delay`, and 5.4b owns
//! `live_buffer` (`writer/live.rs`). Only the sequences, event-writer and column-writer handles
//! touch the connection they hold; the fold, the compaction and the buffer never do.

use ace_projection::{Column, FoldEvent, update_thread};
use ace_store::Connection;
use ace_store::writer::events::{EventRow, EventWriter, NewThreadRow, WriteError};
use ace_store::writer::live::compact::compact_deltas;
use ace_store::writer::live::retry::retry_delay;
use ace_store::writer::sequences::{SequenceError, Sequences};
use ace_store::writer::thread_columns::{ThreadColumnWriter, Written, written_json};
use napi::{Env, Status};
use napi_derive::napi;
use std::sync::Arc;

use crate::json_bind;
use crate::{NativeDatabase, fail};

mod live;

#[napi]
impl NativeDatabase {
    /// The folded thread as JSON text. `payload` is the text the shell sent, or None.
    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn fold_thread(
        &self,
        env: Env,
        thread: String,
        kind: String,
        seq: f64,
        at: f64,
        payload: Option<String>,
    ) -> napi::Result<String> {
        let thread_value = json_bind::parse(&env, &thread)?;
        let mut thread_map = match thread_value {
            ace_json::Value::Object(map) => map,
            _ => {
                return Err(napi::Error::from_reason("fold: thread is not an object"));
            }
        };
        let payload_value = match payload {
            Some(text) => Some(json_bind::parse(&env, &text)?),
            None => None,
        };
        let event = FoldEvent::from_wire(&kind, payload_value.as_ref(), seq)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        update_thread(&mut thread_map, event, at)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        Ok(ace_json::to_string(&ace_json::Value::Object(thread_map)))
    }

    /// The sequence allocator for this connection, initialised from `host_sequence`.
    #[napi(catch_unwind)]
    pub fn sequences(&self) -> napi::Result<NativeSequences> {
        let sequences = Sequences::initialize(self.connection()).map_err(fail)?;
        Ok(NativeSequences {
            connection: Arc::clone(self.connection()),
            sequences,
        })
    }

    /// The event writer's own rows, with its statements prepared on this connection.
    #[napi(catch_unwind)]
    pub fn event_writer(&self) -> napi::Result<NativeEventWriter> {
        let writer = EventWriter::new(self.connection()).map_err(fail)?;
        Ok(NativeEventWriter {
            connection: Arc::clone(self.connection()),
            writer,
        })
    }

    /// The thread column writer, with its fixed reads prepared on this connection.
    #[napi(catch_unwind)]
    pub fn thread_column_writer(&self) -> napi::Result<NativeThreadColumnWriter> {
        let writer = ThreadColumnWriter::new(self.connection()).map_err(fail)?;
        Ok(NativeThreadColumnWriter {
            connection: Arc::clone(self.connection()),
            writer,
        })
    }

    /// Adjacent `item.delta` events into one row each: the events as JSON text in, the rows as
    /// JSON text out, in the later event's key order and with lone surrogates intact. The parsed
    /// events are moved into the compaction, never cloned.
    #[napi(catch_unwind)]
    pub fn compact_deltas(&self, env: Env, events: String) -> napi::Result<String> {
        let value = json_bind::parse(&env, &events)?;
        let items = match value {
            ace_json::Value::Array(items) => items,
            _ => {
                return Err(napi::Error::from_reason(
                    "compactDeltas: events is not an array",
                ));
            }
        };
        let mut maps = Vec::with_capacity(items.len());
        for item in items.into_iter() {
            match item {
                ace_json::Value::Object(map) => maps.push(map),
                _ => {
                    return Err(napi::Error::from_reason(
                        "compactDeltas: an event is not an object",
                    ));
                }
            }
        }
        let rows: Vec<ace_json::Value> = compact_deltas(maps)
            .into_iter()
            .map(ace_json::Value::Object)
            .collect();
        Ok(ace_json::to_string(&ace_json::Value::Array(rows.into())))
    }

    /// The delay before the attempt that follows the `failures`-th consecutive failure. A
    /// deadline for the caller's scheduler, never a timer in Rust.
    #[napi(catch_unwind)]
    pub fn live_retry_delay(&self, failures: u32) -> u32 {
        u32::try_from(retry_delay(failures)).unwrap_or(u32::MAX)
    }

    /// The live buffer's state, empty and unarmed. It owns no timer and touches no SQL, so the
    /// shell creates it before `migrate` runs.
    #[napi(catch_unwind)]
    pub fn live_buffer(&self) -> live::NativeLiveBuffer {
        live::NativeLiveBuffer::empty()
    }
}

/// A writer failure: SQLite's own error keeps `errcode`, the rest keeps the TS message.
fn write_error(error: WriteError) -> napi::Error {
    match error {
        WriteError::Sqlite(error) => fail(error),
        WriteError::WorkspaceUnregistered | WriteError::Column(_) => {
            napi::Error::from_reason(error.to_string())
        }
    }
}

/// Parse a JSON text that must be an object.
fn object(env: &Env, text: &str, name: &str) -> napi::Result<ace_json::Map> {
    match json_bind::parse(env, text)? {
        ace_json::Value::Object(map) => Ok(map),
        _ => Err(napi::Error::from_reason(format!(
            "writeThread: {name} is not an object"
        ))),
    }
}

/// A JavaScript number `sequences` accepts: finite and integral, as the SQL does.
fn integer(env: &Env, value: f64, name: &str) -> napi::Result<f64> {
    if value.is_finite() && value.fract() == 0.0 {
        return Ok(value);
    }
    let message = format!("Sequences {name} must be an integer");
    let _ = env.throw_range_error(&message, None);
    Err(napi::Error::new(Status::PendingException, message))
}

fn exhausted(error: SequenceError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

/// The allocator the TypeScript shell drives: one cursor and one confirmed reservation.
#[napi]
pub struct NativeSequences {
    connection: Arc<Connection>,
    sequences: Sequences,
}

#[napi]
impl NativeSequences {
    /// `reservedThrough()`: confirmed, or `NaN` while none has committed (the TS `NaN`).
    #[napi(catch_unwind)]
    pub fn reserved_through(&self) -> f64 {
        self.sequences.reserved_through()
    }

    #[napi(catch_unwind)]
    pub fn head(&self) -> napi::Result<f64> {
        self.sequences.head(&self.connection).map_err(fail)
    }

    #[napi(catch_unwind)]
    pub fn replay_safe(&self, env: Env, after: f64) -> napi::Result<bool> {
        let after = integer(&env, after, "after")?;
        self.sequences
            .replay_safe(&self.connection, after)
            .map_err(fail)
    }

    /// Allocates provisionally; the cursor has moved even when it throws.
    #[napi(catch_unwind)]
    pub fn next(&mut self, env: Env, after: f64) -> napi::Result<f64> {
        let after = integer(&env, after, "after")?;
        self.sequences.next(after).map_err(exhausted)
    }

    /// The range a refill would reserve, or `null` when the confirmed range already covers it.
    #[napi(catch_unwind)]
    pub fn reservation(&self, env: Env, events: f64, after: f64) -> napi::Result<Option<f64>> {
        let events = integer(&env, events, "events")?;
        let after = integer(&env, after, "after")?;
        self.sequences.reservation(events, after).map_err(exhausted)
    }

    /// Writes the reservation inside the caller's transaction.
    #[napi(catch_unwind)]
    pub fn reserve(&self, env: Env, through: f64) -> napi::Result<()> {
        let through = integer(&env, through, "through")?;
        self.sequences
            .reserve(&self.connection, through)
            .map_err(fail)
    }

    /// Confirms a reservation whose outermost transaction committed; says whether it rose.
    #[napi(catch_unwind)]
    pub fn confirm(&mut self, env: Env, through: f64) -> napi::Result<bool> {
        let through = integer(&env, through, "through")?;
        Ok(self.sequences.confirm(through))
    }

    #[napi(catch_unwind)]
    pub fn covers(&self, env: Env, seq: f64) -> napi::Result<bool> {
        let seq = integer(&env, seq, "seq")?;
        Ok(self.sequences.covers(seq))
    }
}

/// The event writer's own rows behind `ACE_STORE_WRITER=events` (task 5.3a).
#[napi]
pub struct NativeEventWriter {
    connection: Arc<Connection>,
    writer: EventWriter,
}

#[napi]
impl NativeEventWriter {
    /// `workspace_unregistered`, `INSERT INTO threads`, and `workspace_recent`.
    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn create_thread(
        &mut self,
        id: String,
        workspace_id: String,
        title: String,
        provider: String,
        status_json: String,
        created_at: f64,
        updated_at: f64,
        imported_json: Option<String>,
        imported: bool,
    ) -> napi::Result<()> {
        let row = NewThreadRow {
            id: &id,
            workspace_id: &workspace_id,
            title: &title,
            provider: &provider,
            status_json: &status_json,
            created_at,
            updated_at,
            imported_json: imported_json.as_deref(),
            imported,
        };
        self.writer
            .create_thread(self.connection.as_ref(), &row)
            .map_err(write_error)
    }

    /// `INSERT INTO events` then `UPDATE host_sequence`.
    #[napi(catch_unwind)]
    pub fn store_event(
        &mut self,
        seq: f64,
        id: String,
        thread_id: String,
        at: f64,
        kind: String,
        payload_json: String,
    ) -> napi::Result<()> {
        let row = EventRow {
            seq,
            id: &id,
            thread_id: &thread_id,
            at,
            kind: &kind,
            payload_json: &payload_json,
        };
        self.writer
            .store_event(self.connection.as_ref(), &row)
            .map_err(write_error)
    }
}

/// The thread column writes behind `ACE_STORE_WRITER=columns` (task 5.3b-2).
#[napi]
pub struct NativeThreadColumnWriter {
    connection: Arc<Connection>,
    writer: ThreadColumnWriter,
}

#[napi]
impl NativeThreadColumnWriter {
    /// `writeThread` through the revision read: null when no column changed, else the written
    /// row, its parts, the pre-write confirmation and the revision.
    #[napi(catch_unwind)]
    pub fn write(
        &mut self,
        env: Env,
        previous: Option<String>,
        next: String,
        wanted: Vec<String>,
    ) -> napi::Result<Option<String>> {
        let previous = match previous {
            Some(text) => Some(object(&env, &text, "previous")?),
            None => None,
        };
        let next = object(&env, &next, "next")?;
        let mut columns = Vec::with_capacity(wanted.len());
        for name in &wanted {
            match Column::from_name(name) {
                Some(column) => columns.push(column),
                None => {
                    return Err(napi::Error::from_reason(format!(
                        "writeThread: unknown column {name}"
                    )));
                }
            }
        }
        let written: Option<Written> = self
            .writer
            .write(self.connection.as_ref(), previous.as_ref(), &next, &columns)
            .map_err(write_error)?;
        Ok(written.map(|written| written_json(&written)))
    }
}
