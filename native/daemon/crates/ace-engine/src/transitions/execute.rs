// SPDX-License-Identifier: Apache-2.0
//! `ThreadTransitions.execute` (E5.9), the merge half: citing a fork's work back into the
//! thread it came from writes one merged-context input, grants the fork's conversation and
//! marks the thread's handoff history. A switch or fork execution needs the sessions and models
//! ports; the merge needs neither, and lands here complete.
//!
//! Cases ported from `thread-merge-account.process.test.ts` and `transition-regressions` (the
//! lineage and citation refusals).

use ace_json::Value;

use crate::transitions::history;
use crate::transitions::metadata::metadata_json;
use crate::{EngineError, EngineStore, State};

/// `execute_merge` (`transitions.ts:72`-`:119`): the fork's summary and citations become one
/// input on `source`, and the source may page the fork's history from here.
pub struct MergeRequest<'a> {
    pub summary: &'a Value,
    pub citations: &'a Value,
    pub intent_id: i64,
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
    let text = format!(
        "{{\"type\":\"merged_fork_context\",\"sourceThreadId\":{},\"summary\":{},\"citations\":{}}}",
        ace_json::to_string(&Value::from(fork)),
        ace_json::to_string(summary),
        ace_json::to_string(citations)
    );
    let previous = state.transition_get(store, source)?;
    state.handoff_grant(store, source, fork, store.head_seq()? as i64)?;
    let mut context = previous.context.clone();
    context.push(text.clone());
    let mut metadata = metadata_json(&previous);
    metadata.insert(
        "context",
        Value::Array(context.into_iter().map(Value::from).collect()),
    );
    store.atomic(|_tx| {
        state.transition_set(store, source, &Value::Object(metadata))?;
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
        fact.insert("item", Value::from(format!("merge:{intent_id}").as_str()));
        fact.insert("draft", Value::Object(draft));
        state.apply(
            store,
            source,
            &ace_json::to_string(&Value::Array(vec![Value::Object(fact)].into())),
            now,
            None,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn two_threads() -> (std::sync::Arc<ace_store::Connection>, EngineStore) {
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
        (conn.clone(), Shell::store(&conn))
    }

    // From `thread-merge-account.process.test.ts`: the merge cites the fork's own item, grants
    // its history, and leaves the merged context on the source.
    #[test]
    fn a_merge_grants_the_forks_history_and_writes_the_context() {
        let (conn, store) = two_threads();
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
                patch_applied: false,
                now: 5.0,
            },
        )
        .expect("merge");
        let metadata = state.transition_get(&store, "t").expect("metadata");
        assert_eq!(metadata.context.len(), 1);
        assert!(metadata.context[0].contains("merged_fork_context"));
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

    // The fork must still be the source's own; a re-parented lineage refuses.
    #[test]
    fn a_merge_refuses_a_fork_whose_lineage_changed() {
        let (_conn, store) = two_threads();
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
                patch_applied: false,
                now: 5.0,
            },
        )
        .expect_err("lineage");
        assert_eq!(error.to_string(), "Fork lineage changed");
    }
}
