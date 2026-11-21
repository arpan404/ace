//! An outside agent's Agent Card (A2A 1.0.1, ADR 0202 §5): what Spade reads of it, and whether
//! its signature holds. A card's signature is a JWS (RFC 7515) over the card's RFC 8785 form with
//! `signatures` left out; Spade checks ES256 signatures against the keys the publisher serves at
//! the `jku` its own protected header names, on the card's own origin. Everything the card says
//! (its skills, their modes) is the other party's word: shown, never a reason to ask less.
//! Pure: the caller fetches the card and the keys.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value};

/// The A2A version Spade calls agents at.
pub const VERSION: &str = "1.0";
const JSON: &str = "application/json";
/// The most skills a card may offer Spade's bots.
const MOST_SKILLS: usize = 64;

/// One skill on the card, as a tool of the agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub id: String,
    pub name: String,
    pub description: String,
    /// It takes and gives JSON (a data part); otherwise it takes text.
    pub json: bool,
}

/// What Spade reads of a card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    pub name: String,
    pub description: String,
    /// Its JSON-RPC interface at A2A 1.0.
    pub endpoint: String,
    pub skills: Vec<Skill>,
}

fn text(value: &Value, field: &str, most: usize) -> String {
    value[field]
        .as_str()
        .unwrap_or_default()
        .chars()
        .take(most)
        .collect()
}

fn modes(value: &Value, field: &str) -> Option<Vec<String>> {
    value[field].as_array().map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

fn is_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// Reads `card`: its name, its JSON-RPC interface at 1.0, and its skills. A card Spade can't call
/// is refused with why: no such interface, a sign-in Spade can't do yet, no skills.
pub fn read(card: &Value) -> Result<Card, String> {
    let name = text(card, "name", 80);
    if name.trim().is_empty() {
        return Err("The card has no name.".to_owned());
    }
    let endpoint = card["supportedInterfaces"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|i| {
            i["protocolBinding"] == "JSONRPC"
                && i["protocolVersion"]
                    .as_str()
                    .is_some_and(|v| v == VERSION || v.starts_with("1.0."))
        })
        .and_then(|i| i["url"].as_str())
        .ok_or_else(|| {
            "It offers no JSON-RPC interface at A2A 1.0, the one Spade speaks.".to_owned()
        })?
        .to_owned();
    // Sign-in uses the card's schemes through Spade's app sign-in; none is wired yet, so an agent
    // that requires one is refused with its names.
    let required: Vec<String> = card["securityRequirements"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["schemes"].as_object())
        .flat_map(|schemes| schemes.keys().cloned())
        .collect();
    if !required.is_empty() {
        return Err(format!(
            "It needs a sign-in Spade can't do for agents yet: {}.",
            required.join(", ")
        ));
    }
    let defaults_in = modes(card, "defaultInputModes").unwrap_or_default();
    let defaults_out = modes(card, "defaultOutputModes").unwrap_or_default();
    let mut skills = Vec::new();
    for skill in card["skills"].as_array().into_iter().flatten() {
        let id = skill["id"].as_str().unwrap_or_default();
        if !is_id(id) || skills.iter().any(|s: &Skill| s.id == id) {
            continue;
        }
        let inputs = modes(skill, "inputModes").unwrap_or_else(|| defaults_in.clone());
        let outputs = modes(skill, "outputModes").unwrap_or_else(|| defaults_out.clone());
        skills.push(Skill {
            id: id.to_owned(),
            name: text(skill, "name", 80),
            description: text(skill, "description", 1024),
            json: inputs.iter().any(|m| m == JSON) && outputs.iter().any(|m| m == JSON),
        });
        if skills.len() == MOST_SKILLS {
            break;
        }
    }
    if skills.is_empty() {
        return Err("The card lists no skill Spade can offer.".to_owned());
    }
    Ok(Card {
        name,
        description: text(card, "description", 1024),
        endpoint,
        skills,
    })
}

/// A JSON value in RFC 8785's form: object keys sorted by UTF-16 code units, no whitespace,
/// numbers as ECMAScript writes them, strings escaped as JSON.stringify does.
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => out.push_str(&value.to_string()),
        Value::Number(number) => out.push_str(&number_text(number)),
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (at, key) in keys.into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                out.push_str(&Value::String(key.clone()).to_string());
                out.push(':');
                write(&fields[key], out);
            }
            out.push('}');
        }
    }
}

