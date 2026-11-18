//! Real coding-agent sessions, for measuring only (ADR 0172, amendment 1): the calls
//! `real-sessions.sh` extracted from a read-only copy of an ace home. They are never trained on,
//! never written anywhere and never printed one by one; only aggregate numbers leave this module's
//! callers.

use std::path::Path;

use serde_json::Value;

/// What one real call was.
#[derive(Debug, Clone)]
pub enum Kind {
    Shell(String),
    /// A file read or search with Spade's own tools' equivalent.
    FileRead,
    /// A file write or edit.
    FileWrite,
    /// An MCP tool of a server.
    Mcp {
        server: String,
        tool: String,
        arguments: Value,
    },
    /// A provider's own tool with no Spade counterpart (skills, tool search, sub-agents).
    Other,
}

#[derive(Debug, Clone)]
pub struct Call {
    pub thread: String,
    pub workspace: String,
    pub kind: Kind,
}

/// The calls in `dir/calls.jsonl`, in each thread's order.
pub fn read(dir: &Path) -> Result<Vec<Call>, String> {
    let path = dir.join("calls.jsonl");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut calls = Vec::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(row) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let text = |key: &str| {
            row.get(key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        let kind = match text("kind").as_str() {
            "shell" => match row.get("command").and_then(Value::as_str) {
                Some(command) if !command.trim().is_empty() => Kind::Shell(command.to_owned()),
                _ => Kind::Other,
            },
            "file.read" | "search" => Kind::FileRead,
            "file.write" | "file.edit" => Kind::FileWrite,
            "mcp" => Kind::Mcp {
                server: text("server"),
                tool: text("tool"),
                arguments: row.get("arguments").cloned().unwrap_or(Value::Null),
            },
            _ => Kind::Other,
        };
        calls.push(Call {
            thread: text("thread"),
            workspace: text("workspace"),
            kind,
        });
    }
    Ok(calls)
}

/// `command` with the bot's folder written as the labeller's `/workspace`, so a path into the
/// folder reads as inside.
pub fn relative_to(command: &str, workspace: &str) -> String {
    let workspace = workspace.trim_end_matches('/');
    if workspace.is_empty() {
        return command.to_owned();
    }
    command.replace(workspace, "/workspace")
}

/// A stable, privacy-preserving id for a distinct real call: FNV-1a over the command and its
/// workspace. Only this 64-bit number is ever written out to pin the evaluation set shared with
/// the `main` baseline (ADR 0172, amendment 6); the command text never leaves the process.
pub fn identity(command: &str, workspace: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in command
        .bytes()
        .chain(std::iter::once(0))
        .chain(workspace.bytes())
    {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}
