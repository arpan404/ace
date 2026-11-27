// SPDX-License-Identifier: Apache-2.0
//! Durable CLI commands: the outbox, idempotency keys and receipt waiting.
//!
//! Ports `apps/daemon/src/cli/mutations.ts` and `apps/daemon/src/cli/storage.ts` exactly:
//! `cli-outbox.sqlite` with `intents(id TEXT PRIMARY KEY, value TEXT NOT NULL)` and
//! `binding(id INTEGER PRIMARY KEY, value TEXT NOT NULL)`, `PRAGMA busy_timeout=15000`,
//! `journal_mode=WAL`, `synchronous=NORMAL`; a command is recorded before it is sent, replayed
//! by id when its reply is lost, and removed once its receipt says it ran; the same
//! `--idempotency-key` never runs twice; a lost reply exits 5 with the admission and retry key.

use std::path::{Path, PathBuf};
use std::time::Duration;

use cli_out::{ErrorCode, Failure, Flags, Outcome};
use cli_wire::{ConnectConfig, Connection, Home, LocalIdentity, TcpProbe, WireError};

const BUSY_MS: u32 = 15_000;
const OUTBOX_FILE: &str = "cli-outbox.sqlite";

/// Validates `--idempotency-key` exactly as `key()` in `mutations.ts`, or makes one.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn idempotency_key(flags: &Flags<'_>) -> Result<String, Failure<'static>> {
    if let Some(value) = flags.value("idempotency-key") {
        let valid = !value.is_empty()
            && value.len() <= 128
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
        if !valid {
            return Err(Failure::usage(
                "--idempotency-key takes 1 to 128 letters, digits, dots, underscores or hyphens.",
            )
            .with_code(ErrorCode::BadArgument)
            .with_argument("--idempotency-key"));
        }
        return Ok(value.to_owned());
    }
    Ok(uuid::Uuid::new_v4().to_string())
}

/// Where this run's outbox lives: the home for a person, `cli-agent` for an agent shell.
#[must_use]
pub fn outbox_dir(home: &Home, identity: LocalIdentity) -> PathBuf {
    match identity {
        LocalIdentity::Person => home.path().to_path_buf(),
        LocalIdentity::Agent => home.path().join("cli-agent"),
    }
}

/// Ensures `dir` exists for the outbox, mode 0700, never following a symlink.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn ensure_dir(dir: &Path) -> Result<(), Failure<'static>> {
    if let Ok(meta) = std::fs::symlink_metadata(dir) {
        if meta.is_symlink() {
            return Err(Failure::new(
                Outcome::Uncertain,
                format!(
                    "Refusing data directory {}: it is a symbolic link",
                    dir.display()
                ),
            )
            .with_code(ErrorCode::Uncertain));
        }
        if meta.is_dir() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
            }
            return Ok(());
        }
        return Err(Failure::new(
            Outcome::Uncertain,
            format!("Refusing data directory {}: not a directory", dir.display()),
        )
        .with_code(ErrorCode::Uncertain));
    }
    if let Err(err) = std::fs::create_dir_all(dir) {
        return Err(Failure::new(
            Outcome::Uncertain,
            format!("ace couldn't keep its outbox: {err}"),
        )
        .with_code(ErrorCode::Uncertain));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn sqlite_failure(err: &rusqlite::Error) -> Failure<'static> {
    Failure::new(
        Outcome::Uncertain,
        format!("ace couldn't keep its outbox: {err}"),
    )
    .with_code(ErrorCode::Uncertain)
}

/// Opens `cli-outbox.sqlite` with the TypeScript discipline: busy wait first, WAL, `NORMAL`,
/// and the two tables, never changing the schema.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn open_outbox(dir: &Path) -> Result<rusqlite::Connection, Failure<'static>> {
    ensure_dir(dir)?;
    let path = dir.join(OUTBOX_FILE);
    let conn = rusqlite::Connection::open(&path).map_err(|err| sqlite_failure(&err))?;
    conn.busy_timeout(Duration::from_millis(u64::from(BUSY_MS)))
        .map_err(|err| sqlite_failure(&err))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY,value TEXT NOT NULL)",
    )
    .map_err(|err| sqlite_failure(&err))?;
    Ok(conn)
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn load_binding(conn: &rusqlite::Connection) -> Result<Option<String>, Failure<'static>> {
    let mut stmt = conn
        .prepare("SELECT value FROM binding WHERE id=1")
        .map_err(|err| sqlite_failure(&err))?;
    let mut rows = stmt.query([]).map_err(|err| sqlite_failure(&err))?;
    if let Some(row) = rows.next().map_err(|err| sqlite_failure(&err))? {
        let value: String = row.get(0).map_err(|err| sqlite_failure(&err))?;
        return Ok(Some(value));
    }
    Ok(None)
}

#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
fn save_binding(conn: &rusqlite::Connection, host_id: &str) -> Result<(), Failure<'static>> {
    conn.execute(
        "INSERT INTO binding VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        [host_id],
    )
    .map_err(|err| sqlite_failure(&err))?;
    Ok(())
}

