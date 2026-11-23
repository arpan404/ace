// SPDX-License-Identifier: Apache-2.0
//! The supervisor binding: values in, events out, never logic. Spawning,
//! inventory, journals, identity and stops cross here as JSON; behaviour
//! lives in `ace-supervisor`.

// napi-derive registers exports only outside test builds, so in the lib
// test target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

mod child;
mod inventory;
mod journal;
mod system;
mod tree;

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::OnceLock;

/// The addon's tokio runtime (two workers): pumps, waiters and stop tasks.
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn runtime() -> napi::Result<&'static tokio::runtime::Runtime> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let built = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ace-supervisor")
        .enable_all()
        .build()
        .map_err(|error| {
            napi::Error::from_reason(format!("supervisor runtime failed to start: {error}"))
        })?;
    let _ = RUNTIME.set(built);
    RUNTIME
        .get()
        .ok_or_else(|| napi::Error::from_reason("supervisor runtime failed to start"))
}

fn bind_error(error: ace_supervisor::errors::SupervisorError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

fn input_error(error: serde_json::Error) -> napi::Error {
    bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(
        error.to_string(),
    ))
}

/// Runs one export with panics turned into JS errors.
fn guarded<T>(context: &str, run: impl FnOnce() -> napi::Result<T>) -> napi::Result<T> {
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(outcome) => outcome,
        Err(_) => Err(napi::Error::from_reason(format!("{context} panicked"))),
    }
}

/// A JSON string literal, as `JSON.stringify` writes one.
fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for char in text.chars() {
        match char {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            char if (char as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", char as u32)),
            char => out.push(char),
        }
    }
    out.push('"');
    out
}

/// A tree member as the shell sends it: pid, start, and on Windows the
/// owner SID that proves the tree.
#[derive(Debug, serde::Deserialize)]
struct MemberJson {
    pid: u32,
    start: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    #[serde(default)]
    uid: String,
}

fn parse_members(members_json: &str) -> napi::Result<Vec<MemberJson>> {
    serde_json::from_str(members_json).map_err(input_error)
}

/// `[{pid, start}]`, in order.
fn members_json<'a>(members: impl IntoIterator<Item = (u32, &'a str)>) -> String {
    let mut out = String::from("[");
    for (index, (pid, start)) in members.into_iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&format!("{{\"pid\":{pid},\"start\":{}}}", quote(start)));
    }
    out.push(']');
    out
}
