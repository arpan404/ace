// SPDX-License-Identifier: Apache-2.0
//! The streaming cases of the same files: chunk boundaries keep secrets whole.

use super::*;

#[test]
fn streaming_masks_a_credential_value_when_its_key_crosses_a_chunk_boundary() {
    let redactor = Redactor::new(&Context::default());
    let input = format!(
        "{}{{\"password\":\"OPAQUE_JSON_CREDENTIAL\"}} after",
        "A".repeat(4_084)
    );
    let safe = streamed(&redactor, &input);
    assert!(!safe.contains("OPAQUE_JSON_CREDENTIAL"), "{safe}");
    assert!(safe.contains(r#""password":"<SECRET>""#), "{safe}");
    assert!(safe.contains("after"), "{safe}");
}

// sdk-counters.test.ts

#[test]
fn escaped_configured_secrets_crossing_a_stream_boundary_remain_private() {
    let value = "left{ \"value\": \"OPAQUE_ENV_CREDENTIAL\" }right";
    let redactor = Redactor::new(&context(&[("CUSTOM", value)]));
    let prefix = "A".repeat(4_090);
    let escaped = ace_json::to_string(&ace_json::Value::from(value))
        .trim_matches('"')
        .to_owned();
    assert_eq!(
        streamed(&redactor, &format!("{prefix}{escaped} after")),
        format!("{prefix}<ENV> after")
    );
}

// credential-overlap.test.ts

#[test]
fn streaming_preserves_the_credential_mask_after_a_prose_quote_at_a_chunk_boundary() {
    let redactor = Redactor::new(&Context::default());
    let prefix = format!("{} \" ", "A".repeat(4_080));
    assert_eq!(
        streamed(
            &redactor,
            &format!("{prefix}{{\"token\":\"OPAQUE_CREDENTIAL\"}} after")
        ),
        format!("{prefix}{{\"token\":\"<SECRET>\"}} after")
    );
}
