// SPDX-License-Identifier: Apache-2.0
//! The admission rows and the opening set (E5.3, `repository.ts:154`-`:199`). The statements are
//! the TypeScript's own text; the engine reads and writes `engine_state_records` and `intents`
//! through `ace_store::stmt_cache` on the store's connection (Decision 2).

use ace_json::Value;
use ace_store::{Value as SqlValue, stmt_cache};

use crate::repository::collaborators::{InputFacts, MoveFacts};
use crate::repository::residency::text;
use crate::{EngineError, EngineStore, State};

pub const HAS_ADMISSION: &str = "SELECT 1 FROM engine_state_records WHERE thread_id=? AND section='engineAdmission' AND key='root'";
pub const MARK_ADMISSION: &str =
    "INSERT OR IGNORE INTO engine_state_records VALUES (?, 'engineAdmission', 'root', 'true')";
pub const RESET_ADMISSION: &str = "DELETE FROM engine_state_records WHERE thread_id=? AND section='engineAdmission' AND key='root'";
/// The input a command sent is taken (`repository.ts:162`).
pub const CORRELATED: &str = "UPDATE intents SET awaiting=0, acknowledged=1, uncertain=0, status=CASE WHEN uncertain=1 THEN 'done' ELSE status END, error=NULL WHERE thread_id=? AND command_id=? AND submitted_generation IS NOT NULL AND (awaiting=1 OR uncertain=1) RETURNING id";
/// A run start takes the input handed over for it and its group (`:168`).
pub const ACK: &str = "UPDATE intents SET awaiting=0, acknowledged=1 WHERE thread_id=? AND awaiting=1 AND submitted_generation IS NOT NULL AND ack_target=(
        SELECT ack_target FROM intents WHERE thread_id=? AND awaiting=1 AND submitted_generation IS NOT NULL ORDER BY id LIMIT 1
      ) RETURNING id";

impl State {
    /// Whether the thread's root already has an admission record.
    pub fn admission_has(&mut self, store: &EngineStore, id: &str) -> Result<bool, EngineError> {
        Ok(stmt_cache::get_row(store.conn(), HAS_ADMISSION, vec![text(id)])?.is_some())
    }

    /// Record the root's admission once.
    pub fn admission_mark(&mut self, store: &EngineStore, id: &str) -> Result<(), EngineError> {
        stmt_cache::run(store.conn(), MARK_ADMISSION, vec![text(id)])?;
        Ok(())
    }

    /// The ids `acknowledgeCommand` takes (`:177`).
    pub fn acknowledge_command(
        &mut self,
        store: &EngineStore,
        id: &str,
        command_id: &str,
    ) -> Result<Vec<u32>, EngineError> {
        let rows =
            stmt_cache::all_rows(store.conn(), CORRELATED, vec![text(id), text(command_id)])?;
        Ok(ids(&rows))
    }

