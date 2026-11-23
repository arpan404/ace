// SPDX-License-Identifier: Apache-2.0
//! A turn's step items, fetched for the whole page at once.
//!
//! Preview items (messages, notices, reasoning) come from the previews table,
//! everything else from the items table; rows arrive as cells in the `SELECT`
//! list's order and item bodies stay stored text until their step serializes.

use super::super::common::{LongError, all_rows_raw, invalid};
use super::super::row::{strs_json, text_at};
use crate::{Connection, Value};
use std::sync::Arc;

/// The stored body of each requested item.
pub struct ItemBodies {
    entries: Vec<(String, String)>,
}

impl ItemBodies {
    /// The body the steps show: previews for transcripts, full rows otherwise.
    pub fn body(&self, id: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, body)| body.as_str())
    }
}

/// Fetch every requested item's stored body, previews where the loader reads them.
pub fn batch_items(
    conn: &Arc<Connection>,
    thread_id: &str,
    item_ids: &[String],
) -> Result<ItemBodies, LongError> {
    let mut entries: Vec<(String, String)> = Vec::new();
    if item_ids.is_empty() {
        return Ok(ItemBodies { entries });
    }
    let list = strs_json(item_ids)?;
    let heads = all_rows_raw(
        conn,
        "SELECT id,item_type FROM item_heads WHERE thread_id=? AND id IN (SELECT value FROM json_each(?))",
        vec![Value::Text(thread_id.to_owned()), Value::Text(list.clone())],
    )?;
    let mut types: Vec<(String, String)> = Vec::new();
    for row in heads {
        types.push((text_at(&row, 0)?.to_owned(), text_at(&row, 1)?.to_owned()));
    }
    let previews = all_rows_raw(
        conn,
        "SELECT id,item FROM item_previews WHERE id IN (SELECT value FROM json_each(?))",
        vec![Value::Text(list.clone())],
    )?;
    let mut preview_map: Vec<(String, String)> = Vec::new();
    for row in previews {
        preview_map.push((text_at(&row, 0)?.to_owned(), text_at(&row, 1)?.to_owned()));
    }
    let items = all_rows_raw(
        conn,
        "SELECT id,item FROM items WHERE thread_id=? AND id IN (SELECT value FROM json_each(?))",
        vec![Value::Text(thread_id.to_owned()), Value::Text(list)],
    )?;
    let mut item_map: Vec<(String, String)> = Vec::new();
    for row in items {
        item_map.push((text_at(&row, 0)?.to_owned(), text_at(&row, 1)?.to_owned()));
    }
    let find = |map: &[(String, String)], id: &str| {
        map.iter()
            .find(|(known, _)| known == id)
            .map(|(_, body)| body.clone())
    };
    for item_id in item_ids {
        let kind = types
            .iter()
            .find(|(known, _)| known == item_id)
            .map(|(_, kind)| kind.as_str());
        let body = match kind {
            Some("message" | "notice" | "reasoning") => find(&preview_map, item_id),
            _ => find(&item_map, item_id),
        };
        let Some(body) = body else {
            // A missing body skips the step, as the loader's lookup does.
            continue;
        };
        entries.push((item_id.clone(), body));
    }
    Ok(ItemBodies { entries })
}

/// A stored item's fields the steps read, borrowed from its stored text.
#[derive(serde::Deserialize)]
pub struct ItemRef<'a> {
    #[serde(borrow, default)]
    pub id: Option<std::borrow::Cow<'a, str>>,
    #[serde(rename = "type", default, borrow)]
    pub type_: Option<std::borrow::Cow<'a, str>>,
    #[serde(rename = "agentId", default, borrow)]
    pub agent_id: Option<std::borrow::Cow<'a, str>>,
    #[serde(borrow, default)]
    pub call: Option<CallRef<'a>>,
}

/// A stored tool call's fields the steps read, borrowed from its stored text.
#[derive(serde::Deserialize)]
pub struct CallRef<'a> {
    #[serde(borrow, default)]
    pub detail: Option<CallDetail<'a>>,
    #[serde(borrow, default)]
    pub raw: Option<&'a serde_json::value::RawValue>,
}

/// A stored call detail's kind, borrowed from its stored text.
#[derive(serde::Deserialize)]
pub struct CallDetail<'a> {
    #[serde(borrow, default)]
    pub kind: Option<std::borrow::Cow<'a, str>>,
}

pub fn parse_item(text: &str) -> Result<ItemRef<'_>, LongError> {
    serde_json::from_str(text).map_err(|_| invalid("invalid index row"))
}
