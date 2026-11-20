//! A package's identity, from the market's signature over its exact bytes (ADR 0200 §3.2). The
//! daemon fetched the package, but anything that can reach Spade's API could say any package id
//! with any recipe; so Spade believes a name, version and hash only from the market's signed
//! version manifest (ADR 0168 §6), checked here with the market keys this build trusts, and only
//! for the `bot.json` whose bytes that manifest lists. Without one, a version 3 package installs
//! as a local package: `local/<name>`, claiming no publisher and no market version.
//!
//! The signature is `packages/marketplace/src/signing.ts`'s: Ed25519 over
//! `ace-market-manifest-v1\n` and the body's canonical JSON (keys sorted at every depth, no
//! spaces). The content hash is `hash.ts`'s: sha256 over one JSON line per file,
//! `[path, bytes, executable, sha256]`, in path order. Pure: the keys are passed in.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use spade_core::package::link::PackageId;

/// What signed manifests are signed behind, so a signature on another kind never verifies.
const LABEL: &str = "ace-market-manifest-v1";
/// The market's keys this build ships (`packages/marketplace/src/keys.ts`, the same keys).
const SHIPPED: &str = include_str!("../../../../config/market-keys.json");
/// Where the market is, as a linked bot's package names its source.
pub const MARKET: &str = "market";
/// A package with no market signature: its source, and its version.
pub const LOCAL: &str = "local";

/// A market key, its public half.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct MarketKey {
    pub id: String,
    #[serde(rename = "publicKey")]
    pub public_key: String,
}

#[derive(Deserialize)]
struct KeySet {
    keys: Vec<MarketKey>,
}

/// The market keys this build trusts.
pub fn shipped() -> Vec<MarketKey> {
    serde_json::from_str::<KeySet>(SHIPPED)
        .map(|set| set.keys)
        .unwrap_or_default()
}

/// What the daemon passes for a market package: the signed version manifest as the market
/// served it, and `bot.json` exactly as the archive has it.
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct Envelope {
    pub signed: Value,
    pub bot_json: String,
}

#[derive(Deserialize)]
struct Signed {
    body: Value,
    signature: String,
}

#[derive(Deserialize)]
struct Body {
    format: String,
    #[serde(rename = "type")]
    kind: String,
    name: String,
    version: String,
    hash: String,
    files: Vec<File>,
    key: String,
}

#[derive(Deserialize)]
struct File {
    path: String,
    bytes: u64,
    executable: bool,
    sha256: String,
}

/// The identity `envelope` proves, and the `bot.json` it covers, read as JSON; else why not.
pub fn verify(envelope: &Envelope, keys: &[MarketKey]) -> Result<(PackageId, Value), String> {
    let signed: Signed = serde_json::from_value(envelope.signed.clone())
        .map_err(|_| "the signed manifest is malformed".to_owned())?;
    let body: Body = serde_json::from_value(signed.body.clone())
        .map_err(|_| "the signed manifest is malformed".to_owned())?;
    if body.format != "ace-market-manifest" || body.kind != "spade-bot" {
        return Err("the signed manifest isn't a bot package's".to_owned());
    }
    let key = keys
        .iter()
        .find(|key| key.id == body.key)
        .ok_or_else(|| format!("signed by a key this Spade doesn't trust ({})", body.key))?;
    let public = URL_SAFE_NO_PAD
        .decode(&key.public_key)
        .map_err(|_| "a trusted key doesn't read".to_owned())?;
    let signature = URL_SAFE_NO_PAD
        .decode(&signed.signature)
        .map_err(|_| "the signature doesn't match".to_owned())?;
    let message = format!("{LABEL}\n{}", canonical(&signed.body));
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public)
        .verify(message.as_bytes(), &signature)
        .map_err(|_| "the signature doesn't match".to_owned())?;
    if content_hash(&body.files) != body.hash {
        return Err("the signed manifest's files don't make its hash".to_owned());
    }
    let bytes = envelope.bot_json.as_bytes();
    let listed = body
        .files
        .iter()
        .find(|file| file.path == "bot.json")
        .ok_or_else(|| "the signed package has no bot.json".to_owned())?;
    if listed.bytes != bytes.len() as u64 || listed.sha256 != hex(&Sha256::digest(bytes)) {
        return Err("bot.json isn't the one the market signed".to_owned());
    }
    let recipe: Value =
        serde_json::from_slice(bytes).map_err(|_| "the signed bot.json isn't JSON".to_owned())?;
    Ok((
        PackageId {
            source: MARKET.to_owned(),
            name: body.name,
            version: body.version,
            hash: body.hash,
        },
        recipe,
    ))
}

/// The identity of a package with no market signature: `local/<name>`, at version `local`,
/// hashed from the manifest Spade read. It names no publisher and no market version.
pub fn local(recipe: &Value, name: &str) -> PackageId {
    let slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    PackageId {
        source: LOCAL.to_owned(),
        name: format!("local/{}", if slug.is_empty() { "bot" } else { &slug }),
        version: LOCAL.to_owned(),
        hash: hex(&Sha256::digest(canonical(recipe).as_bytes())),
    }
}

/// Whether `package` is a local package's identity.
pub fn is_local(package: &PackageId) -> bool {
    package.source == LOCAL
}

/// JSON with object keys sorted at every depth and no spaces, as the signer writes it.
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let fields: Vec<String> = keys
                .into_iter()
                .map(|key| format!("{}:{}", Value::from(key.as_str()), canonical(&map[key])))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(canonical).collect();
            format!("[{}]", items.join(","))
        }
        other => other.to_string(),
    }
}

fn content_hash(files: &[File]) -> String {
    let mut sorted: Vec<&File> = files.iter().collect();
    sorted.sort_by(|a, b| a.path.cmp(&b.path));
    let mut lines = String::new();
    for file in sorted {
        let line = serde_json::json!([file.path, file.bytes, file.executable, file.sha256]);
        lines.push_str(&line.to_string());
        lines.push('\n');
    }
    hex(&Sha256::digest(lines.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests;
