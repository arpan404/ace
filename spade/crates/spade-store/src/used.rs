//! What a bot's calls did, read back from its conversation (ADR 0200 §9): the effect words its
//! calls were read as when they started, and the ones Spade's classifier raised in a call it put to
//! the person. `ace bot init --from` declares them in the package it writes from the bot.

use rusqlite::params;

use crate::{Result, Store};

impl Store {
    /// The distinct effect words in the last `scan` events of `conversation`: each
    /// `tool_started`'s `effect` and each `call_reviewed`'s `raised`, as stored. Only those
    /// events are read, newest first, so the work is bounded by `scan`, never by the history.
    pub fn effects_used(&self, conversation: &str, scan: usize) -> Result<Vec<String>> {
        let connection = self.lock()?;
        if crate::gate::arriving(&connection, crate::gate::CONVERSATION, conversation)? {
            return Ok(Vec::new());
        }
        let scan = i64::try_from(scan).unwrap_or(i64::MAX);
        let mut statement = connection.prepare(
            "SELECT DISTINCT word FROM (
                 SELECT CASE json_extract(body, '$.type')
                            WHEN 'tool_started' THEN json_extract(body, '$.effect')
                            WHEN 'call_reviewed' THEN json_extract(body, '$.raised')
                        END AS word
                 FROM (SELECT body FROM events WHERE conversation_id = ?1
                       ORDER BY seq DESC LIMIT ?2)
             ) WHERE typeof(word) = 'text' ORDER BY word",
        )?;
        let rows = statement.query_map(params![conversation, scan], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
    }
}
