//! A test market: its key, which a test's Spade trusts in place of the shipped ones, and version
//! manifests signed with it the way the market's signer signs them (ADR 0168 §6).

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use spade_server::engine::Engine;
use spade_server::packages::envelope::MarketKey;

const SEED: [u8; 32] = [9; 32];
const KEY: &str = "test-1";

fn pair() -> ring::signature::Ed25519KeyPair {
    ring::signature::Ed25519KeyPair::from_seed_unchecked(&SEED)
        .unwrap_or_else(|e| panic!("a test key: {e}"))
}

/// Has `engine` trust the test market's key, and no other.
pub fn trust(engine: &Engine) {
    use ring::signature::KeyPair as _;
    engine.trust_market_keys(vec![MarketKey {
        id: KEY.to_owned(),
        public_key: URL_SAFE_NO_PAD.encode(pair().public_key().as_ref()),
    }]);
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The envelope for the spade-bot `name` at `version` whose `bot.json` is `recipe`: the market's
/// signed version manifest and the exact bytes it lists.
pub fn envelope(name: &str, version: &str, recipe: &Value) -> Value {
    let bot_json = serde_json::to_string_pretty(recipe).unwrap_or_default();
    let sha = hex(&Sha256::digest(bot_json.as_bytes()));
    let line = json!(["bot.json", bot_json.len(), false, sha]).to_string();
    let hash = hex(&Sha256::digest(format!("{line}\n").as_bytes()));
    // Keys in sorted order at every depth: the signer's canonical JSON.
    let body = json!({
        "files": [{ "bytes": bot_json.len(), "executable": false, "path": "bot.json", "sha256": sha }],
        "format": "ace-market-manifest",
        "hash": hash,
        "key": KEY,
        "name": name,
        "published": 1_760_000_000_000_u64,
        "publisher": { "id": "pub-1", "name": "fares-inc" },
        "size": bot_json.len(),
        "type": "spade-bot",
        "version": version,
    });
    let message = format!("ace-market-manifest-v1\n{body}");
    let signature = URL_SAFE_NO_PAD.encode(pair().sign(message.as_bytes()).as_ref());
    json!({ "signed": { "body": body, "signature": signature }, "bot_json": bot_json })
}
