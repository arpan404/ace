// SPDX-License-Identifier: Apache-2.0
//! Transcript notices: raw diagnostics retained per frame (`translator.ts`
//! notice).

use super::text::{JsString, Map, Value};
use super::translator::Step;

impl<'a> Step<'a> {
    pub(crate) fn notice(
        &mut self,
        text: &JsString,
        data: &Value,
        level: &str,
        code: &JsString,
    ) -> Value {
        let generation = self
            .generation
            .clone()
            .unwrap_or_else(|| JsString::from("invalid"));
        let mut item = JsString::from("sdk:notice:");
        item.push_js(&generation);
        item.push_js(&JsString::from(":"));
        item.push_js(&super::envelope::num_units(self.notice_sequence));
        item.push_js(&JsString::from(":"));
        item.push_js(&super::envelope::num_units(*self.notice_index as i64));
        *self.notice_index += 1;
        let mut raw = vec![self.current_raw.clone().unwrap_or(Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("cursor.sdk.v1")),
            ),
            (JsString::from("data"), data.clone()),
        ]))];
        if [
            "Malformed SDK boundary",
            "Checkpoint snapshot retained",
            "Shell output has no observed",
            "SDK task summary",
            "SDK checkpoint recovery",
        ]
        .iter()
        .any(|prefix| {
            let prefix: JsString = prefix.encode_utf16().collect();
            text.starts_with_js(&prefix)
        }) {
            raw.push(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("native-notice")),
                ),
                (JsString::from("data"), Value::Object(Map::new())),
            ]));
        }
        Value::from(vec![
            (
                JsString::from("type"),
                Value::String(JsString::from("item.upsert")),
            ),
            (JsString::from("agent"), Value::String(self.root.clone())),
            (JsString::from("item"), Value::String(item)),
            (
                JsString::from("draft"),
                Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("notice")),
                    ),
                    (JsString::from("diagnostic"), Value::Bool(true)),
                    (JsString::from("code"), Value::String(code.clone())),
                    (JsString::from("text"), Value::String(text.clone())),
                    (
                        JsString::from("level"),
                        Value::String(JsString::from(level)),
                    ),
                    (JsString::from("complete"), Value::Bool(true)),
                    (JsString::from("raw"), Value::from(raw)),
                ]),
            ),
        ])
    }

    /// A notice closure over this frame's notice state, for the delta helpers.
    pub(crate) fn notice_fn<'x>(
        diagnostics: &'x mut Vec<Value>,
        index: &'x mut u64,
        sequence: i64,
        current_raw: &'x Option<Value>,
        generation: &'x Option<JsString>,
        root: &'x JsString,
    ) -> impl FnMut(&JsString, &Value, &str) -> Value + 'x {
        move |text: &JsString, data: &Value, level: &str| {
            let mut item = JsString::from("sdk:notice:");
            item.push_js(generation.as_ref().unwrap_or(&JsString::from("invalid")));
            // `JsString::from("invalid")` is ASCII; the comparison below is exact.
            item.push_js(&JsString::from(":"));
            item.push_js(&super::envelope::num_units(sequence));
            item.push_js(&JsString::from(":"));
            item.push_js(&super::envelope::num_units(*index as i64));
            *index += 1;
            let mut raw = vec![current_raw.clone().unwrap_or(Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("cursor.sdk.v1")),
                ),
                (JsString::from("data"), data.clone()),
            ]))];
            if [
                "Malformed SDK boundary",
                "Checkpoint snapshot retained",
                "Shell output has no observed",
                "SDK task summary",
                "SDK checkpoint recovery",
            ]
            .iter()
            .any(|prefix| {
                let prefix: JsString = prefix.encode_utf16().collect();
                text.starts_with_js(&prefix)
            }) {
                raw.push(Value::from(vec![
                    (
                        JsString::from("type"),
                        Value::String(JsString::from("native-notice")),
                    ),
                    (JsString::from("data"), Value::Object(Map::new())),
                ]));
            }
            let _ = diagnostics;
            Value::from(vec![
                (
                    JsString::from("type"),
                    Value::String(JsString::from("item.upsert")),
                ),
                (JsString::from("agent"), Value::String(root.clone())),
                (JsString::from("item"), Value::String(item)),
                (
                    JsString::from("draft"),
                    Value::from(vec![
                        (
                            JsString::from("type"),
                            Value::String(JsString::from("notice")),
                        ),
                        (JsString::from("diagnostic"), Value::Bool(true)),
                        (
                            JsString::from("code"),
                            Value::String(JsString::from("cursor.diagnostic")),
                        ),
                        (JsString::from("text"), Value::String(text.clone())),
                        (
                            JsString::from("level"),
                            Value::String(JsString::from(level)),
                        ),
                        (JsString::from("complete"), Value::Bool(true)),
                        (JsString::from("raw"), Value::from(raw)),
                    ]),
                ),
            ])
        }
    }
}