    /// The ids a run start's admission takes (`:271`).
    pub fn acknowledge_inputs(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Vec<u32>, EngineError> {
        let rows = stmt_cache::all_rows(store.conn(), ACK, vec![text(id), text(id)])?;
        Ok(ids(&rows))
    }

    /// `resetAdmission` (`:185`).
    pub fn reset_admission(&mut self, store: &EngineStore, id: &str) -> Result<(), EngineError> {
        stmt_cache::run(store.conn(), RESET_ADMISSION, vec![text(id)])?;
        Ok(())
    }

    /// `beginSessionOpen` (`:182`).
    pub fn begin_session_open(&mut self, id: &str) {
        self.repo.opening.insert(id.to_owned());
    }

    /// `finishSessionOpen` (`:194`).
    pub fn finish_session_open(&mut self, id: &str) {
        self.repo.opening.remove(id);
    }

    /// `sessionOpening` (`:578`).
    pub fn session_opening(&self, id: &str) -> bool {
        self.repo.opening.contains(id)
    }
}

/// A row cell as an integer.
fn sql_int(value: &SqlValue) -> Option<i64> {
    match value {
        SqlValue::Integer(number) => Some(*number),
        _ => None,
    }
}

fn ids(rows: &[ace_store::stmt_cache::Row]) -> Vec<u32> {
    rows.iter()
        .filter_map(|row| row.get("id").and_then(sql_int))
        .map(|id| id as u32)
        .collect()
}

impl State {
    /// The admission and acknowledgement block (`provider-facts.ts:233`-`:303`), in its order:
    /// the root's admission mark, the acknowledgement statement, the pruned queue rows, and the
    /// item updates the accepted input carries.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn admission_block(
        &mut self,
        store: &EngineStore,
        id: &str,
        snapshot: &std::rc::Rc<std::cell::RefCell<crate::snapshot::Snapshot>>,
        root: &str,
        events: &mut Vec<Value>,
        takes_input: &std::collections::HashMap<String, bool>,
        opening: bool,
        _generation: Option<f64>,
    ) -> Result<(), EngineError> {
        let mut updates: Vec<Value> = Vec::new();
        let mut admitted_uncertainty = false;
        let mut acknowledged_ids: Vec<u32> = Vec::new();
        for event in events.clone() {
            let kind = event
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let run = event.get("run");
            let root_started = kind == "run.started"
                && !opening
                && run
                    .and_then(|run| run.get("agentId"))
                    .and_then(Value::as_str)
                    == Some(root)
                && {
                    let run_id = run
                        .and_then(|run| run.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    takes_input.get(run_id).copied().unwrap_or(true)
                };
            let pending = if kind == "input.admitted" || root_started {
                self.handed_over(id)?
            } else {
                None
            };
            let command_id = if kind == "input.admitted" {
                event
                    .get("commandId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| pending.as_ref().map(|pending| pending.command_id.clone()))
            } else {
                None
            };
            if let Some(command_id) = &command_id {
                let key = format!("input:{command_id}");
                let item = snapshot.borrow().state.items.get(&key).cloned();
                if let Some(ace_core::items::Item::Message { base, .. }) = &item
                    && base.agent_id == root
                    && kind == "input.admitted"
                    && let Some(native_id) = event.get("nativeInputId").and_then(Value::as_str)
                {
                    let updated = item
                        .as_ref()
                        .and_then(|item| set_field(item, "nativeId", Value::from(native_id)));
                    if let Some(updated_item) = updated {
                        snapshot
                            .borrow_mut()
                            .state
                            .items
                            .insert(key.clone(), updated_item);
                    }
                }
            }
            if root_started
                && let Some(run_id) = run.and_then(|run| run.get("id")).and_then(Value::as_str)
            {
                updates.extend(self.bind_started_run(id, run_id, _generation)?);
            }
            let admitted = kind == "input.admitted"
                && event.get("agentId").and_then(Value::as_str) == Some(root)
                && !opening;
            if admitted {
                self.admission_mark(store, id)?;
            }
            let started = root_started && !self.admission_has(store, id)?;
            let acknowledged = if let Some(command_id) = event
                .get("commandId")
                .and_then(Value::as_str)
                .filter(|_| admitted)
            {
                self.acknowledge_command(store, id, command_id)?
            } else if admitted || started {
                self.acknowledge_inputs(store, id)?
            } else {
                Vec::new()
            };
            for row in acknowledged {
                self.queue_prune(row)?;
                acknowledged_ids.push(row);
                // The delivery notices are E5.4's inputs' records; their text updates land
                // with that item. The ids are kept so the queue and transitions settle here.
                let _ = row;
            }
            if !acknowledged_ids.is_empty() {
                admitted_uncertainty = true;
                self.transitions_delivered(id)?;
            }
        }
        events.extend(updates);
        if admitted_uncertainty {
            let queue = self.queue_get(id)?;
            if queue.reason.as_deref() == Some("uncertain") && !self.queue_has_uncertain(id)? {
                let json = if !queue.limited && !queue.continuation {
                    "{\"paused\":false,\"reason\":null}"
                } else {
                    "{}"
                };
                self.queue_set(id, json, 0.0)?;
            }
        }
        Ok(())
    }
}

/// One field set on a record, through its JSON: the item a run's admission updates.
fn set_field(
    item: &ace_core::items::Item,
    key: &str,
    value: Value,
) -> Option<ace_core::items::Item> {
    let json = ace_json::ser::to_string(item).ok()?;
    let mut object = ace_json::parse(&json).ok()?;
    object.as_object_mut()?.insert(key, value);
    ace_json::from_value(&ace_json::parse(&ace_json::to_string(&object)).ok()?).ok()
}
