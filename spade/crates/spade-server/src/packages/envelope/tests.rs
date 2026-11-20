//! A package's identity only from the market's signature over its exact bytes. `signed.json` was
//! signed by `packages/marketplace/src/signing.ts` with a test key, so Spade's check is held to
//! the signer's own canonical JSON and content hash.

use serde_json::{Value, json};

use super::*;

fn fixture() -> (Vec<MarketKey>, Envelope) {
    let all: Value = serde_json::from_str(include_str!("signed.json")).unwrap_or_default();
    let keys = serde_json::from_value(all["keys"].clone()).unwrap_or_default();
    let envelope = Envelope {
        signed: all["signed"].clone(),
        bot_json: all["bot_json"].as_str().unwrap_or_default().to_owned(),
        files: std::collections::BTreeMap::new(),
    };
    (keys, envelope)
}

#[test]
fn the_markets_signature_gives_the_package_its_name_version_and_hash() {
    let (keys, envelope) = fixture();
    let (package, recipe) = verify(&envelope, &keys).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(package.source, MARKET);
    assert_eq!(package.name, "flight-watcher");
    assert_eq!(package.version, "1.0.0");
    assert_eq!(
        package.hash,
        envelope.signed["body"]["hash"].as_str().unwrap_or_default()
    );
    assert_eq!(recipe["name"], "Flight watcher");
}

#[test]
fn bytes_names_or_keys_the_market_didnt_sign_are_refused() {
    let (keys, envelope) = fixture();
    // Another bot.json under the same signature: one byte more.
    let other = Envelope {
        bot_json: format!("{} ", envelope.bot_json),
        ..envelope.clone()
    };
    assert!(verify(&other, &keys).is_err());
    let changed = Envelope {
        bot_json: envelope.bot_json.replace("Reads fares.", "Reads mail."),
        ..envelope.clone()
    };
    assert_eq!(
        verify(&changed, &keys).err().as_deref(),
        Some("bot.json isn't the one the market signed")
    );
    // A body changed after signing: another version, another publisher.
    for (field, value) in [("version", json!("9.9.9")), ("name", json!("mail-reader"))] {
        let mut signed = envelope.signed.clone();
        signed["body"][field] = value;
        let forged = Envelope {
            signed,
            ..envelope.clone()
        };
        assert_eq!(
            verify(&forged, &keys).err().as_deref(),
            Some("the signature doesn't match"),
            "{field}"
        );
    }
    // A key this build doesn't trust, and no key at all.
    assert!(verify(&envelope, &shipped()).is_err());
    assert!(verify(&envelope, &[]).is_err());
    // Not a signed manifest at all.
    let bare = Envelope {
        signed: json!({ "name": "flight-watcher", "version": "1.0.0" }),
        ..envelope
    };
    assert!(verify(&bare, &keys).is_err());
}

#[test]
fn a_package_without_a_signature_is_local_and_claims_no_market_identity() {
    let recipe = json!({ "name": "Flight watcher", "version": 3 });
    let local = local(&recipe, "Flight watcher!");
    assert!(is_local(&local));
    assert_eq!(local.name, "local/flight-watcher");
    assert_eq!(local.version, LOCAL);
    // The same manifest is the same local package; another one isn't.
    assert_eq!(local.hash, super::local(&recipe, "x").hash);
    assert_ne!(
        local.hash,
        super::local(&json!({ "name": "Other" }), "x").hash
    );
}
