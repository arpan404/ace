// SPDX-License-Identifier: Apache-2.0
//! Metadata copies of text items (E5.3, `item-metadata.ts`). A text item's metadata is the item
//! with its text blanked, so the streaming path stays proportional to the change, never to the
//! transcript.

use ace_core::item_model::ContentPart;
use ace_core::items::Item;
use ace_json::JsString;

/// Only text items have metadata smaller than the item; any other item is its own metadata
/// (`keepsItemMetadata`, `:4`).
pub fn keeps_item_metadata(item: &Item) -> bool {
    matches!(
        item,
        Item::Message { .. } | Item::Reasoning { .. } | Item::Notice { .. }
    )
}

/// Text is already persisted as a base plus chunks. Core needs its shape, not prior characters,
/// to validate and accept the next append (`itemMetadata`, `:9`).
pub fn item_metadata(item: &Item) -> Item {
    let mut copy = item.clone();
    match &mut copy {
        Item::Message { parts, .. } => {
            for part in parts {
                if let ContentPart::Text { text, .. } = part {
                    *text = JsString::new();
                }
            }
        }
        Item::Reasoning { text, .. } | Item::Notice { text, .. } => *text = JsString::new(),
        _ => {}
    }
    copy
}

/// A copy of text metadata that one text append may change without touching the original
/// (`appendTarget`, `:22`): the item is cloned, so the append grows only the copy.
pub fn append_target(metadata: &Item) -> Item {
    metadata.clone()
}

/// Whether a text append left `item`'s metadata equal to `previous`, the metadata it was folded
/// from: it grew only text, which metadata blanks (`unchangedByTextAppend`, `:37`).
pub fn unchanged_by_text_append(previous: &Item, item: &Item) -> bool {
    match (previous, item) {
        (Item::Message { parts: before, .. }, Item::Message { parts: after, .. }) => {
            let last = after.last();
            after.len() == before.len()
                && matches!(last, Some(ContentPart::Text { source: None, .. }))
        }
        (Item::Reasoning { .. }, Item::Reasoning { source, .. })
        | (Item::Notice { .. }, Item::Notice { source, .. }) => source.is_none(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(json: &str) -> Item {
        ace_json::from_value(&ace_json::parse(json).unwrap()).unwrap()
    }

    #[test]
    fn plain_text_appends_leave_metadata_unchanged() {
        let before = item(
            r#"{"id":"i","threadId":"t","agentId":"a","type":"message","role":"assistant","parts":[{"type":"text","text":""}],"createdAt":1}"#,
        );
        let after = item(
            r#"{"id":"i","threadId":"t","agentId":"a","type":"message","role":"assistant","parts":[{"type":"text","text":"grew"}],"createdAt":1}"#,
        );
        assert!(unchanged_by_text_append(&before, &after));
        let with_source = item(
            r#"{"id":"i","threadId":"t","agentId":"a","type":"message","role":"assistant","parts":[{"type":"text","text":"grew","source":{"streamId":"s","bytes":4,"encoding":"utf8"}}],"createdAt":1}"#,
        );
        assert!(!unchanged_by_text_append(&before, &with_source));
    }

    fn message_parts_text(item: &Item) -> String {
        match item {
            Item::Message { parts, .. } => parts
                .iter()
                .filter_map(|part| match part {
                    ContentPart::Text { text, .. } => Some(text.as_str().to_owned()),
                    _ => None,
                })
                .collect(),
            _ => String::new(),
        }
    }

    #[test]
    fn metadata_blanks_the_text_it_does_not_need() {
        let message = item(
            r#"{"id":"i","threadId":"t","agentId":"a","type":"message","role":"assistant","parts":[{"type":"text","text":"hello"}],"createdAt":1}"#,
        );
        let metadata = item_metadata(&message);
        let encoded = ace_json::parse(&ace_json::ser::to_string(&metadata).unwrap()).unwrap();
        assert_eq!(
            encoded.get("parts").map(ace_json::to_string),
            Some(r#"[{"type":"text","text":""}]"#.to_owned())
        );
        assert_eq!(message_parts_text(&metadata), "");
        assert!(keeps_item_metadata(&message));
    }
}
