// SPDX-License-Identifier: Apache-2.0
//! Frame dispatch: notes, sends, responses and live methods.

use ace_core::Fact;

use super::ParsedFrame;
use super::state::CodexTranslator;

pub fn handle(
    translator: &mut CodexTranslator,
    frame: &ParsedFrame,
    now: i64,
    facts: &mut Vec<Fact>,
) {
    if frame.dir == "note" {
        super::handle_note::handle_note(translator, frame, now, facts);
        return;
    }
    if frame.dir == "send" {
        super::handle_send::handle_send(translator, frame, facts);
        return;
    }
    if frame.dir == "stderr" {
        let root = translator.root_key.clone();
        let data = frame.data.clone();
        let signal = translator.note_signal(&root, "stderr", &data, true);
        facts.push(signal);
        return;
    }
    let map = frame.data.as_object().cloned().unwrap_or_default();
    let method = map.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let has_id = map.get("id").is_some();
    if method.is_empty() && has_id {
        super::handle_response::handle_response(translator, frame, now, facts);
        return;
    }
    super::handle_method::handle_method(translator, frame, now, facts);
}
