// SPDX-License-Identifier: Apache-2.0
//! The wire fixtures' Rust side (ADR 0226 §3): reads one request per line from stdin and writes
//! one answer per line to stdout, so `scripts/check-wire-fixtures.ts` can compare Zod's answers
//! with the generated types and `ace-json`'s bytes without starting a socket.
//!
//!   {"op":"decode","kind":"client","text":"{\"type\":\"ping\"}"}
//!   {"op":"encode","kind":"server","text":"{\"type\":\"pong\"}"}
//!
//! A decoded message answers `{"ok":true,"canonical":"<Zod's output>"}`; an encoded one
//! `{"ok":true,"bytes":"<JSON.stringify's bytes>"}`; a refused one `{"ok":false,"error":"..."}`.

use std::io::{self, BufRead, Write};

use ace_json::{Map, Value};
use ace_wire::{WireError, decode_client, decode_server, encode_client, encode_server};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    let mut args = std::env::args().skip(1);
    let kind = args.next().unwrap_or_else(|| "client".to_string());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match request(&kind, &line) {
            Ok(answer) => answer,
            Err(error) => failure(&error),
        };
        let _ = writeln!(stdout, "{answer}");
    }
}

fn request(kind: &str, line: &str) -> Result<String, WireError> {
    let request = ace_json::parse(line).map_err(|error| WireError::Json(error.to_string()))?;
    let map = match &request {
        Value::Object(map) => map,
        _ => return Err(WireError::NotAnObject),
    };
    let op = field(map, "op").unwrap_or("decode");
    let kind = field(map, "kind").unwrap_or(kind);
    let text = field(map, "text").ok_or(WireError::MissingType)?;
    let answer = match (op, kind) {
        ("decode", "client") => {
            let decoded = decode_client(text)?;
            let shaped = ace_wire::canonical_client(&decoded.envelope.type_, &decoded.value)
                .ok_or_else(|| WireError::UnknownType {
                    type_: decoded.envelope.type_.clone(),
                })?;
            Ok(ace_json::to_string(&shaped))
        }
        ("decode", "server") => {
            let decoded = decode_server(text)?;
            let type_ = decoded.envelope.type_.clone();
            canonical(
                &ace_protocol::shapes::SERVER_MESSAGE,
                &type_,
                &decoded.value,
            )
        }
        ("encode", "client") => {
            let decoded = decode_client(text)?;
            Ok(encode_client(&decoded.value)?)
        }
        ("encode", "server") => {
            let decoded = decode_server(text)?;
            Ok(encode_server(&decoded.value)?)
        }
        ("encode-body", "client") => {
            let decoded = decode_client(text)?;
            Ok(ace_wire::encode_client_body(&decoded.message)?)
        }
        ("encode-body", "server") => {
            let decoded = decode_server(text)?;
            Ok(ace_wire::encode_server_body(&decoded.message)?)
        }
        (op, kind) => {
            return Err(WireError::Body(format!("unknown op {op} for {kind}")));
        }
    }?;
    let mut out = Map::new();
    out.insert("ok", Value::Bool(true));
    out.insert("canonical", Value::String(ace_json::JsString::from(answer)));
    Ok(ace_json::to_string(&Value::Object(out)))
}

fn canonical(
    root: &'static ace_protocol::shape::Shape,
    type_: &str,
    value: &Value,
) -> Result<String, WireError> {
    let shaped = ace_wire::canonical(root, type_, value).ok_or_else(|| WireError::UnknownType {
        type_: type_.to_string(),
    })?;
    Ok(ace_json::to_string(&shaped))
}

fn failure(error: &WireError) -> String {
    let mut out = Map::new();
    out.insert("ok", Value::Bool(false));
    out.insert(
        "error",
        Value::String(ace_json::JsString::from(error.to_string())),
    );
    ace_json::to_string(&Value::Object(out))
}

fn field<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    match map.get(key) {
        Some(Value::String(text)) => Some(text.as_str()),
        _ => None,
    }
}
