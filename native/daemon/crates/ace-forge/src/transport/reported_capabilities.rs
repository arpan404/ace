// SPDX-License-Identifier: Apache-2.0
//! Declared capabilities on a detail (`reported-capabilities.ts`): the adapter's table is
//! the caller's, so a detail carries exactly the capabilities its forge declared.

use ace_json::{Map, Value};

/// `{ ...value, capabilities }`, with the capability list copied in its declared order.
pub fn with_forge_capabilities(value: &Map, capabilities: &[&str]) -> Map {
    let mut result = value.clone();
    result.insert(
        String::from("capabilities"),
        Value::Array(
            capabilities
                .iter()
                .map(|capability| Value::from(*capability))
                .collect(),
        ),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::with_forge_capabilities;
    use ace_json::{Map, Value, json};

    #[test]
    fn the_detail_carries_the_declared_capabilities_last() {
        let mut value = Map::new();
        value.insert(String::from("title"), Value::from("x"));
        let result = with_forge_capabilities(&value, &["review", "merge"]);
        assert_eq!(
            Value::Object(result),
            json!({ "title": "x", "capabilities": ["review", "merge"] })
        );
        assert_eq!(value.get("capabilities"), None, "the input is untouched");
    }
}
