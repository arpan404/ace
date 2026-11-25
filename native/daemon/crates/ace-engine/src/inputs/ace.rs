// SPDX-License-Identifier: Apache-2.0
//! Ace-input attribution (`ace-input-attribution.ts`, `ace-inputs.ts:27`-`:41`, E5.4b): retain
//! delegation summaries; the input journal is the sole source of message origin.
//!
//! Native content cannot establish origin; only the host's persisted command can. An echo of a
//! settled delegation becomes that delegation's item, once.

use ace_json::Value;
use ace_store::stmt_cache;
use std::sync::Arc;

use crate::EngineError;
use crate::repository::residency::{cell_text, text};

pub const SELECT_VALUE: &str =
    "SELECT value FROM engine_ace_inputs WHERE thread_id=? AND command_id=?";

/// The most outcomes one record keeps (`AceInput.results`).
pub const MAX_RESULTS: usize = 64;

/// One recorded delegation summary.
#[derive(Debug, Clone, PartialEq)]
pub struct AceInput {
    pub agent: String,
    pub item: String,
    pub results: Value,
}

/// `AceInputs.get`: the record for a command, when this home wrote one it can read.
pub fn get(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    command: &str,
) -> Result<Option<AceInput>, EngineError> {
    let row = stmt_cache::get_row(conn, SELECT_VALUE, vec![text(thread), text(command)])?;
    let Some(value) = row.as_ref().and_then(|row| row_text(row, "value")) else {
        return Ok(None);
    };
    let parsed =
        ace_json::parse(&value).map_err(|error| EngineError::Records(error.to_string()))?;
    match decode(&parsed) {
        Some(input) => Ok(Some(input)),
        None => Err(EngineError::Records("Invalid ace input".to_owned())),
    }
}

fn row_text(row: &stmt_cache::Row, column: &str) -> Option<String> {
    row.get(column).and_then(cell_text).map(str::to_owned)
}

/// JavaScript truthiness: null, false, zero, NaN and the empty string are falsy; arrays and
/// objects (empty ones included) are not.
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn decode(value: &Value) -> Option<AceInput> {
    let results = value.get("results")?;
    let results = results.as_array()?;
    if results.len() > MAX_RESULTS {
        return None;
    }
    Some(AceInput {
        agent: value.get("agent")?.as_str()?.to_owned(),
        item: value.get("item")?.as_str()?.to_owned(),
        results: Value::Array(results.to_vec().into()),
    })
}

/// `settledInputEcho`: fold a user-role echo into its ace item.
pub fn settled_input_echo(source: Option<&AceInput>, fact: Value) -> Value {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    let draft = fact.get("draft");
    let Some(source) = source else {
        return fact;
    };
    if (kind != "item.upsert" && kind != "item.reconciled")
        || draft
            .and_then(|draft| draft.get("type"))
            .and_then(Value::as_str)
            != Some("message")
        || draft
            .and_then(|draft| draft.get("role"))
            .and_then(Value::as_str)
            != Some("user")
        || fact.get("agent").and_then(Value::as_str) != Some(source.agent.as_str())
    {
        return fact;
    }
    let mut settled = ace_json::Map::new();
    settled.insert("type", Value::from("delegation.settled"));
    settled.insert("complete", Value::Bool(true));
    settled.insert("results", source.results.clone());
    settled.insert("delivery", Value::from("ace-input"));
    settled.insert("origin", Value::from("ace"));
    // `...(fact.draft.raw ? { raw } : {})`: JavaScript's truthiness, not presence.
    if let Some(raw) = draft
        .and_then(|draft| draft.get("raw"))
        .filter(|raw| js_truthy(raw))
    {
        settled.insert("raw", raw.clone());
    }
    let mut fact_draft = ace_json::Map::new();
    fact_draft.insert("type", Value::from("item.upsert"));
    fact_draft.insert("agent", Value::from(source.agent.as_str()));
    fact_draft.insert("item", Value::from(source.item.as_str()));
    fact_draft.insert("draft", Value::Object(settled));
    Value::Object(fact_draft)
}

