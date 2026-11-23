// SPDX-License-Identifier: Apache-2.0
//! Transcript notices: raw diagnostics retained per frame (`translator.ts`
//! notice).

use super::json::{J, encode_units};
use super::translator::Step;

impl<'a> Step<'a> {
    pub(crate) fn notice(&mut self, text: &[u16], data: &J, level: &str, code: &[u16]) -> J {
        let generation = self
            .generation
            .clone()
            .unwrap_or_else(|| encode_units("invalid"));
        let mut item = encode_units("sdk:notice:");
        item.extend_from_slice(&generation);
        item.extend_from_slice(&encode_units(":"));
        item.extend_from_slice(&super::envelope::num_units(self.notice_sequence));
        item.extend_from_slice(&encode_units(":"));
        item.extend_from_slice(&super::envelope::num_units(*self.notice_index as i64));
        *self.notice_index += 1;
        let mut raw = vec![self.current_raw.clone().unwrap_or(J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("cursor.sdk.v1"))),
            (encode_units("data"), data.clone()),
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
            let prefix: Vec<u16> = prefix.encode_utf16().collect();
            text.starts_with(&prefix)
        }) {
            raw.push(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("native-notice"))),
                (encode_units("data"), J::Obj(Vec::new())),
            ]));
        }
        J::Obj(vec![
            (encode_units("type"), J::Str(encode_units("item.upsert"))),
            (encode_units("agent"), J::Str(self.root.to_vec())),
            (encode_units("item"), J::Str(item)),
            (
                encode_units("draft"),
                J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("notice"))),
                    (encode_units("diagnostic"), J::Bool(true)),
                    (encode_units("code"), J::Str(code.to_vec())),
                    (encode_units("text"), J::Str(text.to_vec())),
                    (encode_units("level"), J::Str(encode_units(level))),
                    (encode_units("complete"), J::Bool(true)),
                    (encode_units("raw"), J::Arr(raw)),
                ]),
            ),
        ])
    }

    /// A notice closure over this frame's notice state, for the delta helpers.
    pub(crate) fn notice_fn<'x>(
        diagnostics: &'x mut Vec<J>,
        index: &'x mut u64,
        sequence: i64,
        current_raw: &'x Option<J>,
        generation: &'x Option<Vec<u16>>,
        root: &'x [u16],
    ) -> impl FnMut(&[u16], &J, &str) -> J + 'x {
        move |text: &[u16], data: &J, level: &str| {
            let mut item = encode_units("sdk:notice:");
            item.extend_from_slice(generation.as_deref().unwrap_or(&encode_units("invalid")));
            // `encode_units("invalid")` is ASCII; the comparison below is exact.
            item.extend_from_slice(&encode_units(":"));
            item.extend_from_slice(&super::envelope::num_units(sequence));
            item.extend_from_slice(&encode_units(":"));
            item.extend_from_slice(&super::envelope::num_units(*index as i64));
            *index += 1;
            let mut raw = vec![current_raw.clone().unwrap_or(J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("cursor.sdk.v1"))),
                (encode_units("data"), data.clone()),
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
                let prefix: Vec<u16> = prefix.encode_utf16().collect();
                text.starts_with(&prefix)
            }) {
                raw.push(J::Obj(vec![
                    (encode_units("type"), J::Str(encode_units("native-notice"))),
                    (encode_units("data"), J::Obj(Vec::new())),
                ]));
            }
            let _ = diagnostics;
            J::Obj(vec![
                (encode_units("type"), J::Str(encode_units("item.upsert"))),
                (encode_units("agent"), J::Str(root.to_vec())),
                (encode_units("item"), J::Str(item)),
                (
                    encode_units("draft"),
                    J::Obj(vec![
                        (encode_units("type"), J::Str(encode_units("notice"))),
                        (encode_units("diagnostic"), J::Bool(true)),
                        (
                            encode_units("code"),
                            J::Str(encode_units("cursor.diagnostic")),
                        ),
                        (encode_units("text"), J::Str(text.to_vec())),
                        (encode_units("level"), J::Str(encode_units(level))),
                        (encode_units("complete"), J::Bool(true)),
                        (encode_units("raw"), J::Arr(raw)),
                    ]),
                ),
            ])
        }
    }
}
