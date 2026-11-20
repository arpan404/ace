//! A contract's schemas in a file of the package (ADR 0200 §3.1, §7): `"file":
//! "contracts/<name>.json"` in place of `input` and `output`, the file holding just those two.
//! They are written into the contract before the manifest is read, so every reader sees one
//! form and checks one thing. A market package's files come only as its signed manifest lists
//! them (`spade-server`'s envelope checks each one's bytes against its sha256 there), so the
//! signature covers the schemas as it covers `bot.json`. The matching step is
//! `inlineContractFiles` in `@ace/marketplace`; `rules.json` holds both to the same refusals.

use serde_json::{Map, Value};

/// The largest schema file: two schemas of at most 16 KiB each, with room around them.
pub const MOST_FILE_BYTES: usize = 40 * 1024;

/// Whether `path` is where a contract's schemas may live: `contracts/<name>.json`.
pub fn schema_path(path: &str) -> bool {
    path.strip_prefix("contracts/")
        .and_then(|rest| rest.strip_suffix(".json"))
        .is_some_and(|name| {
            (1..=64).contains(&name.len())
                && name.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
                && name
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
        })
}

/// The paths `manifest`'s contracts name for their schemas.
pub fn named(manifest: &Value) -> Vec<String> {
    manifest["contracts"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|contract| contract.get("file").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// `manifest` with each contract that names a schema file holding that file's `input` and
/// `output` instead, from `read` (a path to its text, if the package has it); else every problem.
/// A manifest whose contracts name no file comes back as it is.
pub fn inline(
    manifest: &Value,
    read: impl Fn(&str) -> Option<String>,
) -> Result<Value, Vec<String>> {
    let Some(contracts) = manifest["contracts"].as_array() else {
        return Ok(manifest.clone());
    };
    if !contracts.iter().any(|c| c.get("file").is_some()) {
        return Ok(manifest.clone());
    }
    let mut problems = Vec::new();
    let mut written = Vec::with_capacity(contracts.len());
    for (i, contract) in contracts.iter().enumerate() {
        let at = format!("contracts[{i}]");
        match contract.as_object() {
            Some(fields) if fields.contains_key("file") => {
                if let Some(fields) = from_file(fields, &at, &read, &mut problems) {
                    written.push(Value::Object(fields));
                }
            }
            _ => written.push(contract.clone()),
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut out = manifest.clone();
    out["contracts"] = Value::Array(written);
    Ok(out)
}

/// One contract's fields with its file's schemas written in.
fn from_file(
    fields: &Map<String, Value>,
    at: &str,
    read: &impl Fn(&str) -> Option<String>,
    problems: &mut Vec<String>,
) -> Option<Map<String, Value>> {
    let path = fields.get("file").and_then(Value::as_str).unwrap_or("");
    if !schema_path(path) {
        problems.push(format!(
            "{at}.file is contracts/<name>.json, like contracts/cheapest-fare.json"
        ));
        return None;
    }
    if fields.contains_key("input") || fields.contains_key("output") {
        problems.push(format!(
            "{at}: write its schemas either in bot.json or in {path}, not both"
        ));
        return None;
    }
    let Some(text) = read(path) else {
        problems.push(format!("{at}.file: {path} isn't in the package"));
        return None;
    };
    if text.len() > MOST_FILE_BYTES {
        problems.push(format!("{path} is larger than 40 KiB"));
        return None;
    }
    let Ok(Value::Object(schemas)) = serde_json::from_str::<Value>(&text) else {
        problems.push(format!("{path} isn't a JSON object of input and output"));
        return None;
    };
    if let Some(other) = schemas.keys().find(|k| *k != "input" && *k != "output") {
        problems.push(format!(
            "{path}: {other} isn't a field of a schema file; it holds only input and output"
        ));
        return None;
    }
    let mut out = fields.clone();
    out.remove("file");
    for key in ["input", "output"] {
        out.insert(
            key.to_owned(),
            schemas.get(key).cloned().unwrap_or(Value::Null),
        );
    }
    Some(out)
}
