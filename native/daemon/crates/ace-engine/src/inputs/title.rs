// SPDX-License-Identifier: Apache-2.0
//! `title-input.ts` (E5.4c): the oldest real prose input of a thread, walked through the
//! creation index one item at a time in bounded pages. The index's DDL stays TypeScript
//! (`title-input.ts:12`); this module holds only the read, through `Repo::read_item_page`.

use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};

use crate::EngineError;
use crate::EngineStore;
use crate::State;
use crate::inputs::provisional_title::{UNTITLED_THREAD, provisional_title};
use crate::repository::residency::{cell_int, text};

/// The creation index walk. It names no JSON predicate: the deferred partial index
/// (`engine_first_person_input`) is not built at open on an old home, and a predicate without it
/// rescans the thread's rows for every page. `items_thread_creation` bounds the page, and the
/// person-input test runs on the item already loaded.
const SEQS: &str = "SELECT created_seq FROM items WHERE thread_id=? AND created_seq > ? ORDER BY created_seq LIMIT 64";

/// `title-input.ts`'s person-input predicate, applied to the loaded item: a user message ace
/// did not synthesize, from the person or the queue.
fn person_input(item: &Value) -> bool {
    if item.get("type").and_then(Value::as_str) != Some("message")
        || item.get("role").and_then(Value::as_str) != Some("user")
    {
        return false;
    }
    if item.get("synthetic").and_then(Value::as_bool) == Some(true) {
        return false;
    }
    match item
        .get("origin")
        .and_then(|origin| origin.get("kind"))
        .and_then(Value::as_str)
    {
        None | Some("person" | "queue") => true,
        Some(_) => false,
    }
}

/// The page budget `oldestTitleInput` reads one item with (`title-input.ts:22`).
const PAGE_BYTES: i64 = 256 * 1024;
/// The person-input sequences one page of the index walk holds (`intents.ts`'s page size).
const PAGE: usize = 64;
/// The most items one title lookup reads before it gives up (ADR 0170: bounded per call). A
/// thread still without a real input after this many rows keeps `Untitled`.
pub const TITLE_SEARCH_BUDGET: usize = 4096;

impl State {
    /// `oldestTitleInput` (`title-input.ts:17`): seek the first real prose input, skipping empty
    /// attachment or handoff envelopes in bounded pages. The index is walked a page at a time,
    /// and each item is read through the repository's own page.
    pub fn oldest_title_input(
        &mut self,
        store: &EngineStore,
        thread: &str,
    ) -> Result<Option<Value>, EngineError> {
        Ok(self
            .oldest_title_input_with_budget(store, thread, TITLE_SEARCH_BUDGET)?
            .0)
    }

