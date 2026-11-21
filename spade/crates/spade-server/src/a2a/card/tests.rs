use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};

use super::*;

/// A card signed by ace's daemon (`signCard` in `external-mcp/card-signature.ts`), with the JWK
/// set of its key: what another A2A runtime's signer produces, unicode and floats included.
fn daemon_signed() -> (Value, Value) {
    let fixture: Value = serde_json::from_str(include_str!("daemon-signed.json"))
        .unwrap_or_else(|e| panic!("fixture: {e}"));
    (fixture["card"].clone(), fixture["keys"].clone())
}

#[test]
fn a_card_signed_over_its_canonical_form_verifies_with_its_publishers_key() {
    let (card, keys) = daemon_signed();
    assert!(matches!(
        verify(&card, &[Ok(keys.clone())]),
        Signed::Verified { .. }
    ));
    assert_eq!(
        key_set_addresses(&card),
        vec![Some("https://agents.example.com/jwks.json".to_owned())]
    );
    assert_eq!(
        verify(&card, &[Ok(keys.clone())]).words(),
        "Signed by its publisher's key"
    );
}

#[test]
fn a_card_changed_after_signing_or_unsigned_reads_not_signed() {
    let (card, keys) = daemon_signed();
    let mut tampered = card.clone();
    tampered["skills"][0]["description"] = json!("Books a trip and pays for it");
    let read = verify(&tampered, &[Ok(keys.clone())]);
    assert!(
        matches!(&read, Signed::No(why) if why.contains("changed after it was signed")),
        "{read:?}"
    );
    assert_eq!(read.words(), "Not signed");

    let mut unsigned = card.clone();
    unsigned.as_object_mut().map(|c| c.remove("signatures"));
    assert!(matches!(
        verify(&unsigned, &[Ok(keys.clone())]),
        Signed::No(_)
    ));

    // Another key than the one its header names.
    let mut other = keys.clone();
    other["keys"][0]["kid"] = json!("someone-else");
    assert!(matches!(verify(&card, &[Ok(other)]), Signed::No(why) if why.contains("no key")));
}

#[test]
fn the_canonical_form_sorts_keys_by_utf16_and_writes_numbers_as_ecmascript() {
    let cases = [
        (
            json!({ "b": 1, "a": [true, null] }),
            r#"{"a":[true,null],"b":1}"#,
        ),
        // U+1F600 (a surrogate pair, D83D DE00) sorts before U+E000 in UTF-16, after it in UTF-8.
        (
            json!({ "\u{E000}": 2, "\u{1F600}": 1 }),
            "{\"\u{1F600}\":1,\"\u{E000}\":2}",
        ),
        (
            json!([1e21, 1e-7, 0.5, 1.0e20, 0.000001, -0.0]),
            "[1e+21,1e-7,0.5,100000000000000000000,0.000001,0]",
        ),
        (
            json!({ "s": "line\nquote\"é" }),
            r#"{"s":"line\nquote\"é"}"#,
        ),
    ];
    for (value, want) in cases {
        assert_eq!(canonical(&value), want, "{value}");
    }
}

fn card(extra: Value) -> Value {
    let mut card = json!({
        "name": "Travel desk",
        "supportedInterfaces": [
            { "url": "https://agents.example.com/grpc", "protocolBinding": "GRPC", "protocolVersion": "1.0" },
            { "url": "https://agents.example.com/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0" },
        ],
        "defaultInputModes": ["text/plain"],
        "defaultOutputModes": ["text/plain"],
        "skills": [
            { "id": "book", "name": "Book", "description": "Books a trip",
              "inputModes": ["application/json"], "outputModes": ["application/json"] },
            { "id": "chat", "name": "Chat", "description": "Talks" },
            { "id": "bad id!", "name": "Bad" },
        ],
    });
    if let (Some(card), Value::Object(extra)) = (card.as_object_mut(), extra) {
        card.extend(extra);
    }
    card
}

#[test]
fn a_card_offers_its_json_rpc_interface_and_skills_with_their_modes() {
    let read = read(&card(json!({}))).unwrap_or_else(|why| panic!("{why}"));
    assert_eq!(read.endpoint, "https://agents.example.com/a2a");
    let skills: Vec<(&str, bool)> = read
        .skills
        .iter()
        .map(|s| (s.id.as_str(), s.json))
        .collect();
    assert_eq!(skills, vec![("book", true), ("chat", false)]);
}

#[test]
fn a_card_spade_cant_call_is_refused_with_why() {
    let cases = [
        (
            json!({ "supportedInterfaces": [] }),
            "no JSON-RPC interface",
        ),
        (
            json!({ "securityRequirements": [{ "schemes": { "oauth": [] } }] }),
            "sign-in Spade can't do for agents yet: oauth",
        ),
        (json!({ "skills": [] }), "no skill"),
        (json!({ "name": "" }), "no name"),
    ];
    for (extra, want) in cases {
        let refused = read(&card(extra.clone())).err().unwrap_or_default();
        assert!(refused.contains(want), "{extra}: {refused}");
    }
}

#[test]
fn each_signature_is_checked_only_against_its_own_key_set() {
    let (card, keys) = daemon_signed();
    let real = card["signatures"][0].clone();
    let other = json!({
        "protected": URL_SAFE_NO_PAD.encode(r#"{"alg":"ES256","kid":"other","jku":"https://agents.example.com/other.json"}"#),
        "signature": "AA",
    });
    let mut two = card.clone();
    two["signatures"] = json!([other, real]);
    // The real signature's own keys couldn't be had: the first one's keys, which hold its key,
    // don't vouch for it.
    let elsewhere = Err("its signature names keys on another address than its card's".to_owned());
    let read = verify(&two, &[Ok(keys.clone()), elsewhere]);
    assert!(
        matches!(&read, Signed::No(why) if why.contains("another address")),
        "{read:?}"
    );
    assert!(matches!(
        verify(&two, &[Err("unread".to_owned()), Ok(keys)]),
        Signed::Verified { .. }
    ));
}
