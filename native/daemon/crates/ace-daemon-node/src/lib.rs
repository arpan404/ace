// SPDX-License-Identifier: Apache-2.0
//! The daemon's Rust core as one N-API addon (ADR 0222). This crate only translates: values,
//! errors and handles. Behaviour lives in the crates it binds. The TypeScript side
//! (`@ace/provider-kit/native-sqlite`) shapes rows and errors the way node:sqlite does.

use ace_store::{Connection, Error, ErrorKind, OpenOptions, Statement, Value};
use napi::bindgen_prelude::{BigInt, Either4, Either5, Null, Uint8Array};
use napi_derive::napi;
use std::sync::Arc;

mod core;
mod engine;
mod items;
mod json_bind;
mod long_thread;
mod session_acp;
mod session_codex;
mod session_cursor;
mod session_opencode;
mod session_pi;
mod sidebar;
mod streams;
mod supervisor;
mod translate_acp;
mod translate_claude;
mod translate_codex;
mod translate_cursor;
mod translate_opencode;
mod translate_pi;

/// Largest integer a JavaScript number holds exactly.
const SAFE: i64 = (1 << 53) - 1;

type Param = Either5<Null, f64, String, BigInt, Uint8Array>;
type Cell = Either4<Null, f64, String, Uint8Array>;

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A failure the TypeScript side rethrows as node:sqlite would: `ace-store:` then JSON.
fn failure(kind: &str, code: i32, message: &str, errstr: &str) -> napi::Error {
    napi::Error::from_reason(format!(
        "ace-store:{{\"kind\":{},\"errcode\":{code},\"message\":{},\"errstr\":{}}}",
        quote(kind),
        quote(message),
        quote(errstr)
    ))
}

fn fail(error: Error) -> napi::Error {
    let kind = match error.kind {
        ErrorKind::Sqlite => "sqlite",
        ErrorKind::NoStatement => "no-statement",
        ErrorKind::Closed => "closed",
        ErrorKind::Finalized => "finalized",
    };
    failure(kind, error.code, &error.message, &error.errstr)
}

#[napi]
pub struct NativeDatabase {
    connection: Arc<Connection>,
}

impl NativeDatabase {
    /// The connection, for the read bindings (`items.rs`, `long_thread.rs`, `sidebar.rs`),
    /// which take `&NativeDatabase` from JavaScript and read on the same connection.
    #[allow(dead_code)]
    pub(crate) fn connection(&self) -> &Arc<Connection> {
        &self.connection
    }
}

#[napi]
impl NativeDatabase {
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String, read_only: bool, timeout_ms: i32) -> napi::Result<Self> {
        let connection = Connection::open(
            &path,
            OpenOptions {
                read_only,
                timeout_ms,
            },
        )
        .map_err(fail)?;
        Ok(NativeDatabase { connection })
    }

    #[napi(catch_unwind)]
    pub fn exec(&self, sql: String) -> napi::Result<()> {
        self.connection.exec(&sql).map_err(fail)
    }

    #[napi(catch_unwind)]
    pub fn prepare(&self, sql: String) -> napi::Result<NativeStatement> {
        let statement = self.connection.prepare(&sql).map_err(fail)?;
        Ok(NativeStatement { statement })
    }

    #[napi(catch_unwind)]
    pub fn is_transaction(&self) -> napi::Result<bool> {
        self.connection.is_transaction().map_err(fail)
    }

    #[napi(catch_unwind)]
    pub fn location(&self) -> napi::Result<Option<String>> {
        self.connection.location().map_err(fail)
    }

    #[napi(catch_unwind)]
    pub fn is_open(&self) -> bool {
        self.connection.is_open()
    }

    /// Copy the database to `path`; the pages copied.
    #[napi(catch_unwind)]
    pub fn backup(&self, path: String) -> napi::Result<f64> {
        self.connection
            .backup(&path)
            .map(|pages| pages as f64)
            .map_err(fail)
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        self.connection.close().map_err(fail)
    }
}

