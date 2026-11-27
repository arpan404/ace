// SPDX-License-Identifier: Apache-2.0

use ace_store::{Value, stmt_cache};
use std::rc::Rc;

use crate::{Core, EngineError};

const TRACK_NEW: &str = "
    CREATE TEMP TABLE IF NOT EXISTS engine_boot_new_blobs (id TEXT PRIMARY KEY);
    CREATE TEMP TRIGGER IF NOT EXISTS engine_boot_track_blobs AFTER INSERT ON streamed_blobs
    BEGIN INSERT OR REPLACE INTO engine_boot_new_blobs VALUES (NEW.id); END;
    DELETE FROM engine_boot_new_blobs";

const FINISH: &str = "DROP TRIGGER IF EXISTS temp.engine_boot_track_blobs;
    DROP TABLE IF EXISTS temp.engine_boot_new_blobs";

/// Remember where the previous boot stopped. Rowids can be reused, so an insert in this boot
/// is tracked explicitly even when it receives a rowid below the cutoff.
pub(crate) fn prepare(core: &Core) -> Result<(), EngineError> {
    let cutoff = stmt_cache::get_row(
        core.store.conn(),
        "SELECT max(rowid) AS cutoff FROM streamed_blobs",
        Vec::new(),
    )?
    .and_then(|row| {
        row.get("cutoff")
            .and_then(crate::repository::residency::cell_int)
    });
    if cutoff.is_some() {
        core.store.conn().exec(TRACK_NEW)?;
    }
    core.blob_recovery_cutoff.set(cutoff);
    Ok(())
}

pub(crate) async fn sweep(core: &Rc<Core>) -> Result<(), EngineError> {
    let Some(cutoff) = core.blob_recovery_cutoff.get() else {
        return Ok(());
    };
    let mut after = i64::MIN;
    while !core.closing.get() {
        let next = core.store.atomic(|tx| {
            // Seek by rowid before applying the incomplete filter. A sparse page is bounded too.
            let last = stmt_cache::get_row(tx.conn(),
                "SELECT max(rowid) AS last FROM
                 (SELECT rowid FROM streamed_blobs WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 64)",
                vec![Value::Integer(after), Value::Integer(cutoff)],
            )?.and_then(|row| row.get("last").and_then(crate::repository::residency::cell_int));
            if let Some(last) = last {
                stmt_cache::run(tx.conn(),
                    "DELETE FROM streamed_blobs WHERE rowid>? AND rowid<=? AND sha256 IS NULL
                     AND NOT EXISTS (SELECT 1 FROM temp.engine_boot_new_blobs n WHERE n.id=streamed_blobs.id)",
                    vec![Value::Integer(after), Value::Integer(last)],
                )?;
            }
            Ok(last)
        })?;
        let Some(last) = next else {
            core.store.conn().exec(FINISH)?;
            core.blob_recovery_cutoff.set(None);
            return Ok(());
        };
        after = last;
        crate::actor::yield_once().await;
    }
    Ok(())
}

/// A provider opening before the idle sweep reaches its thread must pass its own indexed
/// cleanup first. Current-boot streams and completed blobs are preserved.
pub(crate) async fn before_dispatch(core: &Core, thread: &str) -> Result<(), EngineError> {
    while let Some(cutoff) = core.blob_recovery_cutoff.get() {
        let deleted = core.store.atomic(|tx| {
            Ok(stmt_cache::run(tx.conn(),
                "DELETE FROM streamed_blobs WHERE rowid IN (
                   SELECT rowid FROM streamed_blobs INDEXED BY streamed_blob_hash
                   WHERE thread_id=? AND sha256 IS NULL AND rowid<=?
                   AND NOT EXISTS (SELECT 1 FROM temp.engine_boot_new_blobs n WHERE n.id=streamed_blobs.id)
                   ORDER BY rowid LIMIT 64)",
                vec![Value::Text(thread.to_owned()), Value::Integer(cutoff)],
            )?.0)
        })?;
        if deleted < 64 || core.closing.get() {
            break;
        }
        crate::actor::yield_once().await;
    }
    Ok(())
}