/// Sends one durable command and waits for its receipt, exactly as `command()` in
/// `mutations.ts`: recorded before dispatch, replayed by id, removed once acked; busy retries
/// with the same key; a lost reply exits 5 with the admission and retry key.
///
/// `payload` is the `CommandPayload` JSON (without `id`/`deviceId`); `command` names the id for
/// the failure envelope (for example `"project.add"`).
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
#[allow(
    clippy::too_many_lines,
    reason = "one durable path: outbox, send, receipt rules in order"
)]
pub fn durable_command(
    flags: &Flags<'_>,
    payload: &serde_json::Value,
    command: &'static str,
    timeout: Duration,
) -> Result<serde_json::Value, Failure<'static>> {
    let key = idempotency_key(flags)?;
    let home = Home::from_env().map_err(|err| super::common::wire_failure(&err, Some(command)))?;
    let identity = LocalIdentity::from_env();
    let device = identity.as_str();
    let dir = outbox_dir(&home, identity);
    let db = open_outbox(&dir)?;
    let expected = load_binding(&db)?;
    let expected_host = expected
        .as_deref()
        .and_then(|value| cli_wire::HostId::parse(value.to_owned()).ok());
    let local = cli_wire::reach_local(&home, &TcpProbe)
        .map_err(|err| super::common::wire_failure(&err, Some(command)))?;
    let config = ConnectConfig {
        handshake_timeout: std::cmp::min(timeout, Duration::from_secs(15)),
        request_timeout: timeout,
        expected_host_id: expected_host,
    };
    let mut conn = Connection::open_local(&local, identity, &config)
        .map_err(|err| super::common::wire_failure(&err, Some(command)))?;
    let host_id = conn.welcome().host_id.as_str().to_owned();
    save_binding(&db, &host_id)?;
    let intent_value = |state: &str| {
        serde_json::json!({
            "command": {"id": key, "deviceId": device, "payload": payload},
            "hostId": host_id,
            "state": state,
        })
        .to_string()
    };
    // Same locking as TypeScript: one writer at a time behind the busy wait. `BEGIN IMMEDIATE`
    // takes the reserved lock before reading, so two runs with the same key cannot both think
    // the key is new with different payloads.
    db.execute_batch("BEGIN IMMEDIATE")
        .map_err(|err| sqlite_failure(&err))?;
    let existing: Option<String> = (|| {
        let mut stmt = db.prepare("SELECT value FROM intents WHERE id=?")?;
        let mut rows = stmt.query([key.as_str()])?;
        if let Some(row) = rows.next()? {
            let value: String = row.get(0)?;
            return Ok(Some(value));
        }
        Ok(None)
    })()
    .map_err(|err| sqlite_failure(&err))
    .inspect_err(|_| {
        let _ = db.execute_batch("ROLLBACK");
    })?;
    if let Some(value) = existing {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&value) {
            let same_device = parsed
                .get("command")
                .and_then(|command| command.get("deviceId"))
                .and_then(serde_json::Value::as_str)
                == Some(device);
            let same_payload = parsed
                .get("command")
                .and_then(|command| command.get("payload"))
                == Some(payload);
            let same_host = parsed
                .get("hostId")
                .and_then(serde_json::Value::as_str)
                .is_none_or(|stored| stored == host_id);
            if same_host && !(same_device && same_payload) {
                let _ = db.execute_batch("ROLLBACK");
                return Err(Failure::new(
                    Outcome::Uncertain,
                    "Idempotency key reused with different payload.",
                )
                .with_code(ErrorCode::Uncertain)
                .with_command(command));
            }
        }
        db.execute(
            "INSERT INTO intents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, intent_value("pending")],
        )
        .map_err(|err| sqlite_failure(&err))
        .inspect_err(|_| {
            let _ = db.execute_batch("ROLLBACK");
        })?;
    } else {
        db.execute(
            "INSERT INTO intents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            rusqlite::params![key, intent_value("pending")],
        )
        .map_err(|err| sqlite_failure(&err))
        .inspect_err(|_| {
            let _ = db.execute_batch("ROLLBACK");
        })?;
    }
    db.execute_batch("COMMIT")
        .map_err(|err| sqlite_failure(&err))?;
    let frame = serde_json::json!({
        "type": "command",
        "command": {"id": key, "deviceId": device, "payload": payload},
    });
    let frame_text = serde_json::to_string(&frame).map_err(|err| {
        Failure::new(
            Outcome::Uncertain,
            format!("ace couldn't send its command: {err}"),
        )
        .with_code(ErrorCode::Uncertain)
        .with_command(command)
    })?;
    let raw = match conn.command_raw_with_timeout(&frame_text, &key, timeout) {
        Ok(raw) => raw,
        Err(err) => {
            return Err(uncertain_lost(&err, &key, payload, command));
        }
    };
    // The daemon closing without a receipt is a lost reply, not a refusal: the outbox keeps it.
    conn.close();
    let receipt: serde_json::Value = serde_json::from_str(raw.get()).map_err(|_| {
        Failure::new(Outcome::Uncertain, "ace didn't confirm whether it ran.")
            .with_code(ErrorCode::Uncertain)
            .with_command(command)
    })?;
    let ok = receipt.get("ok").and_then(serde_json::Value::as_bool) == Some(true);
    if ok {
        let _ = db.execute("DELETE FROM intents WHERE id=?", [key.as_str()]);
        return Ok(receipt);
    }
    let error = receipt
        .get("error")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if error == "action_busy" {
        let _ = db.execute(
            "INSERT INTO intents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
            rusqlite::params![
                key,
                serde_json::json!({
                    "command": {"id": key, "deviceId": device, "payload": payload},
                    "hostId": host_id,
                    "state": "failed",
                    "error": error,
                    "result": receipt,
                })
                .to_string()
            ],
        );
        return Err(
            Failure::new(Outcome::Refused, "ace is busy with other work.")
                .with_code(ErrorCode::Busy)
                .with_hint("Retry the command shortly.")
                .with_command(command),
        );
    }
    let message = receipt
        .get("error")
        .and_then(serde_json::Value::as_str)
        .or_else(|| receipt.get("code").and_then(serde_json::Value::as_str))
        .unwrap_or("Command refused")
        .to_owned();
    let _ = db.execute(
        "INSERT INTO intents VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        rusqlite::params![
            key,
            serde_json::json!({
                "command": {"id": key, "deviceId": device, "payload": payload},
                "hostId": host_id,
                "state": "failed",
                "error": message,
                "result": receipt,
            })
            .to_string()
        ],
    );
    if error.contains("uncertain") {
        return Err(Failure::new(Outcome::Uncertain, message)
            .with_code(ErrorCode::Uncertain)
            .with_command(command));
    }
    Err(Failure::new(Outcome::Refused, message)
        .with_code(ErrorCode::Refused)
        .with_command(command))
}

