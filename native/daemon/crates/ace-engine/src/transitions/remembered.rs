// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! The durable half of `transition-state.ts` that a receipt writes and no turn executes: the
//! selection a thread remembers per provider and model (`remember`, `:190`), and the
//! conversation a handoff cites (`HandoffAccess.grant`, `handoff-access.ts:41`).

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::repository::residency::{cell_int, text};
use crate::transitions::metadata::invalid;
use crate::{EngineError, EngineStore, State};

const OPTION: &str =
    "SELECT value FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?";
const OPTION_COUNT: &str = "SELECT COUNT(*) AS n FROM engine_model_options WHERE thread_id=?";
const FORGET_OPTION: &str =
    "DELETE FROM engine_model_options WHERE thread_id=? AND provider=? AND model=?";
const REMEMBER: &str = "INSERT INTO engine_model_options VALUES (?, ?, ?, ?)";
const GRANT_FOUND: &str = "SELECT source FROM engine_handoff_grants WHERE recipient=? AND source=?";
const GRANT_COUNT: &str = "SELECT COUNT(*) AS n FROM engine_handoff_grants WHERE recipient=?";
const GRANT: &str = "INSERT INTO engine_handoff_grants VALUES (?, ?, ?)
      ON CONFLICT(recipient,source) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)";

/// Grant handoff history inside a caller's open transaction.
pub fn grant_handoff(
    conn: &std::sync::Arc<ace_store::Connection>,
    recipient: &str,
    source: &str,
    through_seq: i64,
) -> Result<(), EngineError> {
    let found = stmt_cache::get_row(conn, GRANT_FOUND, vec![text(recipient), text(source)])?;
    if found.is_none() {
        let count = stmt_cache::get_row(conn, GRANT_COUNT, vec![text(recipient)])?
            .and_then(|row| row.get("n").and_then(cell_int))
            .unwrap_or(0);
        if count >= 8 {
            return Err(EngineError::Records(
                "Handoff history grant capacity exceeded".to_owned(),
            ));
        }
    }
    stmt_cache::run(
        conn,
        GRANT,
        vec![text(recipient), text(source), Cell::Integer(through_seq)],
    )?;
    Ok(())
}

impl State {
    /// `TransitionState.remember` (`:190`): the selection, at most 32 per thread.
    pub fn transition_remember(
        &mut self,
        store: &EngineStore,
        id: &str,
        selection: &Value,
    ) -> Result<(), EngineError> {
        let provider = selection
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("selection has no provider"))?;
        let model = selection.get("model").and_then(Value::as_str).unwrap_or("");
        let json = ace_json::to_string(selection);
        store.atomic(|tx| {
            let count = stmt_cache::get_row(tx.conn(), OPTION_COUNT, vec![text(id)])?
                .and_then(|row| row.get("n").and_then(cell_int))
                .unwrap_or(0);
            let remembered = stmt_cache::get_row(
                tx.conn(),
                OPTION,
                vec![text(id), text(provider), text(model)],
            )?;
            if count >= 32 && remembered.is_none() {
                return Err(EngineError::Records(
                    "Remembered model capacity exceeded".to_owned(),
                ));
            }
            // rowid tracks the last selection without time or randomness dependencies.
            stmt_cache::run(
                tx.conn(),
                FORGET_OPTION,
                vec![text(id), text(provider), text(model)],
            )?;
            stmt_cache::run(
                tx.conn(),
                REMEMBER,
                vec![text(id), text(provider), text(model), text(&json)],
            )?;
            Ok(())
        })
    }

    /// `HandoffAccess.grant` (`handoff-access.ts:41`): the source's conversation through `seq`,
    /// granted to at most 8 recipients.
    pub fn handoff_grant(
        &mut self,
        store: &EngineStore,
        recipient: &str,
        source: &str,
        through_seq: i64,
    ) -> Result<(), EngineError> {
        store.atomic(|tx| {
            let found =
                stmt_cache::get_row(tx.conn(), GRANT_FOUND, vec![text(recipient), text(source)])?;
            if found.is_none() {
                let count = stmt_cache::get_row(tx.conn(), GRANT_COUNT, vec![text(recipient)])?
                    .and_then(|row| row.get("n").and_then(cell_int))
                    .unwrap_or(0);
                if count >= 8 {
                    return Err(EngineError::Records(
                        "Handoff history grant capacity exceeded".to_owned(),
                    ));
                }
            }
            stmt_cache::run(
                tx.conn(),
                GRANT,
                vec![text(recipient), text(source), Cell::Integer(through_seq)],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn guards_are_owned_by_one_command_and_remembered_selections_cap_at_thirty_two() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        assert!(!state.transition_guarded(&store, "t").expect("guarded"));
        state.transition_guard(&store, "t", "cmd").expect("guard");
        assert_eq!(
            state
                .transition_guard_owner(&store, "t")
                .expect("owner")
                .as_deref(),
            Some("cmd")
        );
        for index in 0..32 {
            let selection = value(&format!(
                r#"{{"provider":"codex","model":"m{index}","options":{{}}}}"#
            ));
            state
                .transition_remember(&store, "t", &selection)
                .expect("remember");
        }
        // A selection already remembered is replaced, not counted again.
        let same = value(r#"{"provider":"codex","model":"m31","options":{"x":true}}"#);
        state
            .transition_remember(&store, "t", &same)
            .expect("an existing selection is replaced");
        let extra = value(r#"{"provider":"codex","model":"m32","options":{}}"#);
        assert_eq!(
            state
                .transition_remember(&store, "t", &extra)
                .unwrap_err()
                .to_string(),
            "Remembered model capacity exceeded"
        );
    }
}
