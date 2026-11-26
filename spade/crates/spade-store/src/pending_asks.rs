use rusqlite::{Transaction, params};
use spade_core::Event;

use crate::{Result, Store, StoredEvent};

pub(crate) fn enqueue(tx: &Transaction<'_>, conversation: &str, seq: i64) -> Result<()> {
    // Hidden helpers and task lanes mirror their asks to the owning bot.
    tx.execute(
        "INSERT INTO pending_ask_notices (conversation_id, seq)
         SELECT conversation_id, ?2 FROM agents WHERE conversation_id = ?1",
        params![conversation, seq],
    )?;
    Ok(())
}

impl Store {
    pub fn pending_ask_notices(&self) -> Result<Vec<(String, StoredEvent)>> {
        let connection = self.lock()?;
        let mut stmt = connection.prepare(
            "SELECT p.conversation_id, p.seq, e.at_ms, e.body
             FROM pending_ask_notices p JOIN events e USING (conversation_id, seq)
             ORDER BY e.at_ms, p.conversation_id, p.seq",
        )?;
        let rows = stmt.query_map([], |row| {
            let body: String = row.get(3)?;
            Ok((
                row.get(0)?,
                StoredEvent {
                    seq: row.get(1)?,
                    at_ms: row.get(2)?,
                    event: Event::from_json(
                        serde_json::from_str(&body).unwrap_or(serde_json::Value::String(body)),
                    ),
                },
            ))
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Stages reach accounting and removes the source events together. If a live notice could
    /// not be handed to the stream, dropping the transaction leaves the batch queued.
    /// Publishing before commit permits a retry after a crash in that gap.
    pub fn finish_ask_notices(
        &self,
        sources: &[(String, i64)],
        settings: &[(&str, &str)],
        publish: impl FnOnce() -> bool,
    ) -> Result<()> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        for (conversation, seq) in sources {
            tx.execute(
                "DELETE FROM pending_ask_notices WHERE conversation_id = ?1 AND seq = ?2",
                params![conversation, seq],
            )?;
        }
        for (key, value) in settings {
            tx.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )?;
        }
        if publish() {
            tx.commit()?;
        }
        Ok(())
    }
}
