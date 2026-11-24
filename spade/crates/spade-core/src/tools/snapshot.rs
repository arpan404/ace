//! A conversation's offered tools, frozen as one stored value (spade/docs/harness.md, Tools).
//!
//! The provider's cache holds from the top of the prompt, so the tool list a conversation is
//! offered never changes while it runs: it is worked out once, at the conversation's first model
//! call, and again only when a compaction republishes it (docs/design.md, Caching). What is
//! stored is the ordered, serialized definitions themselves, so a live tool source (ace's, an
//! app's, a plugin's) coming, going or changing its schema cannot change the bytes mid-conversation
//! or after a restart.
//!
//! One setting per conversation holds its current list; the engine replaces it in place, with
//! the conversation's compaction event when there is one, and deletes it with the conversation.

use serde_json::{Value, json};
use spade_models::ToolSpec;

/// The setting a conversation's snapshot is stored under.
pub fn key(conversation: &str) -> String {
    format!("tools.offer.{conversation}")
}

/// A conversation's offered tools and the generation they were published at.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    /// How many times the list has been republished for this conversation: 0 at its first model
    /// call, one more for each compaction that published a new one.
    pub generation: u64,
    /// The definitions, in the order the model is sent them.
    pub tools: Vec<ToolSpec>,
}

impl Snapshot {
    pub fn new(generation: u64, tools: Vec<ToolSpec>) -> Self {
        Self { generation, tools }
    }

    /// The stored form: fixed keys and the tools in order, so the same list is always the same
    /// bytes.
    pub fn to_json(&self) -> String {
        let tools: Vec<Value> = self
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "schema": tool.schema,
                })
            })
            .collect();
        json!({ "generation": self.generation, "tools": tools }).to_string()
    }

    /// Reads a stored snapshot, or `None` when it isn't one (an older or damaged value), so the
    /// caller works the list out again rather than failing a turn.
    pub fn parse(text: &str) -> Option<Self> {
        let value: Value = serde_json::from_str(text).ok()?;
        let generation = value.get("generation")?.as_u64()?;
        let tools = value.get("tools")?.as_array()?;
        let mut parsed = Vec::with_capacity(tools.len());
        for tool in tools {
            let schema = tool.get("schema")?.clone();
            if !schema.is_object() {
                return None;
            }
            parsed.push(ToolSpec {
                name: tool.get("name")?.as_str()?.to_owned(),
                description: tool.get("description")?.as_str()?.to_owned(),
                schema,
            });
        }
        Some(Self::new(generation, parsed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(name: &str, description: &str) -> ToolSpec {
        ToolSpec {
            name: name.to_owned(),
            description: description.to_owned(),
            schema: json!({ "type": "object", "properties": { "query": { "type": "string" } } }),
        }
    }

    #[test]
    fn a_stored_snapshot_reads_back_exactly_as_it_was_offered() {
        let snapshot = Snapshot::new(3, vec![tool("b", "Second"), tool("a", "First")]);
        let read = Snapshot::parse(&snapshot.to_json());
        assert_eq!(
            read,
            Some(snapshot),
            "the order is the offer's order, not sorted"
        );
    }

    #[test]
    fn the_same_list_is_always_the_same_bytes() {
        let one = Snapshot::new(0, vec![tool("a", "First"), tool("b", "Second")]);
        let other = Snapshot::new(0, vec![tool("a", "First"), tool("b", "Second")]);
        assert_eq!(one.to_json(), other.to_json());
    }

    #[test]
    fn a_damaged_or_older_value_is_not_a_snapshot() {
        assert_eq!(Snapshot::parse(""), None);
        assert_eq!(Snapshot::parse("{}"), None);
        assert_eq!(Snapshot::parse(r#"{"generation":1,"tools":{}}"#), None);
        assert_eq!(
            Snapshot::parse(
                r#"{"generation":1,"tools":[{"name":"a","description":"","schema":3}]}"#
            ),
            None
        );
        assert_eq!(
            Snapshot::parse(r#"{"generation":1,"tools":[{"name":"a"}]}"#),
            None
        );
    }
}
