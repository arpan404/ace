// SPDX-License-Identifier: Apache-2.0
//! `ThreadTransitions.execute` (E5.9), the merge half: citing a fork's work back into the
//! thread it came from writes one merged-context input, grants the fork's conversation and
//! marks the thread's handoff history. A switch or fork execution needs the sessions and models
//! ports; the merge needs neither, and lands here complete.
//!
//! Cases ported from `thread-merge-account.process.test.ts` and `transition-regressions` (the
//! lineage and citation refusals).

use ace_json::Value;

use crate::intents::header::IntentHeader;
use crate::transitions::history;
use crate::transitions::metadata::{admit_metadata, metadata_json};
use crate::transitions::remembered::{grant_fits, grant_handoff};
use crate::{EngineError, EngineStore, State};

/// `execute_merge` (`transitions.ts:72`-`:119`): the fork's summary and citations become one
/// input on `source`, and the source may page the fork's history from here.
pub struct MergeRequest<'a> {
    pub summary: &'a Value,
    pub citations: &'a Value,
    pub intent_id: i64,
    /// The running intent this merge settles, in the same transaction as its own writes.
    pub intent: Option<&'a IntentHeader>,
    pub patch_applied: bool,
    pub now: f64,
}

pub fn merge(
    store: &EngineStore,
    state: &mut State,
    source: &str,
    fork: &str,
    request: MergeRequest<'_>,
) -> Result<(), EngineError> {
    let MergeRequest {
        summary,
        citations,
        intent_id,
        intent,
        patch_applied,
        now,
    } = request;
    let thread = store
        .get_thread(fork)?
        .and_then(|json| ace_json::parse(&json).ok());
    let parent = thread
        .as_ref()
        .and_then(|thread| thread.get("lineage"))
        .and_then(|lineage| lineage.get("parentThreadId"))
        .and_then(Value::as_str);
    if parent != Some(source) {
        return Err(EngineError::Records("Fork lineage changed".to_owned()));
    }
    let ids: Vec<String> = citations
        .as_array()
        .map(|citations| {
            citations
                .iter()
                .filter_map(|citation| {
                    citation
                        .get("itemId")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default();
    history::validate_citations(store, fork, &ids)?;
    // The protocol's citation is the two ids; a client's extra fields are stripped, as the
    // command's own schema parse strips them, before the context and the item are built.
    let cited: Vec<Value> = citations
        .as_array()
        .map(|citations| {
            citations
                .iter()
                .filter_map(|citation| {
                    let mut citation_value = ace_json::Map::new();
                    citation_value.insert("threadId", citation.get("threadId")?.clone());
                    citation_value.insert("itemId", citation.get("itemId")?.clone());
                    Some(Value::Object(citation_value))
                })
                .collect()
        })
        .unwrap_or_default();
    let citations = Value::Array(cited.into());
    let text = format!(
        "{{\"type\":\"merged_fork_context\",\"sourceThreadId\":{},\"summary\":{},\"citations\":{}}}",
        ace_json::to_string(&Value::from(fork)),
        ace_json::to_string(summary),
        ace_json::to_string(&citations)
    );
    let previous = state.transition_get(store, source)?;
    let marker = format!(
        "\"sourceThreadId\":{}",
        ace_json::to_string(&Value::from(fork))
    );
    let already = previous
        .context
        .iter()
        .any(|entry| entry.contains("merged_fork_context") && entry.contains(marker.as_str()));
    let item_id = format!("merge:{intent_id}");
    let mut context = previous.context.clone();
    if !already {
        context.push(text.clone());
    }
    let mut metadata = metadata_json(&previous);
    metadata.insert(
        "context",
        Value::Array(context.into_iter().map(Value::from).collect()),
    );
    // Every constraint the commit would meet is checked first: the metadata's own bounds, the
    // grant's capacity, and the transaction that follows. A patch merge's Git effect lands
    // here, after these, and before the commit, when E5.5's worktree port brings it.
    let admitted = admit_metadata(&Value::Object(metadata.clone()))?;
    grant_fits(store.conn(), source, fork)?;
    let through = store.head_seq()? as i64;
    store.atomic(|_tx| {
        grant_handoff(store.conn(), source, fork, through)?;
        state.transition_set(store, source, &Value::Object(metadata_json(&admitted)))?;
        let mut merged = ace_json::Map::new();
        merged.insert("sourceThreadId", Value::from(fork));
        merged.insert("summary", summary.clone());
        merged.insert("citations", citations.clone());
        merged.insert("patchApplied", Value::Bool(patch_applied));
        let mut draft = ace_json::Map::new();
        draft.insert("type", Value::from("message"));
        draft.insert("role", Value::from("user"));
        draft.insert("synthetic", Value::Bool(true));
        draft.insert("mergedContext", Value::Object(merged));
        draft.insert("complete", Value::Bool(true));
        let mut part = ace_json::Map::new();
        part.insert("type", Value::from("text"));
        part.insert("text", Value::from(text.as_str()));
        draft.insert("parts", Value::Array(vec![Value::Object(part)].into()));
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from("root"));
        fact.insert("item", Value::from(item_id.as_str()));
        fact.insert("draft", Value::Object(draft));
        state.apply(
            store,
            source,
            &ace_json::to_string(&Value::Array(vec![Value::Object(fact)].into())),
            now,
            None,
        )?;
        if let Some(intent) = intent {
            // The intent's settlement and the guards it held go in this same transaction: a
            // crash can never leave the context written with the intent still queued.
            crate::intents::lifecycle::mark(store, intent, "done", None)?;
            state.transition_release_guards(store, &intent.command_id)?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn two_threads() -> (
        std::sync::Arc<ace_store::Connection>,
        EngineStore,
        std::rc::Rc<Shell>,
    ) {
        let conn = home("t", &header("t"));
        conn.exec(&format!(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, client) VALUES ('t2', 'workspace', 'Fork', 'claude', '{{\"state\":\"new\"}}', 0, 0, {})",
            crate::repository::testsupport::sql_text(r#"{"lineage":{"parentThreadId":"t","parentAgentId":"root","point":{"type":"turn","runId":"r"},"mode":"portable","lossy":true}}"#)
        ))
        .expect("fork thread");
        conn.exec(&format!(
            "INSERT INTO thread_state VALUES ('t2', {}, 0)",
            crate::repository::testsupport::sql_text(&header("t2"))
        ))
        .expect("fork state");
        conn.exec(&format!(
            "INSERT INTO items VALUES ('own', 't2', 1, {})",
            crate::repository::testsupport::sql_text(
                r#"{"id":"own","agentId":"root","type":"message","role":"assistant","complete":true,"createdAt":1,"parts":[{"type":"text","text":"done"}]}"#
            )
        ))
        .expect("own item");
        let (store, shell) = Shell::store_with_controls(&conn);
        (conn.clone(), store, shell)
    }

    /// The transcript events a merge wrote, as a client reads them: `(type, item)`.
    fn merged_events(shell: &Shell) -> Vec<(String, ace_json::Value)> {
        let mut items = Vec::new();
        for (_, payload, _) in shell.events() {
            let Ok(events) = ace_json::parse(&payload) else {
                continue;
            };
            for event in events.as_array().into_iter().flatten() {
                let kind = event
                    .get("type")
                    .and_then(ace_json::Value::as_str)
                    .unwrap_or_default();
                if matches!(kind, "item.created" | "item.updated")
                    && let Some(item) = event.get("item")
                    && item.get("mergedContext").is_some()
                {
                    items.push((kind.to_owned(), item.clone()));
                }
            }
        }
        items
    }

    // From `thread-merge-account.process.test.ts`: the merge cites the fork's own item, grants
    // its history, and leaves the merged context on the source.
    #[test]
    fn a_merge_grants_the_forks_history_and_writes_the_context() {
        let (conn, store, shell) = two_threads();
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let citations = ace_json::json!([{ "threadId": "t2", "itemId": "own", "excerpt": "done" }]);
        merge(
            &store,
            &mut state,
            "t",
            "t2",
            MergeRequest {
                summary: &Value::from("The fork finished the export"),
                citations: &citations,
                intent_id: 7,
                intent: None,
                patch_applied: false,
                now: 5.0,
            },
        )
        .expect("merge");
        let metadata = state.transition_get(&store, "t").expect("metadata");
        assert_eq!(metadata.context.len(), 1);
        assert!(metadata.context[0].contains("merged_fork_context"));
        // The synthetic input is in the transcript, not only in the metadata.
        let items = merged_events(&shell);
        assert_eq!(items.len(), 1, "one merged-context item");
        let item = &items[0].1;
        assert_eq!(
            item.get("mergedContext")
                .and_then(|merged| merged.get("sourceThreadId"))
                .and_then(ace_json::Value::as_str),
            Some("t2")
        );
        assert_eq!(
            item.get("synthetic").and_then(ace_json::Value::as_bool),
            Some(true)
        );
        assert!(
            item.get("parts")
                .and_then(ace_json::Value::as_array)
                .is_some_and(|parts| parts.iter().any(|part| part
                    .get("text")
                    .and_then(ace_json::Value::as_str)
                    .is_some_and(|text| text.contains("merged_fork_context"))))
        );
        let grant = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT source FROM engine_handoff_grants WHERE recipient='t'",
            Vec::new(),
        )
        .expect("grant")
        .expect("row");
        assert_eq!(
            grant
                .get("source")
                .and_then(crate::repository::residency::cell_text),
            Some("t2")
        );
    }

    // Re-running the same merge must not append a second context entry.
    #[test]
    fn retrying_the_same_merge_keeps_one_context_entry() {
        let (_conn, store, shell) = two_threads();
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let citations = ace_json::json!([{ "threadId": "t2", "itemId": "own", "excerpt": "done" }]);
        let summary = Value::from("summary");
        merge(
            &store,
            &mut state,
            "t",
            "t2",
            MergeRequest {
                summary: &summary,
                citations: &citations,
                intent_id: 9,
                intent: None,
                patch_applied: false,
                now: 5.0,
            },
        )
        .expect("first");
        merge(
            &store,
            &mut state,
            "t",
            "t2",
            MergeRequest {
                summary: &summary,
                citations: &citations,
                intent_id: 9,
                intent: None,
                patch_applied: false,
                now: 6.0,
            },
        )
        .expect("retry");
        let metadata = state.transition_get(&store, "t").expect("metadata");
        assert_eq!(metadata.context.len(), 1);
        let events = merged_events(&shell);
        let created = events
            .iter()
            .filter(|(kind, _)| kind == "item.created")
            .count();
        assert_eq!(created, 1, "the retry does not add a second item");
        let ids: Vec<&str> = events
            .iter()
            .filter_map(|(_, item)| item.get("id").and_then(ace_json::Value::as_str))
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        assert_eq!(ids.len(), 1, "both events name the same item");
    }

    // `transitions.ts:72`-`:119`: a ninth merge context fails at admission, before the grant
    // or any other write; the source keeps what it had.
    #[test]
    fn a_merge_past_the_context_limit_writes_nothing() {
        let (conn, store, _shell) = two_threads();
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let context: Vec<Value> = (0..8)
            .map(|index| Value::from(format!("carried-{index}").as_str()))
            .collect();
        let mut metadata = ace_json::Map::new();
        metadata.insert("context", Value::Array(context.into()));
        state
            .transition_set(&store, "t", &Value::Object(metadata))
            .expect("metadata");
        let citations = ace_json::json!([{ "threadId": "t2", "itemId": "own" }]);
        let error = merge(
            &store,
            &mut state,
            "t",
            "t2",
            MergeRequest {
                summary: &Value::from("one too many"),
                citations: &citations,
                intent_id: 11,
                intent: None,
                patch_applied: false,
                now: 5.0,
            },
        )
        .expect_err("the ninth context is refused");
        assert!(
            error.to_string().contains("context"),
            "the refusal names the context: {error}"
        );
        let grant = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT source FROM engine_handoff_grants WHERE recipient='t'",
            Vec::new(),
        )
        .expect("grant");
        assert!(grant.is_none(), "no grant was written");
    }

    // The fork must still be the source's own; a re-parented lineage refuses.
    #[test]
    fn a_merge_refuses_a_fork_whose_lineage_changed() {
        let (_conn, store, _shell) = two_threads();
        let mut state = State::default();
        let error = merge(
            &store,
            &mut state,
            "other",
            "t2",
            MergeRequest {
                summary: &Value::from("summary"),
                citations: &ace_json::json!([]),
                intent_id: 1,
                intent: None,
                patch_applied: false,
                now: 5.0,
            },
        )
        .expect_err("lineage");
        assert_eq!(error.to_string(), "Fork lineage changed");
    }
}
