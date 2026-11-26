// SPDX-License-Identifier: Apache-2.0
//! The catalog's re-read cases (`metadata.ts`): only a well-formed empty catalog
//! is read again, and only inside both bounds.

use super::{BUDGET_MS, POLL_MS, READS, again, empty};
use ace_json::json;

#[test]
fn only_a_well_formed_empty_catalog_is_empty() {
    assert!(empty(&json!({ "data": [] })));
    assert!(!empty(&json!({ "data": [{ "id": "m" }] })));
    // Malformed is not empty: no `data` at all, or not a catalog object.
    assert!(!empty(&json!({})));
    assert!(!empty(&json!({ "data": null })));
    assert!(!empty(&json!([])));
    assert!(!empty(&json!("data")));
}

#[test]
fn an_empty_catalog_is_read_again_every_fifty_milliseconds() {
    let empty_reply = json!({ "data": [] });
    assert_eq!(again(1, 0.0, &empty_reply), Some(POLL_MS));
    assert_eq!(again(39, 4_999.0, &empty_reply), Some(POLL_MS));
}

#[test]
fn the_third_bound_stops_the_reads() {
    let empty_reply = json!({ "data": [] });
    // The fortieth read is the last: the sequence is 1-based in the TypeScript,
    // which stops after a read numbered 40.
    assert_eq!(again(READS - 1, 0.0, &empty_reply), Some(POLL_MS));
    assert_eq!(again(READS, 0.0, &empty_reply), None);
    // Five seconds is the budget's end, measured from before the first read.
    assert_eq!(again(1, BUDGET_MS - 1.0, &empty_reply), Some(POLL_MS));
    assert_eq!(again(1, BUDGET_MS, &empty_reply), None);
}

#[test]
fn a_catalog_with_models_is_answered_at_once() {
    let models = json!({ "data": [{ "id": "m" }] });
    assert_eq!(again(1, 0.0, &models), None);
    assert_eq!(
        again(1, 0.0, &json!({})),
        None,
        "malformed is returned as it came"
    );
}