    /// `oldestTitleInput` with an explicit row budget. The returned count is the items read, so
    /// a test can prove a no-match history stops at the bound.
    pub fn oldest_title_input_with_budget(
        &mut self,
        store: &EngineStore,
        thread: &str,
        budget: usize,
    ) -> Result<(Option<Value>, usize), EngineError> {
        let mut after = 0;
        let mut seen = 0usize;
        loop {
            if seen >= budget {
                return Ok((None, seen));
            }
            let rows =
                stmt_cache::all_rows(store.conn(), SEQS, vec![text(thread), Cell::Integer(after)])?;
            if rows.is_empty() {
                return Ok((None, seen));
            }
            let take = rows.len().min(budget - seen);
            seen += take;
            for row in &rows[..take] {
                let Some(seq) = row.get("created_seq").and_then(cell_int) else {
                    continue;
                };
                let page = self
                    .repo
                    .read_item_page(store, thread, seq + 1, 1, PAGE_BYTES)?;
                let Some(item) = page.into_iter().next() else {
                    continue;
                };
                if !person_input(&item) {
                    continue;
                }
                let Some(list) = item
                    .get("parts")
                    .and_then(Value::as_array)
                    .map(|parts| parts.as_slice().to_vec())
                else {
                    continue;
                };
                if provisional_title(&list, UNTITLED_THREAD).as_str() != UNTITLED_THREAD {
                    return Ok((Some(Value::Array(list.into())), seen));
                }
            }
            let last = rows
                .last()
                .and_then(|row| row.get("created_seq").and_then(cell_int))
                .unwrap_or(after);
            if rows.len() < PAGE || last <= after {
                return Ok((None, seen));
            }
            after = last;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, home};
    use std::sync::Arc;

    /// One message row with its preview and its stored size.
    fn insert(conn: &Arc<ace_store::Connection>, id: &str, seq: i64, text_body: &str, size: i64) {
        let body = format!(
            r#"{{"id":"{id}","agentId":"root","type":"message","role":"user","parts":[{{"type":"text","text":"{text_body}"}}],"origin":{{"kind":"person"}},"createdAt":1,"complete":true}}"#
        );
        conn.exec(&format!(
            "INSERT INTO items VALUES ('{id}', 't', {seq}, '{}')",
            body.replace('\'', "''")
        ))
        .expect("item");
        conn.exec(&format!(
            "INSERT INTO item_heads (id, thread_id, created_seq, size, item_type, text_prefix) VALUES ('{id}', 't', {seq}, {size}, 'message', 0)"
        ))
        .expect("head");
        conn.exec(&format!(
            "INSERT INTO item_previews VALUES ('{id}', '{}', 0)",
            body.replace('\'', "''")
        ))
        .expect("preview");
    }

    #[test]
    fn the_oldest_message_with_words_wins_and_empty_envelopes_are_skipped() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        insert(&conn, "input:empty", 1, "[file: a.png]", 100);
        insert(&conn, "input:queued", 2, "the real one", 100);
        insert(&conn, "input:synthetic", 3, "ace wrote this", 100);
        conn.exec(
            "UPDATE items SET item = json_set(item, '$.synthetic', 1) WHERE id = 'input:synthetic'",
        )
        .expect("synthetic");

        let parts = state
            .oldest_title_input(&store, "t")
            .expect("read")
            .expect("parts");
        let text = parts
            .as_array()
            .and_then(|parts| parts.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str);
        assert_eq!(text, Some("the real one"));
        assert!(
            state
                .oldest_title_input(&store, "no-such-thread")
                .expect("read")
                .is_none()
        );
    }

    #[test]
    fn without_the_title_index_the_walk_stays_bounded_and_still_finds_the_person_input() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        conn.exec("DROP INDEX engine_first_person_input")
            .expect("the deferred index is absent");
        for seq in 1..=200 {
            insert(&conn, &format!("input:{seq}"), seq, "[file: a.png]", 100);
        }
        insert(&conn, "input:queued", 201, "the real one", 100);
        let parts = state
            .oldest_title_input(&store, "t")
            .expect("read")
            .expect("parts");
        let text = parts
            .as_array()
            .and_then(|parts| parts.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str);
        assert_eq!(text, Some("the real one"));
    }

    #[test]
    fn a_thread_with_no_person_input_stops_at_the_call_budget() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        for seq in 1..=200 {
            insert(&conn, &format!("input:{seq}"), seq, "[file: a.png]", 100);
        }
        let (found, seen) = state
            .oldest_title_input_with_budget(&store, "t", 100)
            .expect("read");
        assert!(found.is_none());
        assert_eq!(seen, 100, "the walk stopped at its row budget");
    }

    #[test]
    fn a_first_message_larger_than_the_page_budget_still_gives_its_parts() {
        let conn = home("t", &crate::repository::testsupport::header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        // 300 KB stored, a preview the page can hold: the page measures the preview.
        insert(&conn, "input:big", 1, &"x".repeat(4096), 300 * 1024);
        let parts = state
            .oldest_title_input(&store, "t")
            .expect("read")
            .expect("the 300 KB message's parts");
        assert!(parts.is_array());
    }
}
