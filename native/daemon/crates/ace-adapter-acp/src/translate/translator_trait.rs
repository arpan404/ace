// SPDX-License-Identifier: Apache-2.0
//! The ACP translator behind the shared `Translator` trait (E0).

use crate::translate::translator::AcpTranslator;
use ace_json::Value;

fn value_to_fact(value: &Value) -> Option<ace_core::Fact> {
    let fact_type = value.get("type")?.as_str()?.to_owned();
    let mut body = value.as_object()?.clone();
    body.shift_remove("type");
    let json = ace_json::ser::to_string(&Value::Object(body)).ok()?;
    let data = ace_json::Raw::from_string(json).ok()?;
    Some(ace_core::Fact { fact_type, data })
}

fn value_to_json_string(value: &Value) -> Option<String> {
    ace_json::ser::to_string(value).ok()
}

impl ace_adapter_api::translator::Translator for AcpTranslator {
    fn take_diagnostics(&mut self) -> Vec<String> {
        let diagnostics = std::mem::take(&mut self.state.diagnostics);
        diagnostics
            .iter()
            .filter_map(value_to_json_string)
            .collect()
    }

    fn next_deadline(&self) -> Option<i64> {
        None
    }

    fn translate(
        &mut self,
        frame: &ace_adapter_api::frame::Frame,
        now_ms: i64,
    ) -> Vec<ace_core::Fact> {
        let dir = match frame.dir {
            ace_adapter_api::frame::FrameDirection::Send => "send",
            ace_adapter_api::frame::FrameDirection::Recv => "recv",
            ace_adapter_api::frame::FrameDirection::Stderr => "stderr",
            ace_adapter_api::frame::FrameDirection::Note => "note",
        };
        let data: Value = match ace_json::parse(frame.data.get()) {
            Ok(data) => data,
            Err(_) => {
                self.state.diagnostics.push(crate::translate::data::raw(
                    &Value::from(frame.data.get().to_owned()),
                    "malformed",
                    None,
                ));
                let mut signal = ace_json::Map::with_capacity(1);
                signal.insert("type".to_owned(), Value::from("signal".to_owned()));
                let signal_value = Value::Object(signal);
                return value_to_fact(&signal_value).into_iter().collect();
            }
        };
        let mut frame_value = ace_json::Map::with_capacity(5);
        frame_value.insert("seq".to_owned(), Value::from(frame.seq));
        frame_value.insert("t".to_owned(), Value::from(frame.t));
        frame_value.insert("dir".to_owned(), Value::from(dir.to_owned()));
        frame_value.insert("channel".to_owned(), Value::from(frame.channel.clone()));
        frame_value.insert("data".to_owned(), data);
        let values = self.translate(&Value::Object(frame_value), now_ms);
        values.iter().filter_map(value_to_fact).collect()
    }

    fn tick(&mut self, now_ms: i64) -> Vec<ace_core::Fact> {
        let values = self.tick(now_ms);
        // Name the inherent method to avoid recursing into this trait method.
        // (The inherent `tick` above is what folds time-based facts.)
        values.iter().filter_map(value_to_fact).collect()
    }
}
