// SPDX-License-Identifier: Apache-2.0
//! `historyNotes`: a thread's turns split into notes that each fit the frame
//! bound, in order (`history.ts:153`-`:212`).

use ace_json::{Map, Value};

use super::{NOTE_BUDGET, bytes_of};

/// `historyNotes`: the turns split into notes that each fit the frame bound, in
/// order. A turn too large for one note is split by items, and its parts share
/// the turn's id. An item larger than a whole note is left out with a note
/// saying so, the same outcome a live frame of that size would have.
pub fn history_notes(thread: &str, read: u64, turns: &[Value]) -> Vec<Value> {
    history_notes_with(thread, read, turns, NOTE_BUDGET)
}

/// `historyNotes(threadId, read, turns, budget)`.
pub fn history_notes_with(thread: &str, read: u64, turns: &[Value], budget: usize) -> Vec<Value> {
    let mut builder = NoteBuilder {
        thread,
        read,
        budget,
        notes: Vec::new(),
        batch: Vec::new(),
        batch_bytes: 0,
    };
    for turn in turns {
        let bytes = bytes_of(turn);
        if bytes <= budget {
            builder.add(turn.clone(), bytes);
            continue;
        }
        let mut shell = turn.as_object().cloned().unwrap_or_default();
        shell.remove("items");
        let mut empty = shell.clone();
        empty.insert("items", Value::Array(Vec::new().into()));
        let shell_bytes = bytes_of(&Value::Object(empty));
        let mut part: Vec<Value> = Vec::new();
        let mut part_bytes = shell_bytes;
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .map(|items| items.to_vec())
            .unwrap_or_default()
        {
            let size = bytes_of(&item) + 1;
            if shell_bytes + size > budget {
                builder.omitted(turn, &item, size - 1);
                continue;
            }
            if part_bytes + size > budget {
                builder.add_part(&shell, &mut part, &mut part_bytes, shell_bytes);
                builder.flush();
            }
            part.push(item);
            part_bytes += size;
        }
        builder.add_part(&shell, &mut part, &mut part_bytes, shell_bytes);
    }
    builder.flush();
    builder.notes
}

/// The notes under construction: one bounded batch at a time.
struct NoteBuilder<'a> {
    thread: &'a str,
    read: u64,
    budget: usize,
    notes: Vec<Value>,
    batch: Vec<Value>,
    batch_bytes: usize,
}

impl NoteBuilder<'_> {
    /// One turn's note is full: record it and start the next.
    fn flush(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        self.notes.push(history_note(
            self.thread,
            self.read,
            std::mem::take(&mut self.batch),
        ));
        self.batch_bytes = 0;
    }

    fn add(&mut self, turn: Value, bytes: usize) {
        if self.batch_bytes + bytes > self.budget {
            self.flush();
        }
        self.batch.push(turn);
        self.batch_bytes += bytes;
    }

    /// One split turn's part: its shell, then the items gathered so far.
    fn add_part(
        &mut self,
        shell: &Map,
        part: &mut Vec<Value>,
        part_bytes: &mut usize,
        shell_bytes: usize,
    ) {
        let mut whole = shell.clone();
        whole.insert("items", Value::Array(std::mem::take(part).into()));
        let size = *part_bytes;
        self.add(Value::Object(whole), size);
        *part_bytes = shell_bytes;
    }

    /// An item larger than a whole note is left out with a note saying so.
    fn omitted(&mut self, turn: &Value, item: &Value, bytes: usize) {
        let mut note = Map::new();
        note.insert("event", Value::from("thread-history-omitted"));
        note.insert("threadId", Value::from(self.thread.to_owned()));
        note.insert("read", Value::from(self.read as f64));
        note.insert(
            "turnId",
            Value::from(
                turn.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
        );
        note.insert(
            "item",
            Value::from(
                item.get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            ),
        );
        note.insert("bytes", Value::from(bytes as f64));
        self.notes.push(Value::Object(note));
    }
}

/// One `thread-history` note.
fn history_note(thread: &str, read: u64, turns: Vec<Value>) -> Value {
    let mut note = Map::new();
    note.insert("event", Value::from("thread-history"));
    note.insert("threadId", Value::from(thread.to_owned()));
    note.insert("read", Value::from(read as f64));
    note.insert("turns", Value::Array(turns.into()));
    Value::Object(note)
}
