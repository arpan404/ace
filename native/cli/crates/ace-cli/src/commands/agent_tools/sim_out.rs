// SPDX-License-Identifier: Apache-2.0
//! How an `ace sim` answer leaves the process: the daemon's JSON untouched, words for a
//! person, identifiers for `--quiet`, and the JPEG written byte-identically. Ports the output
//! half of `apps/daemon/src/cli/sim.ts` exactly.

use std::io::Write;

use base64::Engine as _;
use cli_out::{ErrorCode, Failure, Flags, Out, Outcome, OutputMode};

use super::sim::{outcome, unavailable};
use super::sim_args::SimVerb;
use super::sim_human::{identifiers, sim_human};

/// A failed tool call: words on stderr for a person, the object for `--json`.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn failed<W: Write, E: Write>(
    code: Option<&str>,
    hint: Option<&str>,
    data: Option<&serde_json::value::RawValue>,
    mode: OutputMode,
    command: &'static str,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Result<Outcome, Failure<'static>> {
    let (body_code, message, detail, body_hint) = body_fields(code, hint, data);
    let status = outcome(&body_code);
    if mode != OutputMode::Json {
        let mut first = body_code.clone();
        for part in [&message, &detail].into_iter().flatten() {
            first.push_str(": ");
            first.push_str(part);
        }
        let text = format!("{first}\n{}\n", body_hint.unwrap_or_default());
        err.write(&text)
            .map_err(|error| write_failed(&error, command))?;
        return Ok(status);
    }
    let mut map = serde_json::Map::with_capacity(5);
    map.insert("ok".to_owned(), serde_json::Value::Bool(false));
    map.insert("code".to_owned(), serde_json::Value::String(body_code));
    if let Some(message) = message {
        map.insert("message".to_owned(), serde_json::Value::String(message));
    }
    if let Some(hint) = body_hint {
        map.insert("hint".to_owned(), serde_json::Value::String(hint));
    }
    if let Some(detail) = detail {
        map.insert("detail".to_owned(), serde_json::Value::String(detail));
    }
    let text = serde_json::to_string(&serde_json::Value::Object(map))
        .map_err(|error| json_failed(&error, command))?;
    out.write(&text)
        .map_err(|error| write_failed(&error, command))?;
    out.write("\n")
        .map_err(|error| write_failed(&error, command))?;
    Ok(status)
}

/// The failure's fields: the tool's own when it parses, else the envelope's.
fn body_fields(
    code: Option<&str>,
    hint: Option<&str>,
    data: Option<&serde_json::value::RawValue>,
) -> (String, Option<String>, Option<String>, Option<String>) {
    if let Some(raw) = data
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(raw.get())
        && let Some(object) = value.as_object()
    {
        let body_code = object.get("code").and_then(serde_json::Value::as_str);
        let types_ok = ["message", "hint", "detail"]
            .iter()
            .all(|key| object.get(*key).is_none_or(serde_json::Value::is_string));
        if let Some(body_code) = body_code
            && types_ok
        {
            return (
                body_code.to_owned(),
                object
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                object
                    .get("detail")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
                object
                    .get("hint")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned),
            );
        }
    }
    (
        code.unwrap_or("unavailable").to_owned(),
        None,
        None,
        hint.map(str::to_owned),
    )
}

/// A successful call: the daemon's JSON untouched, words for a person, ids for `--quiet`.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn success<W: Write>(
    data_raw: &serde_json::value::RawValue,
    verb: SimVerb,
    mode: OutputMode,
    command: &'static str,
    out: &mut Out<W>,
) -> Result<Outcome, Failure<'static>> {
    match mode {
        OutputMode::Json => {
            out.write(data_raw.get())
                .map_err(|error| write_failed(&error, command))?;
            out.write("\n")
                .map_err(|error| write_failed(&error, command))?;
            Ok(Outcome::Ok)
        }
        OutputMode::Human => {
            let data: serde_json::Value =
                serde_json::from_str(data_raw.get()).map_err(|_| unavailable(command))?;
            let human = sim_human(verb, &data);
            out.write(&human)
                .map_err(|error| write_failed(&error, command))?;
            out.write("\n")
                .map_err(|error| write_failed(&error, command))?;
            Ok(Outcome::Ok)
        }
        OutputMode::Quiet => {
            let data: serde_json::Value =
                serde_json::from_str(data_raw.get()).map_err(|_| unavailable(command))?;
            let ids = identifiers(&data);
            if !ids.is_empty() {
                out.write(&ids.join("\n"))
                    .map_err(|error| write_failed(&error, command))?;
                out.write("\n")
                    .map_err(|error| write_failed(&error, command))?;
            }
            Ok(Outcome::Ok)
        }
    }
}

