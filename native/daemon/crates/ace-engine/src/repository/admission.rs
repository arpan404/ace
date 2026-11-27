// SPDX-License-Identifier: Apache-2.0
//! The admission rows and the opening set (E5.3, `repository.ts:154`-`:199`). The statements are
//! the TypeScript's own text; the engine reads and writes `engine_state_records` and `intents`
//! through `ace_store::stmt_cache` on the store's connection (Decision 2).

use ace_json::Value;
use ace_store::{Value as SqlValue, stmt_cache};

use crate::repository::collaborators::{InputFacts, MoveFacts, RecoveryFacts};
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
    ) -> Result<Vec<i64>, EngineError> {
        store.atomic(|tx| {
            let rows =
                stmt_cache::all_rows(tx.conn(), CORRELATED, vec![text(id), text(command_id)])?;
            Ok(ids(&rows))
        })
    }

    /// The ids a run start's admission takes (`:271`).
    pub fn acknowledge_inputs(
        &mut self,
        store: &EngineStore,
        id: &str,
    ) -> Result<Vec<i64>, EngineError> {
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

fn ids(rows: &[ace_store::stmt_cache::Row]) -> Vec<i64> {
    rows.iter()
        .filter_map(|row| row.get("id").and_then(sql_int))
        .collect()
}

impl State {
    /// The admission and acknowledgement block (`provider-facts.ts:233`-`:303`), in its order:
    /// the root's admission mark, the acknowledgement statement, the pruned queue rows, the
    /// notices it confirms, and the item updates the accepted input carries.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn admission_block(
        &mut self,
        store: &EngineStore,
        id: &str,
        snapshot: &std::rc::Rc<std::cell::RefCell<crate::snapshot::Snapshot>>,
        root_key: &str,
        events: &mut Vec<Value>,
        takes_input: &std::collections::HashMap<String, bool>,
        opening: bool,
        generation: Option<f64>,
        continuation_started: bool,
        now: f64,
    ) -> Result<(), EngineError> {
        // The TypeScript compares the run's `agentId` with the root's **id**, not its key.
        let root = snapshot
            .borrow()
            .state
            .agents
            .get(root_key)
            .map(|record| record.agent.id.clone())
            .unwrap_or_default();
        let mut updates: Vec<Value> = Vec::new();
        let mut admitted_uncertainty = false;
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
                    == Some(root.as_str())
                && {
                    let run_id = run
                        .and_then(|run| run.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let trigger = run
                        .and_then(|run| run.get("trigger"))
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    match takes_input.get(run_id) {
                        Some(takes) => *takes,
                        None => self.root_run_start(trigger, None)?.1,
                    }
                };
            let pending = if kind == "input.admitted" || root_started {
                match self.handed_over(id)? {
                    Some(pending) => Some(pending),
                    None if root_started => self.uncertain_continuation(id)?,
                    None => None,
                }
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
                            .insert(key.clone(), updated_item.clone());
                        updates.push(item_updated(&updated_item));
                    }
                }
            }
            if root_started
                && let Some(run_id) = run.and_then(|run| run.get("id")).and_then(Value::as_str)
            {
                updates.extend(self.bind_started_run(id, run_id, generation)?);
            }
            let admitted = kind == "input.admitted"
                && event.get("agentId").and_then(Value::as_str) == Some(root.as_str())
                && !opening;
            if admitted {
                self.admission_mark(store, id)?;
            }
            let started = root_started && !self.admission_has(store, id)?;
            let acknowledged = if let Some(command_id) = event
                .get("commandId")
                .and_then(Value::as_str)
                .filter(|_| admitted && kind == "input.admitted")
            {
                self.acknowledge_command(store, id, command_id)?
            } else if admitted || started {
                let uncertain = self.uncertain_continuation(id)?;
                match (&pending, uncertain) {
                    (Some(pending), Some(uncertain)) if uncertain.id == pending.id => {
                        self.acknowledge_command(store, id, &pending.command_id)?
                    }
                    _ => self.acknowledge_inputs(store, id)?,
                }
            } else {
                Vec::new()
            };
            let any_acknowledged = !acknowledged.is_empty();
            for row in acknowledged {
                self.queue_prune(row)?;
                // The delivery notices are the inputs' records: confirm them in the same
                // transcript the person sees (`provider-facts.ts:272`-`:290`).
                let key = format!("intent:{row}");
                let notice = snapshot.borrow().state.items.get(&key).cloned();
                if let Some(notice @ ace_core::items::Item::Notice { .. }) = &notice {
                    let code = match notice {
                        ace_core::items::Item::Notice { code, .. } => {
                            code.as_deref().unwrap_or_default()
                        }
                        _ => "",
                    };
                    if code == "delivery_uncertain" {
                        let confirmed = set_fields(
                            notice,
                            &[
                                ("level", Value::from("info")),
                                ("code", Value::from("delivery_confirmed")),
                                ("title", Value::from("Message received")),
                                ("text", Value::from("The provider confirmed this message")),
                            ],
                        );
                        if let Some(confirmed) = confirmed {
                            snapshot
                                .borrow_mut()
                                .state
                                .items
                                .insert(key.clone(), confirmed.clone());
                            updates.push(item_updated(&confirmed));
                        }
                    } else if code == self.resending_code()? {
                        // `resentNotice` is E5.8's: its fields are spread over the notice.
                        let resent =
                            self.resent_notice()?
                                .as_object()
                                .cloned()
                                .and_then(|fields| {
                                    let fields: Vec<(&str, Value)> = fields
                                        .iter()
                                        .map(|(key, value)| (key.as_str(), value.clone()))
                                        .collect();
                                    set_fields(notice, &fields)
                                });
                        if let Some(resent) = resent {
                            snapshot
                                .borrow_mut()
                                .state
                                .items
                                .insert(key.clone(), resent.clone());
                            updates.push(item_updated(&resent));
                        }
                    }
                }
            }
            if any_acknowledged {
                admitted_uncertainty = true;
                self.transitions_delivered(id)?;
            }
        }
        events.extend(updates);
        if continuation_started && self.queue_get(id)?.trigger.is_some() {
            self.queue_set(id, "{\"continuation\":null,\"trigger\":null}", now)?;
            self.finish_continuation(id)?;
        }
        if admitted_uncertainty || continuation_started {
            let queue = self.queue_get(id)?;
            if queue.reason.as_deref() == Some("uncertain") && !self.queue_has_uncertain(id)? {
                let json = if !queue.limited && !queue.continuation {
                    "{\"paused\":false,\"reason\":null}"
                } else {
                    "{}"
                };
                self.queue_set(id, json, now)?;
            }
        }
        Ok(())
    }
}

