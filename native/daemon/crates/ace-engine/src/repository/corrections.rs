// SPDX-License-Identifier: Apache-2.0
//! The frame's two store-side corrections (`provider-facts.ts:51`-`:76`): a provider title
//! replaces a provisional one, and a provider goal replaces the stored one. Both call the
//! store's ports (`getThread`, `writeEvents`), never a collaborator.

use ace_json::Value;

use super::collaborators::InputFacts;
use super::fold::{kind, text_field};
use crate::{EngineError, EngineStore, State};

impl State {
    /// The title correction; true when the fact is the title notice and was handled.
    pub(super) fn title_correction(
        &mut self,
        store: &EngineStore,
        id: &str,
        root: &str,
        input: &Value,
        now: f64,
    ) -> Result<bool, EngineError> {
        if (kind(input) != "item.upsert" && kind(input) != "item.reconciled")
            || text_field(input, "agent") != Some(root)
            || input
                .get("draft")
                .and_then(|draft| draft.get("type"))
                .and_then(Value::as_str)
                != Some("notice")
            || input
                .get("draft")
                .and_then(|draft| draft.get("code"))
                .and_then(Value::as_str)
                != Some("thread_title")
        {
            return Ok(false);
        }
        let thread = store
            .get_thread(id)?
            .and_then(|json| ace_json::parse(&json).ok());
        let title = input
            .get("draft")
            .and_then(|draft| draft.get("title"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|title| !title.is_empty());
        let source = thread
            .as_ref()
            .and_then(|thread| thread.get("titleSource"))
            .and_then(Value::as_str);
        let current = thread
            .as_ref()
            .and_then(|thread| thread.get("title"))
            .and_then(Value::as_str);
        let takes = match source {
            Some("provisional") | Some("provider") => true,
            None => current == Some("New thread"),
            Some(_) => false,
        };
        if let Some(title) = title
            && takes
        {
            let events = format!(
                "[{{\"type\":\"thread.updated\",\"title\":{},\"titleSource\":\"provider\"}}]",
                ace_json::to_string(&Value::from(title))
            );
            store.write_events(id, &events, now)?;
        }
        Ok(true)
    }

    /// The goal correction; true when the fact is a goal update for the thread's root.
    pub(super) fn goal_correction(
        &mut self,
        store: &EngineStore,
        id: &str,
        root: &str,
        input: &Value,
        now: f64,
    ) -> Result<bool, EngineError> {
        if kind(input) == "goal.updated" && text_field(input, "agent") != Some(root) {
            return Ok(true);
        }
        if kind(input) != "goal.updated" {
            return Ok(false);
        }
        let current = store
            .get_thread(id)?
            .and_then(|json| ace_json::parse(&json).ok())
            .and_then(|value| value.get("goal").cloned());
        let goal = input.get("goal");
        if let Some(goal) = self.goal_change(current.as_ref(), goal)? {
            let events = format!(
                "[{{\"type\":\"thread.updated\",\"goal\":{}}}]",
                ace_json::to_string(&goal)
            );
            store.write_events(id, &events, now)?;
        }
        Ok(true)
    }
}
