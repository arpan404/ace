// SPDX-License-Identifier: Apache-2.0
//! The model object (`input.ts:8`-`:22`) and the prompt message id (`:4`).

use super::{ModelError, message_id, selected_model};
use ace_json::{Value, json};

#[test]
fn a_model_is_split_at_its_first_slash_and_keeps_the_rest() {
    assert_eq!(
        selected_model(Some("anthropic/claude-sonnet"), None),
        Ok(Some(
            json!({ "providerID": "anthropic", "id": "claude-sonnet" })
        ))
    );
    // An id may hold more slashes: only the first one splits.
    assert_eq!(
        selected_model(Some("openrouter/meta/llama-3"), None),
        Ok(Some(
            json!({ "providerID": "openrouter", "id": "meta/llama-3" })
        ))
    );
    // No model at all is the default one.
    assert_eq!(selected_model(None, Some(&json!("high"))), Ok(None));
}

#[test]
fn a_model_without_a_provider_or_an_id_is_refused() {
    for model in ["", "anthropic", "/claude", "anthropic/"] {
        assert_eq!(
            selected_model(Some(model), None),
            Err(ModelError::Shape),
            "{model}"
        );
    }
}

#[test]
fn the_effort_is_the_variant_only_when_it_is_a_string() {
    assert_eq!(
        selected_model(Some("p/m"), Some(&json!("high"))),
        Ok(Some(
            json!({ "providerID": "p", "id": "m", "variant": "high" })
        ))
    );
    for effort in [json!(null), json!(3), json!(true), json!({ "id": "high" })] {
        assert_eq!(
            selected_model(Some("p/m"), Some(&effort)),
            Ok(Some(json!({ "providerID": "p", "id": "m" }))),
            "{effort}"
        );
    }
    // The keys are the schema's order, so the body is byte-stable.
    assert_eq!(
        ace_json::to_string(
            &selected_model(Some("p/m"), Some(&json!("low")))
                .expect("a model")
                .expect("a value")
        ),
        r#"{"providerID":"p","id":"m","variant":"low"}"#
    );
}

#[test]
fn a_message_id_is_twelve_hex_digits_of_the_shifted_clock() {
    assert_eq!(message_id(0, 0, "abcd"), "msg_000000000000abcd");
    assert_eq!(message_id(1, 1, ""), "msg_000000001001");
    // The sequence wraps at 4096, as `sequence % 4096` does.
    assert_eq!(message_id(0, 4096, ""), "msg_000000000000");
    assert_eq!(message_id(0, 4097, ""), "msg_000000000001");
    // Only the low 48 bits survive the mask.
    assert_eq!(message_id(u64::MAX, 0, ""), "msg_fffffffff000");
    let _: Value = json!(message_id(1_760_000_000_000, 7, "0f"));
}
