// SPDX-License-Identifier: Apache-2.0

//! OpenCode's saved history: its legacy storage files (`storage/session`, `storage/message`,
//! `storage/part`) and its SQLite databases, schema v1 (`message` and `part`) and v2
//! (`session_message`).

pub mod database;
pub mod sessions;
pub mod storage;

use std::sync::mpsc;
use std::thread::JoinHandle;

use history_text::js;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value};

use crate::error::Result;
use crate::import::source::Native;

/// `String(value)` of a value node:sqlite returned: integers arrive as JavaScript numbers and
/// blobs as `Uint8Array`, whose string is its bytes joined by commas.
pub fn js_string(value: ValueRef<'_>) -> String {
    match value {
        ValueRef::Null => "null".to_owned(),
        ValueRef::Integer(n) => js::number(n as f64),
        ValueRef::Real(n) => js::number(n),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        ValueRef::Blob(bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
    }
}

/// The value as the JSON a lenient accessor reads (`timestamp`, `string`): a blob reads as absent.
pub fn json_of(value: ValueRef<'_>) -> Value {
    match value {
        ValueRef::Integer(n) => {
            serde_json::Number::from_f64(n as f64).map_or(Value::Null, Value::Number)
        }
        ValueRef::Real(n) => serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number),
        ValueRef::Text(bytes) => Value::String(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Null | ValueRef::Blob(_) => Value::Null,
    }
}

/// `Number(value)` of a count or size column; `null` is 0.
pub fn js_number(value: ValueRef<'_>) -> f64 {
    match value {
        ValueRef::Integer(n) => n as f64,
        ValueRef::Real(n) => n,
        ValueRef::Text(bytes) => js::trim(&String::from_utf8_lossy(bytes))
            .parse()
            .unwrap_or(f64::NAN),
        ValueRef::Null => 0.0,
        ValueRef::Blob(_) => f64::NAN,
    }
}

/// `{ ...map, [key]: value }`: an existing key keeps its place, a new one goes last, and an
/// `undefined` value leaves no key at all, as `JSON.stringify` writes it.
pub fn assign(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            map.insert(key.to_owned(), value);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

/// Records made on a thread of their own, which owns what they are read from (a database
/// connection and its statements), handed over one at a time. Dropping the iterator stops the
/// thread and waits for it, so whatever it held is closed when the drop returns.
pub struct Threaded {
    records: Option<mpsc::Receiver<Result<Native>>>,
    worker: Option<JoinHandle<()>>,
}

/// Run `produce` on its own thread. It hands each record to `emit`, which answers false once
/// nothing will take more.
pub fn threaded<F>(produce: F) -> Threaded
where
    F: FnOnce(&mut dyn FnMut(Result<Native>) -> bool) + Send + 'static,
{
    let (send, records) = mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        produce(&mut |record| send.send(record).is_ok());
    });
    Threaded {
        records: Some(records),
        worker: Some(worker),
    }
}

impl Iterator for Threaded {
    type Item = Result<Native>;

    fn next(&mut self) -> Option<Result<Native>> {
        self.records.as_ref()?.recv().ok()
    }
}

impl Drop for Threaded {
    fn drop(&mut self) {
        drop(self.records.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