/// `AceInputs.attribute`: an echo of a settled delegation becomes its item, on the same agent.
pub fn attribute(
    conn: &Arc<ace_store::Connection>,
    thread: &str,
    fact: Value,
) -> Result<Value, EngineError> {
    let kind = fact.get("type").and_then(Value::as_str).unwrap_or_default();
    let draft = fact.get("draft");
    if (kind != "item.upsert" && kind != "item.reconciled")
        || draft
            .and_then(|draft| draft.get("type"))
            .and_then(Value::as_str)
            != Some("message")
        || draft
            .and_then(|draft| draft.get("role"))
            .and_then(Value::as_str)
            != Some("user")
    {
        return Ok(fact);
    }
    let origin = draft.and_then(|draft| draft.get("origin"));
    let command = match origin
        .and_then(|origin| origin.get("kind"))
        .and_then(Value::as_str)
    {
        Some("subagent_result") => origin
            .and_then(|origin| origin.get("commandId"))
            .and_then(Value::as_str),
        _ => None,
    };
    let Some(command) = command else {
        return Ok(fact);
    };
    let source = get(conn, thread, command)?;
    Ok(settled_input_echo(source.as_ref(), fact))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn an_echo_of_a_settled_delegation_becomes_that_agents_item_once() {
        let source = AceInput {
            agent: "a1".into(),
            item: "delegation:1".into(),
            results: value(r#"[{"outcome":"completed"}]"#),
        };
        let echo = value(
            r#"{"type":"item.reconciled","agent":"a1","item":"native-1","draft":{"type":"message","role":"user","raw":[{"type":"x"}]}}"#,
        );
        assert_eq!(
            ace_json::to_string(&settled_input_echo(Some(&source), echo)),
            r#"{"type":"item.upsert","agent":"a1","item":"delegation:1","draft":{"type":"delegation.settled","complete":true,"results":[{"outcome":"completed"}],"delivery":"ace-input","origin":"ace","raw":[{"type":"x"}]}}"#
        );
        // An echo on another agent, or with no record, passes unchanged.
        let elsewhere = value(
            r#"{"type":"item.upsert","agent":"a2","item":"i","draft":{"type":"message","role":"user"}}"#,
        );
        assert_eq!(
            ace_json::to_string(&settled_input_echo(Some(&source), elsewhere.clone())),
            ace_json::to_string(&elsewhere)
        );
        let untouched = settled_input_echo(None, elsewhere.clone());
        assert_eq!(
            ace_json::to_string(&untouched),
            ace_json::to_string(&elsewhere)
        );
    }

    #[test]
    fn the_echo_keeps_its_raw_only_when_javascript_reads_it_as_present() {
        let source = AceInput {
            agent: "a1".into(),
            item: "delegation:1".into(),
            results: value("[]"),
        };
        for (raw, kept) in [
            ("[]", true),
            ("[{\"type\":\"x\"}]", true),
            ("null", false),
            ("false", false),
            ("0", false),
            ("\"\"", false),
        ] {
            let echo = value(&format!(
                r#"{{"type":"item.upsert","agent":"a1","item":"native","draft":{{"type":"message","role":"user","raw":{raw}}}}}"#
            ));
            let settled = settled_input_echo(Some(&source), echo);
            let has = settled
                .get("draft")
                .and_then(|draft| draft.get("raw"))
                .is_some();
            assert_eq!(has, kept, "raw {raw}");
        }
    }

    #[test]
    fn a_record_keeps_at_most_sixty_four_outcomes() {
        let results = format!("[{}]", vec!["{}"; MAX_RESULTS + 1].join(","));
        let record = format!(r#"{{"agent":"a","item":"i","results":{results}}}"#);
        assert!(decode(&value(&record)).is_none());
        let exact = format!("[{}]", vec!["{}"; MAX_RESULTS].join(","));
        let record = format!(r#"{{"agent":"a","item":"i","results":{exact}}}"#);
        assert!(decode(&value(&record)).is_some());
    }
}
