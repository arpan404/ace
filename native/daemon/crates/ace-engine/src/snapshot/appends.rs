// SPDX-License-Identifier: Apache-2.0
//! Text appends and item metadata (E5.3 step 5, `persistence.ts:161`-`:211`). A text item's
//! metadata is the item with its text blanked, and a plain text append that changed nothing
//! else leaves it as it is, so the streaming path stays proportional to the change.

use ace_core::items::Item;
use ace_json::Value;

use super::Snapshot;
use super::metadata::{
    append_target, item_metadata, keeps_item_metadata, unchanged_by_text_append,
};
use crate::EngineError;
use crate::records::{Append, PathStep};

impl Snapshot {
    /// `prepare` (`:159`): the metadata copy this delta's append grows, when it can append.
    pub fn prepare(&mut self, item: &str, field: &str) -> Result<(), EngineError> {
        if field == "output" || self.items.has_replacement(item) {
            return Ok(());
        }
        if let Some(metadata) = self.metadata.read(item)? {
            self.items.set_append_value(item, append_target(&metadata));
            return Ok(());
        }
        if !self.state.items.contains_key(item)
            && let Some(stored) = self.items.read(item)?
        {
            self.state.items.insert(item.to_owned(), stored);
        }
        if let Some(current) = self.state.items.get(item) {
            self.items.set_append_value(item, item_metadata(current));
        }
        Ok(())
    }

    /// The finish closure of `prepare`.
    pub fn finish_prepare(&mut self, item: &str) {
        self.items.finish_append_value(item);
    }

    /// `remember` (`:172`): keep the metadata copy current after the fact's events.
    pub fn remember(
        &mut self,
        kind: &str,
        item_key: &str,
        events: &[Value],
    ) -> Result<(), EngineError> {
        let Some(item) = self.state.items.get(item_key).cloned() else {
            return Ok(());
        };
        let key = item.id().to_owned();
        let mentions = events
            .iter()
            .any(|event| match event.get("type").and_then(Value::as_str) {
                Some("item.created") | Some("item.updated") => {
                    event
                        .get("item")
                        .and_then(|item| item.get("id"))
                        .and_then(Value::as_str)
                        == Some(key.as_str())
                }
                Some("item.delta") => {
                    event.get("itemId").and_then(Value::as_str) == Some(key.as_str())
                }
                _ => false,
            });
        if !mentions {
            return Ok(());
        }
        let previous = self.metadata.read(item_key)?;
        if !keeps_item_metadata(&item) {
            // A copy would equal the item; `prepare` and `streamItem` fall back to the item.
            if previous.is_some() {
                self.metadata.delete(item_key);
            }
            return Ok(());
        }
        // The common text delta: the append grew only text, so the metadata is as it was.
        if kind == "item.delta"
            && let Some(previous) = &previous
            && unchanged_by_text_append(previous, &item)
        {
            return Ok(());
        }
        let next = item_metadata(&item);
        let changed = match &previous {
            Some(previous) => {
                ace_json::ser::to_string(previous).ok() != ace_json::ser::to_string(&next).ok()
            }
            None => true,
        };
        if changed {
            self.metadata.write(item_key, next);
        }
        Ok(())
    }

    /// `delta` (`:201`): append to a message's last text part, or a reasoning/notice's text.
    pub fn delta(
        &mut self,
        item: &str,
        append: &str,
        in_transaction: bool,
    ) -> Result<(), EngineError> {
        let Some(current) = self.state.items.get(item) else {
            return Ok(());
        };
        let text = append.to_owned();
        let patch = match current {
            Item::Message { parts, .. } => Append {
                path: vec![
                    PathStep::Key("parts".to_owned()),
                    PathStep::Index(parts.len().saturating_sub(1) as u64),
                    PathStep::Key("text".to_owned()),
                ],
                text,
                seed: Some(ace_json::parse(r#"{"type":"text"}"#).unwrap_or_default()),
            },
            Item::Reasoning { .. } | Item::Notice { .. } => Append {
                path: vec![PathStep::Key("text".to_owned())],
                text,
                seed: None,
            },
            _ => return Ok(()),
        };
        self.items.append(item, patch, in_transaction)
    }

    /// `retainChanges` (`:269`): only items the batch's events say changed keep their values.
    pub fn retain_changes(&mut self, events: &[Value]) {
        let mut changed: std::collections::HashSet<String> = std::collections::HashSet::new();
        for event in events {
            match event.get("type").and_then(Value::as_str) {
                Some("item.updated") | Some("item.created") => {
                    if let Some(id) = event
                        .get("item")
                        .and_then(|item| item.get("id"))
                        .and_then(Value::as_str)
                    {
                        changed.insert(id.to_owned());
                    }
                }
                Some("item.delta")
                    if event.get("field").and_then(Value::as_str) == Some("output") =>
                {
                    if let Some(id) = event.get("itemId").and_then(Value::as_str) {
                        changed.insert(id.to_owned());
                    }
                }
                _ => {}
            }
        }
        self.items
            .retain_changes(|item| changed.contains(item.id()));
    }
}
