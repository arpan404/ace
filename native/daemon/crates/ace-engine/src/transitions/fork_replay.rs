// SPDX-License-Identifier: Apache-2.0
//! `fork-replay.ts` (E5.9): a native fork whose provider carries the source's turns into the
//! fork. Cases ported from `fork-transcript.process.test.ts` and `thread-fork.process.test.ts`.

use ace_json::Value;

use crate::transitions::metadata::TransitionMetadata;

/// `forkReplaySource` (`fork-replay.ts:12`): the thread whose turns the opening fork brings
/// along, when it is a native fork; `None` for any other open, such as an account move.
pub fn fork_replay_source<'a>(
    metadata: &TransitionMetadata,
    lineage_parent: Option<&'a str>,
) -> Option<&'a str> {
    let inherited = metadata
        .fork
        .as_ref()
        .and_then(|fork| fork.get("inherited"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    inherited.then_some(lineage_parent).flatten()
}

/// The kinds a provider's fork can bring along (`fork-replay.ts:23`).
const REPLAYED: [&str; 4] = ["message", "tool_call", "reasoning", "compaction"];

/// `inheritedReplay` (`:29`): an item the opening fork's provider translated from the source is
/// marked as the source's, like ace's own copies. Only new items: one that already exists keeps
/// what it was.
pub fn inherited_replay(fact: &Value, source: &str, has_item: impl Fn(&str) -> bool) -> Value {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    if kind != "item.upsert" && kind != "item.reconciled" {
        return fact.clone();
    }
    let Some(draft) = fact.get("draft").and_then(Value::as_object) else {
        return fact.clone();
    };
    let draft_kind = draft
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !REPLAYED.contains(&draft_kind) || draft.contains_key("inherited") {
        return fact.clone();
    }
    let item = fact.get("item").and_then(Value::as_str).unwrap_or_default();
    if has_item(item) {
        return fact.clone();
    }
    let mut replayed = fact.clone();
    if let Some(draft) = replayed.get_mut("draft").and_then(Value::as_object_mut) {
        let mut inherited = ace_json::Map::new();
        inherited.insert("threadId", Value::from(source));
        draft.insert("inherited", Value::Object(inherited));
    }
    replayed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(fork: Option<&str>) -> TransitionMetadata {
        TransitionMetadata {
            fork: fork.map(|text| ace_json::parse(text).expect("fork")),
            ..TransitionMetadata::default()
        }
    }

    // From `fork-transcript.process.test.ts`: only a native fork that marks its turns inherited
    // names the source thread.
    #[test]
    fn only_an_inherited_native_fork_names_its_source_to_replay() {
        assert_eq!(
            fork_replay_source(
                &metadata(Some(r#"{"nativeSessionId":"s","inherited":true}"#)),
                Some("parent")
            ),
            Some("parent")
        );
        assert_eq!(
            fork_replay_source(
                &metadata(Some(r#"{"nativeSessionId":"s","inherited":false}"#)),
                Some("parent")
            ),
            None
        );
        assert_eq!(fork_replay_source(&metadata(None), Some("parent")), None);
        assert_eq!(fork_replay_source(&metadata(Some("{}")), None), None);
    }

    // From `fork-transcript.process.test.ts`: the source's messages, steps and reasoning are
    // marked inherited; its notices, an existing item and an already-marked one are not.
    #[test]
    fn a_replayed_item_from_the_source_is_marked_inherited_only_when_new() {
        let message = ace_json::json!({
            "type": "item.upsert", "agent": "root", "item": "i1",
            "draft": { "type": "message", "role": "user", "parts": [] }
        });
        let marked = inherited_replay(&message, "parent", |_| false);
        assert_eq!(
            marked.get("draft").and_then(|draft| draft.get("inherited")),
            Some(&ace_json::json!({ "threadId": "parent" }))
        );
        // An item the fork already has keeps what it was.
        assert_eq!(
            inherited_replay(&message, "parent", |id| id == "i1"),
            message
        );
        // A kind the provider does not replay (a notice) passes unchanged.
        let notice = ace_json::json!({
            "type": "item.upsert", "agent": "root", "item": "i2",
            "draft": { "type": "notice", "text": "hi" }
        });
        assert_eq!(inherited_replay(&notice, "parent", |_| false), notice);
        // A fact that is not an item passes unchanged.
        let run = ace_json::json!({ "type": "run.started", "agent": "root" });
        assert_eq!(inherited_replay(&run, "parent", |_| false), run);
        // An item already marked inherited is not re-marked.
        let once = inherited_replay(&message, "parent", |_| false);
        assert_eq!(inherited_replay(&once, "parent", |_| false), once);
    }
}
