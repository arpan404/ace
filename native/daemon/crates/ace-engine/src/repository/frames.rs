// SPDX-License-Identifier: Apache-2.0
//! `captureFrame` (E5.3, `repository.ts:725`-`:756`): the Cursor checkpoint journal. Only the
//! `sdk` channel of a Cursor thread on the Cursor SDK backend is stored; a repeated frame is
//! stored once; the frame's JSON is bounded by E5.2's `boundedJson`.

use ace_json::Value;
use ace_store::{Value as SqlValue, stmt_cache};

use crate::repository::collaborators::{FrameFacts, SessionFacts};
use crate::repository::residency::text;
use crate::{EngineError, EngineStore, State};

pub const CAPTURE: &str = "INSERT OR IGNORE INTO engine_provider_frames VALUES (?,?,?,?)";

impl State {
    /// The frame's row id when this call stored it, else none.
    pub fn capture_frame(
        &mut self,
        store: &EngineStore,
        id: &str,
        frame_json: &str,
    ) -> Result<Option<i64>, EngineError> {
        let frame =
            ace_json::parse(frame_json).map_err(|error| EngineError::Records(error.to_string()))?;
        let channel = frame
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if channel != "sdk" {
            return Ok(None);
        }
        let endpoint = self.session(id)?;
        let state = self.repo.require_state(store, id)?;
        let provider = state.borrow().state.config.provider.clone();
        if provider != "cursor" || endpoint.backend.as_deref() != Some("cursor-sdk") {
            return Ok(None);
        }
        let Some(generation) = frame
            .get("data")
            .and_then(|data| data.get("generation"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Err(EngineError::InvalidRecord);
        };
        let data = blob(&frame);
        let stored = ace_json::to_string(&ace_json::Value::from(ace_json::Map::from_iter([
            (
                "seq".to_owned(),
                frame.get("seq").cloned().unwrap_or(Value::Null),
            ),
            (
                "t".to_owned(),
                frame.get("t").cloned().unwrap_or(Value::Null),
            ),
            (
                "dir".to_owned(),
                frame.get("dir").cloned().unwrap_or(Value::Null),
            ),
            ("channel".to_owned(), Value::from("sdk")),
            ("data".to_owned(), data),
        ])));
        let json = self.bounded_json(
            &ace_json::parse(&stored).map_err(|error| EngineError::Records(error.to_string()))?,
        )?;
        let seq = frame.get("seq").and_then(Value::as_i64).unwrap_or(0);
        let (changes, inserted) = stmt_cache::run(
            store.conn(),
            CAPTURE,
            vec![
                text(id),
                text(&generation),
                SqlValue::Integer(seq),
                text(&json),
            ],
        )?;
        Ok((changes != 0).then_some(inserted))
    }
}

/// `CursorBlob.safeParse`: a shared blob's chunk bytes are stored as a length.
fn blob(frame: &Value) -> Value {
    let Some(data) = frame.get("data") else {
        return Value::Null;
    };
    let Some(body) = data.get("body") else {
        return data.clone();
    };
    let mut copy = data.clone();
    let Some(map) = copy.as_object_mut() else {
        return copy;
    };
    let mut chunk = ace_json::Map::new();
    for key in ["id", "offset", "done"] {
        if let Some(value) = body.get(key) {
            chunk.insert(key, value.clone());
        }
    }
    let bytes = body
        .get("text")
        .and_then(Value::as_str)
        .map(|text| text.len() as u64)
        .unwrap_or(0);
    chunk.insert("bytes", Value::from(bytes));
    map.insert("body", Value::from(chunk));
    copy
}
