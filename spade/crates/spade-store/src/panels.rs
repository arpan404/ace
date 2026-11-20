//! A packaged bot's panel pages (ADR 0200 §5.2), as settings: each page once by its sha256
//! (`panel_page:<hash>`), and per bot which page each of its panels shows (`bot_panels:<bot>`,
//! `{panel id: hash}`). A page no bot names any more is collected in bounded batches
//! ([`Store::collect_panel_pages`]), never all at once and never at open (ADR 0170).

use rusqlite::params;

use crate::{Result, Store};

/// The settings key prefix a page is kept under, by its hash.
pub const PANEL_PAGE: &str = "panel_page";

/// The settings key prefix a bot's panels' pages are named under.
pub const BOT_PANELS: &str = "bot_panels";

/// The settings key page `hash` is kept under.
pub fn page_key(hash: &str) -> String {
    format!("{PANEL_PAGE}:{hash}")
}

/// The settings key bot `agent`'s panels' pages are named under.
pub fn panels_key(agent: &str) -> String {
    format!("{BOT_PANELS}:{agent}")
}

/// One batch of the collection of unused pages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Collected {
    /// Pages the batch removed.
    pub removed: usize,
    /// Where the next batch starts; none once the batch reached the last page.
    pub next: Option<String>,
}

impl Store {
    /// Looks at the next `most` kept pages after page key `after` (from the first, without one)
    /// and removes those no bot's panels name, in one transaction, so a step that names a page
    /// in the same write that keeps it is never cut in between. Every bot counts, a bot still
    /// arriving with a move too: its pages are placed before it is this machine's.
    pub fn collect_panel_pages(&self, after: Option<&str>, most: usize) -> Result<Collected> {
        let mut connection = self.lock()?;
        let tx = connection.transaction()?;
        let from = after.map_or_else(|| format!("{PANEL_PAGE}:"), str::to_owned);
        // `;` sorts right after `:`, so the range is every key under the prefix: an index walk.
        let end = format!("{PANEL_PAGE};");
        let keys: Vec<String> = {
            let mut statement = tx.prepare(
                "SELECT key FROM settings WHERE key > ?1 AND key < ?2 ORDER BY key LIMIT ?3",
            )?;
            let rows = statement.query_map(
                params![from, end, i64::try_from(most).unwrap_or(i64::MAX)],
                |row| row.get(0),
            )?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        // Every page the bots' panels name: as many as bots' panels, not as kept pages.
        let named: std::collections::HashSet<String> = {
            let mut statement = tx.prepare(
                "SELECT j.value FROM settings s, json_each(s.value) j
                 WHERE s.key > ?1 AND s.key < ?2 AND json_valid(s.value) AND j.type = 'text'",
            )?;
            let rows = statement.query_map(
                params![format!("{BOT_PANELS}:"), format!("{BOT_PANELS};")],
                |row| row.get(0),
            )?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut removed = 0;
        for key in &keys {
            let hash = key.strip_prefix(&format!("{PANEL_PAGE}:")).unwrap_or("");
            if !named.contains(hash) {
                removed += tx.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
            }
        }
        tx.commit()?;
        Ok(Collected {
            removed,
            next: (keys.len() >= most.max(1))
                .then(|| keys.last().cloned())
                .flatten(),
        })
    }
}
