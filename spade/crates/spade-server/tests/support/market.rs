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
    envelope_with(name, version, recipe, &[])
}

/// [`envelope`] for a package holding `files` (path and text) too, each listed in the signed
/// manifest; the envelope carries them as the daemon sends a contract's schema files.
pub fn envelope_with(name: &str, version: &str, recipe: &Value, files: &[(&str, &str)]) -> Value {
    let bot_json = serde_json::to_string_pretty(recipe).unwrap_or_default();
    // Each version's bytes differ, as a published package's do, by a file naming it.
    let readme = format!("# {name} {version}\n");
    let mut all: Vec<(String, String)> = vec![
        ("README.md".to_owned(), readme),
        ("bot.json".to_owned(), bot_json.clone()),
    ];
    all.extend(
        files
            .iter()
            .map(|(p, t)| ((*p).to_owned(), (*t).to_owned())),
    );
    all.sort();
    let lines: String = all
        .iter()
        .map(|(path, text)| {
            format!(
                "{}\n",
                json!([
                    path,
                    text.len(),
                    false,
                    hex(&Sha256::digest(text.as_bytes()))
                ])
            )
        })
        .collect();
    let hash = hex(&Sha256::digest(lines.as_bytes()));
    let listed: Vec<Value> = all
        .iter()
        .map(|(path, text)| {
            json!({ "bytes": text.len(), "executable": false, "path": path,
                    "sha256": hex(&Sha256::digest(text.as_bytes())) })
        })
        .collect();
    // Keys in sorted order at every depth: the signer's canonical JSON.
    let body = json!({
        "files": listed,
        "format": "ace-market-manifest",
        "hash": hash,
        "key": KEY,
        "name": name,
        "published": 1_760_000_000_000_u64,
        "publisher": { "id": "pub-1", "name": "fares-inc" },
        "size": all.iter().map(|(_, text)| text.len()).sum::<usize>(),
        "type": "spade-bot",
        "version": version,
    });
    let message = format!("ace-market-manifest-v1\n{body}");
    let signature = URL_SAFE_NO_PAD.encode(pair().sign(message.as_bytes()).as_ref());
    let carried: serde_json::Map<String, Value> = files
        .iter()
        .map(|(path, text)| ((*path).to_owned(), json!(text)))
        .collect();
    let mut out =
        json!({ "signed": { "body": body, "signature": signature }, "bot_json": bot_json });
    if !carried.is_empty() {
        out["files"] = Value::Object(carried);
    }
    out
}

/// The market's terms notices (ADR 0205 §4) issued at `issued`, each `(provider, status)`, signed
/// with the test market's key; with `forged`, signed with another key under the test key's name.
pub fn notices(issued: i64, notices: &[(&str, &str)], forged: bool) -> Value {
    // Keys in sorted order at every depth: the signer's canonical JSON.
    let lines: Vec<Value> = notices
        .iter()
        .map(|(provider, status)| {
            json!({ "at": issued, "note": "Read again.", "provider": provider, "status": status })
        })
        .collect();
    let body = json!({
        "format": "ace-market-notices",
        "issued": issued,
        "key": KEY,
        "notices": lines,
    });
    let message = format!("ace-market-notices-v1\n{body}");
    let signer = if forged {
        ring::signature::Ed25519KeyPair::from_seed_unchecked(&[3; 32])
            .unwrap_or_else(|e| panic!("a test key: {e}"))
    } else {
        pair()
    };
    let signature = URL_SAFE_NO_PAD.encode(signer.sign(message.as_bytes()).as_ref());
    json!({ "body": body, "signature": signature })
}
