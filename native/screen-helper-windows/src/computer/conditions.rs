//! `when` guards and `wait_for` targets: an element containing some text, or an id, present
//! or gone. Pure.
use super::error::{clip, CuError, CuResult};
use super::outline::Node;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Condition {
    pub text: Option<String>,
    pub id: Option<u64>,
    pub gone: bool,
}

/// Reads a condition object; None when there is none.
pub fn condition(value: Option<&Value>) -> CuResult<Option<Condition>> {
    let object = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(CuError::new(
                "bad_action",
                "when must be an object such as {\"text\": \"Saved\"} or {\"id\": 12, \"gone\": true}.",
            ));
        }
    };
    let text = object
        .get("text")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let id = object.get("id").and_then(Value::as_u64);
    if text.is_none() && id.is_none() {
        return Err(CuError::new("bad_action", "A condition needs text or id."));
    }
    let gone = object.get("gone").and_then(Value::as_bool).unwrap_or(false);
    Ok(Some(Condition { text, id, gone }))
}

/// Whether it holds over a fresh walk. With both id and text, that element must hold the text.
pub fn holds(condition: &Condition, nodes: &[Node]) -> bool {
    let needle = condition.text.as_ref().map(|t| t.to_lowercase());
    let present = nodes.iter().any(|node| {
        condition.id.is_none_or(|id| node.id == id)
            && needle
                .as_ref()
                .is_none_or(|needle| node.search_line().contains(needle.as_str()))
    });
    present != condition.gone
}

pub fn phrase(condition: &Condition) -> String {
    let mut subject = condition
        .id
        .map(|id| format!("element {id}"))
        .unwrap_or_else(|| "an element".into());
    if let Some(text) = &condition.text {
        subject += &format!(" containing \"{}\"", clip(text, 60).unwrap_or_default());
    }
    if condition.gone {
        format!("{subject} to go away")
    } else {
        subject
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(id: u64, name: &str) -> Node {
        Node {
            id,
            depth: 0,
            role: "button".into(),
            flags: vec![],
            name: Some(name.into()),
            value: None,
            detail: None,
            placeholder: None,
            actions: vec![],
            frame: None,
            actionable: true,
        }
    }

    #[test]
    fn text_conditions_match_any_line_case_insensitively() {
        let nodes = [node(1, "Save"), node(2, "Cancel")];
        let saved = condition(Some(&json!({"text": "save"}))).unwrap().unwrap();
        assert!(holds(&saved, &nodes));
        let gone = condition(Some(&json!({"text": "save", "gone": true})))
            .unwrap()
            .unwrap();
        assert!(!holds(&gone, &nodes));
    }

    #[test]
    fn id_and_text_together_need_that_element_to_hold_the_text() {
        let nodes = [node(1, "Save"), node(2, "Cancel")];
        let wrong = condition(Some(&json!({"id": 2, "text": "save"})))
            .unwrap()
            .unwrap();
        assert!(!holds(&wrong, &nodes));
        assert!(holds(
            &condition(Some(&json!({"id": 1}))).unwrap().unwrap(),
            &nodes
        ));
        assert_eq!(phrase(&wrong), "element 2 containing \"save\"");
    }

    #[test]
    fn malformed_conditions_are_rejected_with_a_fix() {
        assert!(condition(None).unwrap().is_none());
        assert_eq!(condition(Some(&json!("x"))).unwrap_err().code, "bad_action");
        assert_eq!(
            condition(Some(&json!({"gone": true}))).unwrap_err().message,
            "A condition needs text or id."
        );
    }
}