/// A number as ECMAScript's `Number.prototype.toString` writes it, which RFC 8785 uses.
fn number_text(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let Some(float) = number.as_f64() else {
        return number.to_string();
    };
    if float == 0.0 {
        return "0".to_owned();
    }
    if float.fract() == 0.0 && float.abs() < 1e21 {
        return format!("{float:.0}");
    }
    // Shortest round-trip digits; ECMAScript writes exponents as `e+21` / `e-7`.
    let text = format!("{float:e}");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((&text, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    if (-6..21).contains(&exponent) {
        return float.to_string();
    }
    let sign = if exponent < 0 { '-' } else { '+' };
    format!("{mantissa}e{sign}{}", exponent.abs())
}

/// What the person is told about a card's signature.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signed {
    /// A signature over this card holds with a key its publisher serves.
    Verified { kid: String },
    /// No signature that holds: none, an algorithm Spade doesn't check, or one that doesn't
    /// match (a card changed after signing).
    No(String),
}

impl Signed {
    pub fn words(&self) -> &'static str {
        match self {
            Self::Verified { .. } => "Signed by its publisher's key",
            Self::No(_) => "Not signed",
        }
    }
}

/// A signature's protected header, decoded.
pub fn header(signature: &Value) -> Option<Map<String, Value>> {
    let protected = signature["protected"].as_str()?;
    let bytes = URL_SAFE_NO_PAD.decode(protected).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(fields) => Some(fields),
        _ => None,
    }
}

/// The most signatures on a card Spade checks, each perhaps with its own key set to fetch.
pub const MOST_SIGNATURES: usize = 4;

/// The `jku` each of the card's signatures names (at most [`MOST_SIGNATURES`]), in order: where
/// the publisher's keys for that one signature are.
pub fn key_set_addresses(card: &Value) -> Vec<Option<String>> {
    card["signatures"]
        .as_array()
        .into_iter()
        .flatten()
        .take(MOST_SIGNATURES)
        .map(|signature| header(signature)?.get("jku")?.as_str().map(str::to_owned))
        .collect()
}

/// Whether `card` carries a signature that holds. Each signature is checked only against its own
/// key set, `keys[i]` for the `i`th (fetched from its own `jku`, as [`key_set_addresses`] lists
/// them), or not at all when that is an `Err` with why it couldn't be had: one signature's keys
/// never vouch for another.
pub fn verify(card: &Value, keys: &[Result<Value, String>]) -> Signed {
    let Some(signatures) = card["signatures"].as_array().filter(|s| !s.is_empty()) else {
        return Signed::No("the card carries no signature".to_owned());
    };
    let mut payload = card.clone();
    if let Some(fields) = payload.as_object_mut() {
        fields.remove("signatures");
    }
    let body = URL_SAFE_NO_PAD.encode(canonical(&payload));
    let mut why = "no signature holds".to_owned();
    for (at, signature) in signatures.iter().take(MOST_SIGNATURES).enumerate() {
        let Some(header) = header(signature) else {
            why = "a signature's header isn't readable".to_owned();
            continue;
        };
        if header.get("alg").and_then(Value::as_str) != Some("ES256") {
            why = "it is signed with an algorithm Spade doesn't check".to_owned();
            continue;
        }
        let own = match keys.get(at) {
            Some(Ok(own)) => own,
            Some(Err(no)) => {
                why = no.clone();
                continue;
            }
            None => {
                why = "its signature names no keys".to_owned();
                continue;
            }
        };
        let kid = header
            .get("kid")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(point) = key_point(own, kid) else {
            why = "its publisher serves no key by that name".to_owned();
            continue;
        };
        let Some(bytes) = signature["signature"]
            .as_str()
            .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        else {
            continue;
        };
        let input = format!(
            "{}.{body}",
            signature["protected"].as_str().unwrap_or_default()
        );
        let key = ring::signature::UnparsedPublicKey::new(
            &ring::signature::ECDSA_P256_SHA256_FIXED,
            &point,
        );
        if key.verify(input.as_bytes(), &bytes).is_ok() {
            return Signed::Verified {
                kid: kid.to_owned(),
            };
        }
        why = "its signature doesn't match the card, which changed after it was signed".to_owned();
    }
    Signed::No(why)
}

/// The uncompressed P-256 point of key `kid` in a JWK set.
fn key_point(keys: &Value, kid: &str) -> Option<Vec<u8>> {
    let key = keys["keys"]
        .as_array()?
        .iter()
        .find(|k| k["kid"] == kid && k["kty"] == "EC" && k["crv"] == "P-256")?;
    let x = URL_SAFE_NO_PAD.decode(key["x"].as_str()?).ok()?;
    let y = URL_SAFE_NO_PAD.decode(key["y"].as_str()?).ok()?;
    if x.len() != 32 || y.len() != 32 {
        return None;
    }
    let mut point = vec![4u8];
    point.extend(x);
    point.extend(y);
    Some(point)
}

#[cfg(test)]
mod tests;
