// SPDX-License-Identifier: Apache-2.0
//! `daemon logs`: the daemon's recent log, `logs/ace.jsonl`. One line per record; `--follow`
//! keeps printing, `--json` prints the records as JSON (one per line with `--follow`).
#![allow(
    clippy::result_large_err,
    reason = "the failure envelope is returned by value to its one printer; boxing would only add an allocation"
)]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use cli_out::{Failure, Out, Outcome, OutputMode, output_mode};
use cli_parse::Parsed;

use super::error;
use super::log_format::{LogRecord, log_line};

/// `ace logs [--follow]`: the daemon's log, newest `limit` records first as written.
pub(crate) fn run<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
) -> Outcome {
    const ID: &str = "daemon.logs";
    let home = match cli_wire::Home::from_env() {
        Ok(home) => home,
        Err(error) => {
            return crate::run::fail(
                out,
                err,
                Some(&parsed.flags),
                &error::wire_failure(&error, ID),
            );
        }
    };
    let limit = match log_limit(parsed) {
        Ok(limit) => limit,
        Err(failure) => return crate::run::fail(out, err, Some(&parsed.flags), &failure),
    };
    let follow = parsed.flags.on("follow") || parsed.flags.on("f");
    let path = home.path().join("logs").join("ace.jsonl");
    match read_log(&path, limit, follow) {
        Ok(lines) => {
            if lines.len() > limit {
                let failure = Failure::new(
                    Outcome::Uncertain,
                    "The log had more lines than were asked for.",
                )
                .with_command(ID);
                return crate::run::fail(out, err, Some(&parsed.flags), &failure);
            }
            emit_records(parsed, out, err, ID, &lines)
        }
        Err(ReadFailure::Failed { diagnostic }) => {
            let failure = tail_failure(&diagnostic).with_command(ID);
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
        Err(ReadFailure::Invalid { syntax }) => {
            let failure = if syntax {
                error::internal("the daemon's log has a line that isn't JSON")
            } else {
                Failure::usage(
                    "An argument isn't in the form ace expects: a log record isn't in the form ace expects.",
                )
                .with_hint("See ace help daemon logs.")
            }
            .with_command(ID);
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
    }
}

/// `--limit`: 1 to 1000 lines, 100 by default.
fn log_limit(parsed: &Parsed<'_>) -> Result<usize, Failure<'static>> {
    const ID: &str = "daemon.logs";
    let Some(raw) = parsed.flags.value("limit") else {
        return Ok(100);
    };
    if !raw.bytes().all(|byte| byte.is_ascii_digit()) || raw.is_empty() {
        return Err(invalid_limit(ID));
    }
    match raw.parse::<usize>() {
        Ok(limit) if (1..=1000).contains(&limit) => Ok(limit),
        _ => Err(invalid_limit(ID)),
    }
}

fn invalid_limit(id: &'static str) -> Failure<'static> {
    Failure::usage("--limit takes a whole number from 1 to 1000.")
        .with_argument("--limit")
        .with_command(id)
}

/// What reading the log learned: validated raw lines, or why not.
enum ReadFailure {
    Failed { diagnostic: String },
    Invalid { syntax: bool },
}

/// Reads the log with the system's `tail`, which owns file replacement and partial UTF-8.
fn read_log(
    path: &std::path::Path,
    limit: usize,
    follow: bool,
) -> Result<Vec<String>, ReadFailure> {
    let interrupted = Arc::new(AtomicBool::new(false));
    let mut command = Command::new("tail");
    // The flag order the TypeScript uses, which BSD and GNU tail both read: `-F` names
    // following, before the file it follows.
    command.arg("-n").arg(limit.to_string());
    if follow {
        command.arg("-F");
    }
    command
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| ReadFailure::Failed {
        diagnostic: String::new(),
    })?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let shared: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(child)));
    // The log's diagnostics, kept from its last 4 KiB; read on a thread so a full pipe never
    // blocks the records.
    let diagnostic = std::thread::spawn(move || {
        use std::io::Read as _;
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let flag = Arc::clone(&interrupted);
    let killer = Arc::clone(&shared);
    let _handler = ctrlc::set_handler(move || {
        flag.store(true, Ordering::SeqCst);
        if let Ok(mut slot) = killer.lock()
            && let Some(child) = slot.as_mut()
        {
            let _ = child.kill();
        }
    });
    let mut lines = Vec::new();
    if let Some(stdout) = stdout {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            if interrupted.load(Ordering::SeqCst) {
                break;
            }
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(['\n', '\r']);
                    validate_record(trimmed)?;
                    lines.push(trimmed.to_owned());
                    if lines.len() > limit {
                        break;
                    }
                }
                Err(_) => {
                    if interrupted.load(Ordering::SeqCst) {
                        break;
                    }
                    return Err(ReadFailure::Invalid { syntax: true });
                }
            }
        }
    }
    // Take the child back before waiting: the signal handler never blocks on this lock.
    let mut child = shared.lock().ok().and_then(|mut slot| slot.take());
    let status = child.as_mut().and_then(|child| child.wait().ok());
    drop(child);
    let diagnostic = diagnostic.join().unwrap_or_default();
    let tail = diagnostic
        .chars()
        .rev()
        .take(4096)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    if !interrupted.load(Ordering::SeqCst) && status.is_none_or(|status| status.code() != Some(0)) {
        return Err(ReadFailure::Failed { diagnostic: tail });
    }
    Ok(lines)
}