/// A lost reply: exit 5 with the admission and the key to retry with, as `mutations.ts` does.
fn uncertain_lost(
    err: &WireError,
    key: &str,
    payload: &serde_json::Value,
    command: &'static str,
) -> Failure<'static> {
    use cli_wire::{CliErrorCode, CliOutcome};
    let mapping = err.failure();
    if mapping.outcome == CliOutcome::Refused && mapping.code == CliErrorCode::Refused {
        return super::common::wire_failure(err, Some(command));
    }
    let mut admission = serde_json::json!({
        "commandId": key,
        "idempotencyKey": key,
    });
    if let Some(thread) = payload.get("threadId").and_then(serde_json::Value::as_str) {
        admission["threadId"] = serde_json::Value::String(thread.to_owned());
    }
    let mut failure = Failure::new(Outcome::Uncertain, "ace didn't confirm whether it ran.")
        .with_code(ErrorCode::Uncertain)
        .with_command(command);
    failure.admission = Some(admission);
    failure.retry = Some(cli_out::Retry {
        idempotency_key: std::borrow::Cow::Owned(key.to_owned()),
    });
    failure
}

/// Writes a mutation's receipt: `--json` with the key, human lines, nothing for `--quiet`.
/// A print failure after the daemon took it is uncertain with the key, as `receipt()` does.
#[allow(
    clippy::result_large_err,
    reason = "the CLI's own failure envelope, one per process"
)]
pub fn emit_receipt<W: std::io::Write>(
    out: &mut cli_out::Out<W>,
    mode: cli_out::OutputMode,
    mut receipt: serde_json::Value,
    key: &str,
    extra: Option<(&str, serde_json::Value)>,
    human: &[String],
    command: &'static str,
) -> Result<Outcome, Failure<'static>> {
    if let Some(map) = receipt.as_object_mut() {
        map.insert(
            "idempotencyKey".to_owned(),
            serde_json::Value::String(key.to_owned()),
        );
        if let Some((name, value)) = extra {
            map.insert(name.to_owned(), value);
        }
    }
    match mode {
        cli_out::OutputMode::Json => out
            .json(&receipt)
            .map(|()| Outcome::Ok)
            .map_err(|error| write_failed(&error, &receipt, key, command)),
        cli_out::OutputMode::Human => {
            let mut outcome = Ok(Outcome::Ok);
            for line in human {
                if let Err(error) = out.line(line) {
                    outcome = Err(write_failed(&error, &receipt, key, command));
                    break;
                }
            }
            outcome
        }
        cli_out::OutputMode::Quiet => Ok(Outcome::Ok),
    }
}

fn write_failed(
    error: &cli_out::WriteError,
    receipt: &serde_json::Value,
    key: &str,
    command: &'static str,
) -> Failure<'static> {
    let mut failure = Failure::new(
        Outcome::Uncertain,
        "ace took it, but the answer couldn't be printed.",
    )
    .with_code(ErrorCode::Uncertain)
    .with_command(command);
    failure.admission = Some(receipt.clone());
    failure.retry = Some(cli_out::Retry {
        idempotency_key: std::borrow::Cow::Owned(key.to_owned()),
    });
    let _ = error;
    failure
}
