// SPDX-License-Identifier: Apache-2.0
//! The remote profile shapes, validated the way the TypeScript schema does:
//! the first complaint wins, and a URL only a browser could parse rethrows.

use serde_json::Value;

/// What a stored profile fails the TypeScript schema with: its first complaint, or the
/// `TypeError` a URL only a browser could parse rethrows past every complaint.
pub enum ProfileFailure {
    Schema(String),
    InvalidUrl,
}

/// A profile name as the store reads it: `name.parse` in `profiles.ts` refuses anything
/// but `[a-zA-Z0-9_.-]{1,64}` (length in UTF-16 units, as JavaScript counts), then refuses
/// `local`.
pub fn name_issue(name: &str) -> Option<&'static str> {
    let valid = (1..=64).contains(&name.encode_utf16().count())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if !valid {
        return Some("Invalid string: must match pattern /^[a-zA-Z0-9_.-]{1,64}$/");
    }
    if name == "local" {
        return Some("Invalid input");
    }
    None
}

/// How a JSON value reads in a zod complaint.
fn json_kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn invalid_type(expected: &str, value: &Value) -> String {
    format!(
        "Invalid input: expected {expected}, received {}.",
        json_kind(value)
    )
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Lowercase or uppercase hex of exactly `len` characters.
fn is_hex(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A UUID as `z.uuid()` reads it: hex groups with a version 1-8 and an 89ab variant.
fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().enumerate() {
        let hex = byte.is_ascii_hexdigit();
        let dash = matches!(index, 8 | 13 | 18 | 23);
        if dash != (*byte == b'-') || (!dash && !hex) {
            return false;
        }
    }
    matches!(bytes[14], b'1'..=b'8') && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

/// Whether a parsed origin fails the pinned-TLS shape.
fn origin_shape_bad(url: &url::Url) -> bool {
    url.scheme() != "https"
        || url.path() != "/"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
}

/// Whether a parsed relay URL fails the relay shape.
fn relay_shape_bad(url: &url::Url) -> bool {
    !matches!(url.scheme(), "ws" | "wss")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some_and(|query| !query.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
}

/// The URL fields a stored profile is parsed through, in shape order.
fn url_fields(object: &serde_json::Map<String, Value>) -> Vec<&str> {
    let mut fields = Vec::new();
    if let Some(Value::String(origin)) = object.get("origin") {
        let _ = origin;
        fields.push("origin");
    }
    if let Some(Value::Object(relay)) = object.get("relay")
        && let Some(Value::String(_)) = relay.get("url")
    {
        fields.push("relay.url");
    }
    fields
}

fn field_url<'a>(object: &'a serde_json::Map<String, Value>, field: &str) -> Option<&'a str> {
    match field {
        "origin" => object.get("origin")?.as_str(),
        "relay.url" => object.get("relay")?.get("url")?.as_str(),
        _ => None,
    }
}

/// The first field a stored profile fails `RemoteProfile` with, in shape order.
/// A `TypeError` from an unparseable URL wins over any collected complaint, as it
/// rethrows out of `safeParse` in the TypeScript CLI too.
#[allow(clippy::too_many_lines)]
pub fn profile_schema_issue(value: &Value) -> Option<ProfileFailure> {
    use ProfileFailure::{InvalidUrl, Schema};
    let Some(object) = value.as_object() else {
        return Some(Schema(invalid_type("object", value)));
    };
    for field in url_fields(object) {
        if let Some(text) = field_url(object, field)
            && url::Url::parse(text).is_err()
        {
            return Some(InvalidUrl);
        }
    }
    let mut issue: Option<String> = None;
    let mut fail = |message: String| {
        if issue.is_none() {
            issue = Some(message);
        }
    };
    // id, name.
    if let Some(id) = required_string(object, "id", &mut fail)
        && !is_uuid(id)
    {
        fail("Invalid UUID.".to_owned());
    }
    if let Some(name) = required_string(object, "name", &mut fail)
        && let Some(message) = name_issue(name)
    {
        fail(message.to_owned());
    }
    // origin: a pinned-TLS address, when present.
    if let Some(origin) = optional_string(object, "origin", &mut fail)
        && let Ok(url) = url::Url::parse(origin)
        && origin_shape_bad(&url)
    {
        fail("Invalid input.".to_owned());
    }
    // fingerprint: the pin for that address, when present.
    if let Some(fingerprint) = optional_string(object, "fingerprint", &mut fail)
        && !is_hex(fingerprint, 64)
    {
        fail("Invalid string: must match pattern /^[a-f0-9]{64}$/".to_owned());
    }
    // relay: the machine the link came through, when present.
    if let Some(relay) = object.get("relay") {
        if let Some(relay) = relay.as_object() {
            match relay.get("url") {
                None => fail("Invalid input: expected string, received undefined.".to_owned()),
                Some(url) => {
                    if let Some(text) = url.as_str()
                        && let Ok(parsed) = url::Url::parse(text)
                        && relay_shape_bad(&parsed)
                    {
                        fail("Invalid input.".to_owned());
                    } else if url.as_str().is_none() {
                        fail(invalid_type("string", url));
                    }
                }
            }
            match relay.get("relayHostId") {
                None => fail("Invalid input: expected string, received undefined.".to_owned()),
                Some(host) => {
                    if let Some(text) = host.as_str() {
                        if text.len() != 52
                            || !text
                                .bytes()
                                .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
                        {
                            fail("Invalid string: must match pattern /^[A-Z2-7]{52}$/".to_owned());
                        }
                    } else {
                        fail(invalid_type("string", host));
                    }
                }
            }
        } else {
            fail(invalid_type("object", relay));
        }
    }
    // deviceId, token, hostId, label.
    if let Some(device) = required_string(object, "deviceId", &mut fail)
        && device.is_empty()
    {
        fail("Too small: expected string to have >=1 characters.".to_owned());
    }
    if let Some(token) = required_string(object, "token", &mut fail)
        && !is_hex(token, 64)
    {
        fail("Invalid string: must match pattern /^[0-9a-f]{64}$/".to_owned());
    }
    if let Some(host) = optional_string(object, "hostId", &mut fail)
        && host.is_empty()
    {
        fail("Too small: expected string to have >=1 characters.".to_owned());
    }
    if let Some(label) = optional_string(object, "label", &mut fail) {
        if label.is_empty() {
            fail("Too small: expected string to have >=1 characters.".to_owned());
        } else if utf16_len(label) > 256 {
            fail("Too big: expected string to have <=256 characters.".to_owned());
        }
    }
    if let Some(message) = issue {
        return Some(Schema(message));
    }
    // A profile needs a pinned TLS address, a relay, or both.
    let direct = (object.get("origin").is_some() == object.get("fingerprint").is_some())
        && (object.get("origin").is_some() || object.get("relay").is_some());
    if direct {
        None
    } else {
        Some(Schema(
            "A profile needs a pinned TLS address, a relay, or both.".to_owned(),
        ))
    }
}

/// A required string field: missing or mistyped is the schema's complaint.
fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    fail: &mut impl FnMut(String),
) -> Option<&'a str> {
    let Some(found) = object.get(key) else {
        fail("Invalid input: expected string, received undefined.".to_owned());
        return None;
    };
    if let Some(text) = found.as_str() {
        Some(text)
    } else {
        fail(invalid_type("string", found));
        None
    }
}

/// An optional string field: missing is fine, anything else must be a string.
fn optional_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    fail: &mut impl FnMut(String),
) -> Option<&'a str> {
    let found = object.get(key)?;
    if let Some(text) = found.as_str() {
        Some(text)
    } else {
        fail(invalid_type("string", found));
        None
    }
}