/// A screenshot: the JPEG on disk, then the tool's answer naming where it went.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub(super) fn screenshot<W: Write>(
    data_raw: &serde_json::value::RawValue,
    mode: OutputMode,
    flags: &Flags<'_>,
    command: &'static str,
    out: &mut Out<W>,
) -> Result<Outcome, Failure<'static>> {
    let data: serde_json::Value =
        serde_json::from_str(data_raw.get()).map_err(|_| unavailable(command))?;
    let (Some(sim_id), Some(sequence), Some(encoded)) = (
        data.get("simId").and_then(serde_json::Value::as_str),
        data.get("sequence").and_then(serde_json::Value::as_i64),
        data.get("base64").and_then(serde_json::Value::as_str),
    ) else {
        return Err(unavailable(command));
    };
    // Width, height, scale and note must read as numbers and text, as the schema requires.
    let valid = data.get("width").is_some_and(serde_json::Value::is_number)
        && data.get("height").is_some_and(serde_json::Value::is_number)
        && data.get("scale").is_some_and(serde_json::Value::is_number)
        && data.get("note").is_some_and(serde_json::Value::is_string);
    if !valid {
        return Err(unavailable(command));
    }
    let safe: String = sim_id
        .bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
                byte as char
            } else {
                '-'
            }
        })
        .collect();
    let path = if let Some(named) = flags.value("output").or_else(|| flags.value("out")) {
        absolutize(named).unwrap_or_else(|| named.to_owned())
    } else {
        let pid = std::process::id();
        let mut tmp = std::env::temp_dir();
        tmp.push(format!("ace-sim-{safe}-{pid}-{sequence}.jpg"));
        tmp.to_string_lossy().into_owned()
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| unavailable(command))?;
    write_file(&path, &bytes).map_err(|_| write_failed_path(&path, command))?;
    let mut object = serde_json::Map::new();
    if let Some(map) = data.as_object() {
        for (key, value) in map {
            if key != "base64" {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    object.insert("path".to_owned(), serde_json::Value::String(path));
    object.insert(
        "mimeType".to_owned(),
        serde_json::Value::String("image/jpeg".to_owned()),
    );
    let shaped = serde_json::Value::Object(object);
    match mode {
        OutputMode::Json => {
            let text =
                serde_json::to_string(&shaped).map_err(|error| json_failed(&error, command))?;
            out.write(&text)
                .map_err(|error| write_failed(&error, command))?;
            out.write("\n")
                .map_err(|error| write_failed(&error, command))?;
            Ok(Outcome::Ok)
        }
        OutputMode::Human => {
            let human = sim_human(SimVerb::Screenshot, &shaped);
            out.write(&human)
                .map_err(|error| write_failed(&error, command))?;
            out.write("\n")
                .map_err(|error| write_failed(&error, command))?;
            Ok(Outcome::Ok)
        }
        OutputMode::Quiet => {
            let ids = identifiers(&shaped);
            if !ids.is_empty() {
                out.write(&ids.join("\n"))
                    .map_err(|error| write_failed(&error, command))?;
                out.write("\n")
                    .map_err(|error| write_failed(&error, command))?;
            }
            Ok(Outcome::Ok)
        }
    }
}

fn absolutize(path: &str) -> Option<String> {
    let std_path = std::path::Path::new(path);
    if std_path.is_absolute() {
        return Some(path.to_owned());
    }
    let cwd = std::env::current_dir().ok()?;
    Some(cwd.join(std_path).to_string_lossy().into_owned())
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn write_file(path: &str, bytes: &[u8]) -> Result<(), std::io::Error> {
    use std::fs::OpenOptions;
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn write_failed(error: &cli_out::WriteError, command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("ace couldn't write its output: {error}"),
    )
    .with_code(ErrorCode::Internal)
    .with_command(command)
}

fn json_failed(error: &serde_json::Error, command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("ace couldn't write its output: {error}"),
    )
    .with_code(ErrorCode::Internal)
    .with_command(command)
}

fn write_failed_path(path: &str, command: &'static str) -> Failure<'static> {
    Failure::new(
        Outcome::Failed,
        format!("ace couldn't write its output: {path}"),
    )
    .with_code(ErrorCode::Internal)
    .with_command(command)
}