/// Up to `limit` rows' cells, flattened, and whether the statement finished.
#[napi(object)]
pub struct Rows {
    pub cells: Vec<Cell>,
    pub done: bool,
}

#[napi]
pub struct NativeStatement {
    statement: Statement,
}

fn param(index: usize, value: Param) -> napi::Result<Value> {
    Ok(match value {
        Either5::A(_) => Value::Null,
        Either5::B(number) => Value::Real(number),
        Either5::C(text) => Value::Text(text),
        Either5::D(big) => {
            let (value, lossless) = big.get_i64();
            if !lossless {
                return Err(failure(
                    "range",
                    0,
                    &format!(
                        "BigInt value is too large to bind to SQLite parameter {}.",
                        index + 1
                    ),
                    "",
                ));
            }
            Value::Integer(value)
        }
        Either5::E(bytes) => Value::Blob(bytes.to_vec()),
    })
}

fn cell(value: Value) -> napi::Result<Cell> {
    Ok(match value {
        Value::Null => Either4::A(Null),
        Value::Integer(n) if (-SAFE..=SAFE).contains(&n) => Either4::B(n as f64),
        Value::Integer(n) => {
            return Err(failure(
                "range",
                0,
                &format!("Value is too large to be represented as a JavaScript number: {n}"),
                "",
            ));
        }
        Value::Real(n) => Either4::B(n),
        Value::Text(text) => Either4::C(text),
        Value::Blob(bytes) => Either4::D(Uint8Array::new(bytes)),
    })
}

#[napi]
impl NativeStatement {
    /// Parameter names by index from 1; null for an anonymous `?`.
    #[napi(catch_unwind)]
    pub fn parameter_names(&self) -> napi::Result<Vec<Option<String>>> {
        self.statement.parameter_names().map_err(fail)
    }

    #[napi(catch_unwind)]
    pub fn columns(&self) -> napi::Result<Vec<String>> {
        self.statement.columns().map_err(fail)
    }

    /// Reset and bind `params[i]` to parameter `i + 1`.
    fn bind(&self, params: Vec<Param>) -> napi::Result<()> {
        let values = params
            .into_iter()
            .enumerate()
            .map(|(index, value)| param(index, value).map(Some))
            .collect::<napi::Result<Vec<_>>>()?;
        self.statement.bind(&values).map_err(fail)
    }

    /// Step up to `limit` rows; with `params`, reset and bind them first (one call, not two).
    #[napi(catch_unwind)]
    pub fn step_rows(&self, params: Option<Vec<Param>>, limit: u32) -> napi::Result<Rows> {
        if let Some(params) = params {
            self.bind(params)?;
        }
        let mut cells = Vec::new();
        for _ in 0..limit {
            // A failed step resets itself (`Statement::step`).
            match self.statement.step().map_err(fail)? {
                Some(row) => {
                    for value in row {
                        match cell(value) {
                            Ok(value) => cells.push(value),
                            Err(error) => {
                                // Leave no statement mid-result: it would hold a read snapshot.
                                let _ = self.statement.reset();
                                return Err(error);
                            }
                        }
                    }
                }
                None => return Ok(Rows { cells, done: true }),
            }
        }
        Ok(Rows { cells, done: false })
    }

    /// Step to the end, discarding rows; the rows changed and the last inserted rowid.
    #[napi(catch_unwind)]
    pub fn run(&self, params: Vec<Param>) -> napi::Result<Vec<f64>> {
        self.bind(params)?;
        while self.statement.step().map_err(fail)?.is_some() {}
        let (changes, rowid) = self.statement.changes().map_err(fail)?;
        Ok(vec![changes as f64, rowid as f64])
    }

    #[napi(catch_unwind)]
    pub fn reset(&self) -> napi::Result<()> {
        self.statement.reset().map_err(fail)
    }
}
