// SPDX-License-Identifier: Apache-2.0
//! `SteerNotes` (`steer-notes.ts:31`-`:50`, E5.4a as a synchronous receipt dependency; the
//! steering lane is E5.5's). The table's DDL stays TypeScript.

use ace_store::{Value, stmt_cache};
use std::sync::Arc;

use crate::EngineError;

const PERSON_STEERED: &str =
    "INSERT INTO engine_steer_notes(intent_id,person,fell_back) VALUES (?,1,0)
      ON CONFLICT(intent_id) DO UPDATE SET person=1,fell_back=0";
const FELL_BACK: &str = "INSERT INTO engine_steer_notes(intent_id,fell_back) VALUES (?,1)
      ON CONFLICT(intent_id) DO UPDATE SET fell_back=1";
const STEERED_AGAIN: &str = "UPDATE engine_steer_notes SET fell_back=0 WHERE intent_id=?";
const PERSON_CHOSE: &str = "SELECT 1 FROM engine_steer_notes WHERE intent_id=? AND person=1";

fn intent(value: i64) -> Value {
    Value::Integer(value)
}

/// The person steered the waiting message in: it no longer reads as fallen back.
pub fn person_steered(conn: &Arc<ace_store::Connection>, note: i64) -> Result<(), EngineError> {
    stmt_cache::run(conn, PERSON_STEERED, vec![intent(note)])?;
    Ok(())
}

/// The steer couldn't go in and waits in the queue as the next message.
pub fn fell_back(conn: &Arc<ace_store::Connection>, note: i64) -> Result<(), EngineError> {
    stmt_cache::run(conn, FELL_BACK, vec![intent(note)])?;
    Ok(())
}

/// Steered in again by an agent: a waiting steer once more, not a fallen-back one.
pub fn steered_again(conn: &Arc<ace_store::Connection>, note: i64) -> Result<(), EngineError> {
    stmt_cache::run(conn, STEERED_AGAIN, vec![intent(note)])?;
    Ok(())
}

/// Whether the person chose to steer this message in.
pub fn person_chose(conn: &Arc<ace_store::Connection>, note: i64) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(conn, PERSON_CHOSE, vec![intent(note)])?.is_some())
}
