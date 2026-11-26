// SPDX-License-Identifier: Apache-2.0
//! A Cursor thread left empty by the retired CLI (`cursor-empty-migration.ts`): one that never
//! ran, has no items and no native session continues directly on the SDK, its default instance in
//! the agent's place. `ace-engine::open` runs it after the schema, where the TypeScript repository
//! ran it.

use ace_store::stmt_cache;

use crate::EngineError;
use crate::EngineStore;

/// The SDK instance the retired CLI's default becomes (`cursor-selection.ts:4`).
pub const CURSOR_DEFAULT_INSTANCE_ID: &str = "cursor-sdk-default";
/// The SDK instance for an instance id, defaulting the retired CLI's default (`:5`).
pub fn cursor_instance_id(id: Option<&str>) -> Option<&str> {
    match id {
        Some("cursor-cli-default") => Some(CURSOR_DEFAULT_INSTANCE_ID),
        Some(id) => Some(id),
        None => None,
    }
}

const CANDIDATES: &str = "SELECT t.id AS id, s.instance_id AS instance_id, t.updated_at AS updated_at FROM threads t
      JOIN engine_sessions s ON s.thread_id=t.id
      JOIN thread_state snapshot ON snapshot.thread_id=t.id
      WHERE t.provider='cursor' AND COALESCE(json_extract(t.provider_metadata,'$.backend'),'acp')<>'cursor-sdk'
      AND s.native_session_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM items WHERE thread_id=t.id)
      AND json_extract(snapshot.state,'$.hasRun')=0
      AND NOT EXISTS (SELECT 1 FROM intents WHERE thread_id=t.id AND status IN ('pending','queued','running'))";
const SWITCH: &str =
    "UPDATE engine_sessions SET backend='cursor-sdk',instance_id=? WHERE thread_id=?";

/// `migrateEmptyCursorThreads` (`:6`): only unused CLI threads can continue directly; native ACP
/// identities never become SDK ids.
pub fn migrate_empty_cursor_threads(store: &EngineStore) -> Result<(), EngineError> {
    store.atomic(|tx| {
        let rows = stmt_cache::all_rows(tx.conn(), CANDIDATES, Vec::new())?;
        for row in &rows {
            let Some(id) = row
                .get("id")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
            else {
                continue;
            };
            let instance = row
                .get("instance_id")
                .and_then(crate::repository::residency::cell_text);
            let instance_id = cursor_instance_id(instance).unwrap_or(CURSOR_DEFAULT_INSTANCE_ID);
            let updated_at = row
                .get("updated_at")
                .and_then(crate::repository::residency::cell_int)
                .unwrap_or(0);
            stmt_cache::run(
                tx.conn(),
                SWITCH,
                vec![
                    ace_store::Value::Text(instance_id.to_owned()),
                    ace_store::Value::Text(id.clone()),
                ],
            )?;
            store.write_events(
                &id,
                r#"[{"type":"thread.updated","backend":"cursor-sdk"}]"#,
                updated_at as f64,
            )?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests;