/// A log line is JSON shaped like a record; anything else fails the run, not the line.
fn validate_record(line: &str) -> Result<(), ReadFailure> {
    serde_json::from_str::<serde_json::Value>(line)
        .map_err(|_| ReadFailure::Invalid { syntax: true })?;
    let record: LogRecord<'_> =
        serde_json::from_str(line).map_err(|_| ReadFailure::Invalid { syntax: false })?;
    if !matches!(record.level.as_ref(), "debug" | "info" | "warn" | "error") {
        return Err(ReadFailure::Invalid { syntax: false });
    }
    Ok(())
}

/// Why `tail` failed: no log yet on this machine, or its own last words.
fn tail_failure(diagnostic: &str) -> Failure<'static> {
    let trimmed = diagnostic.trim();
    let message = if diagnostic.to_lowercase().contains("no such file") {
        "ace has no log yet on this machine.".to_owned()
    } else if trimmed.is_empty() {
        "The log couldn't be read.".to_owned()
    } else {
        trimmed.to_owned()
    };
    Failure::new(Outcome::Failed, message)
        .with_code(cli_out::ErrorCode::Failed)
        .with_hint("ace writes it once the daemon has run: ace start.")
}

/// Prints validated raw lines in the mode asked for.
fn emit_records<W: Write, E: Write>(
    parsed: &Parsed<'_>,
    out: &mut Out<W>,
    err: &mut Out<E>,
    id: &'static str,
    lines: &[String],
) -> Outcome {
    let mode = output_mode(&parsed.flags);
    let color = super::stdout_color(&parsed.flags);
    let follow = parsed.flags.on("follow") || parsed.flags.on("f");
    let result = match mode {
        OutputMode::Json if follow => {
            let mut result: Result<(), cli_out::WriteError> = Ok(());
            for line in lines {
                result = result
                    .and_then(|()| out.write("{\"type\":\"log\",\"record\":"))
                    .and_then(|()| out.write(line))
                    .and_then(|()| out.write("}\n"));
                if result.is_err() {
                    break;
                }
            }
            result
        }
        OutputMode::Json => {
            let mut text = String::with_capacity(lines.iter().map(String::len).sum::<usize>() + 2);
            text.push('[');
            text.push_str(&lines.join(","));
            text.push(']');
            text.push('\n');
            out.write(&text)
        }
        OutputMode::Human => {
            let mut result: Result<(), cli_out::WriteError> = Ok(());
            for line in lines {
                let record: Option<LogRecord<'_>> = serde_json::from_str(line).ok();
                let text = record.map_or_else(|| line.clone(), |record| log_line(&record, color));
                result = result.and_then(|()| out.line(&text));
                if result.is_err() {
                    break;
                }
            }
            result
        }
        OutputMode::Quiet => Ok(()),
    };
    match result {
        Ok(()) => Outcome::Ok,
        Err(error) => {
            let failure = error::internal(&format!("ace couldn't write its output: {error}"))
                .with_command(id);
            crate::run::fail(out, err, Some(&parsed.flags), &failure)
        }
    }
}