/// The payload an item update carries (`{type:"item.updated", item}`).
fn item_updated(item: &ace_core::items::Item) -> Value {
    let json = ace_json::ser::to_string(item).unwrap_or_default();
    let item = ace_json::parse(&json).unwrap_or(Value::Null);
    let mut payload = ace_json::Map::new();
    payload.insert("type", Value::from("item.updated"));
    payload.insert("item", item);
    Value::from(payload)
}

/// A record with fields set, through its JSON.
fn set_fields(
    item: &ace_core::items::Item,
    fields: &[(&str, Value)],
) -> Option<ace_core::items::Item> {
    let json = ace_json::ser::to_string(item).ok()?;
    let mut value = ace_json::parse(&json).ok()?;
    let object = value.as_object_mut()?;
    for (key, field) in fields {
        object.insert(*key, field.clone());
    }
    let encoded = ace_json::to_string(&value);
    ace_json::from_value(&ace_json::parse(&encoded).ok()?).ok()
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

#[cfg(test)]
mod tests {
    use crate::State;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn an_acknowledgement_takes_the_stores_transaction_boundary() {
        // `repository.ts:177` wraps `acknowledgeCommand` in `store.atomic`; a failing store is
        // reported, never read around.
        let conn = home("ack", &header("ack"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        assert!(
            state
                .acknowledge_command(&store, "ack", "none")
                .unwrap()
                .is_empty()
        );
        let failing = Shell::failing_store(&conn);
        assert!(state.acknowledge_command(&failing, "ack", "none").is_err());
    }
}
