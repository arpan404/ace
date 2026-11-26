// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-server.ts`: the device side of a capture. The pinned jar is pushed, a TCP forward
//! tunnel is opened, and the server is spawned through `adb shell` without either tunnel socket
//! connected; the capture (or ace-media, D1) connects the sockets and the server greets its
//! first one with a dummy byte, then the 64-byte device name. This module decides the commands,
//! their byte caps and deadlines, the forward's port, the greeting's name, and today's startup
//! errors; the sockets, timers and process are the shell's.

use crate::platform::{Code, Error, Failure};

use super::protocol::{ServerProfile, server_args, socket_name};

/// The longest server startup the capture waits for.
pub const STARTUP_MS: u64 = 10_000;
/// How long one refused first connection waits before dialling again.
pub const RETRY_MS: u64 = 100;
/// The device name the server writes after its greeting byte.
pub const DEVICE_NAME_BYTES: usize = 64;

pub const PUSH_MAX_BYTES: u64 = 64 * 1024;
pub const PUSH_TIMEOUT_MS: u64 = 60_000;
pub const FORWARD_MAX_BYTES: u64 = 4096;
pub const FORWARD_TIMEOUT_MS: u64 = 10_000;
pub const REMOVE_MAX_BYTES: u64 = 4096;
pub const REMOVE_TIMEOUT_MS: u64 = 5_000;

/// One adb command the shell runs on the capture's transport.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandPlan {
    pub args: Vec<String>,
    pub max_bytes: u64,
    pub timeout_ms: u64,
}

/// Everything that starts one server, before any socket exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelPlan {
    /// The device's abstract socket name (`scrcpy_<scid>`).
    pub socket: String,
    /// Where the jar is pushed; the server deletes it on exit (`cleanup=true`).
    pub remote_jar: String,
    pub push: CommandPlan,
    pub forward: CommandPlan,
    /// `adb -s <serial> shell <command>` for the server itself.
    pub spawn_args: Vec<String>,
    pub spawn_name: String,
}

impl TunnelPlan {
    /// Removes the forward once the server has stopped or failed to start.
    pub fn remove_forward(&self, port: u16) -> CommandPlan {
        CommandPlan {
            args: vec![
                "forward".to_string(),
                "--remove".to_string(),
                format!("tcp:{port}"),
            ],
            max_bytes: REMOVE_MAX_BYTES,
            timeout_ms: REMOVE_TIMEOUT_MS,
        }
    }
}

/// The push, forward and spawn one server needs on one device.
pub fn tunnel_plan(serial: &str, jar: &str, profile: &ServerProfile, version: &str) -> TunnelPlan {
    let socket = socket_name(profile.scid);
    // The server deletes its own jar and a stopping server may do so late, so every run pushes
    // a copy of its own.
    let remote_jar = format!("/data/local/tmp/ace-{socket}.jar");
    let command = format!(
        "CLASSPATH={remote_jar} app_process / com.genymobile.scrcpy.Server {}",
        server_args(version, profile).join(" ")
    );
    TunnelPlan {
        socket: socket.clone(),
        remote_jar: remote_jar.clone(),
        push: CommandPlan {
            args: vec!["push".to_string(), jar.to_string(), remote_jar],
            max_bytes: PUSH_MAX_BYTES,
            timeout_ms: PUSH_TIMEOUT_MS,
        },
        forward: CommandPlan {
            args: vec![
                "forward".to_string(),
                "tcp:0".to_string(),
                format!("localabstract:{socket}"),
            ],
            max_bytes: FORWARD_MAX_BYTES,
            timeout_ms: FORWARD_TIMEOUT_MS,
        },
        spawn_args: vec![
            "-s".to_string(),
            serial.to_string(),
            "shell".to_string(),
            command,
        ],
        spawn_name: "device-scrcpy".to_string(),
    }
}

/// The forward's port from `adb forward tcp:0 ...`, or `None` when adb answered something else.
pub fn forward_port(stdout: &str) -> Option<u16> {
    // `Number(stdout)` and `Number.isInteger`, as the TypeScript reads adb's answer.
    let value = stdout.trim().parse::<f64>().ok()?;
    if value.fract() != 0.0 || !(1.0..=65_535.0).contains(&value) {
        return None;
    }
    Some(value as u16)
}

/// The server's 64-byte device name and whatever followed it on the first socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Greeting {
    pub device_name: String,
    /// Bytes the first socket delivered after the name: the first video frame's start, or a
    /// control-only server's first message.
    pub rest: Vec<u8>,
}

/// Reads the greeting metal: the name is 64 bytes, cut at a NUL, then the rest belongs to the
/// capture's reader.
pub fn greeting(meta: &[u8]) -> Greeting {
    let name_bytes = &meta[..meta.len().min(DEVICE_NAME_BYTES)];
    let end = name_bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(name_bytes.len());
    Greeting {
        device_name: String::from_utf8_lossy(&name_bytes[..end]).into_owned(),
        rest: meta.get(DEVICE_NAME_BYTES..).unwrap_or(&[]).to_vec(),
    }
}

/// The moment startup gives up, and how long a step may still take (never less than 1 ms).
pub fn startup_deadline(now_ms: f64, startup_ms: u64) -> f64 {
    now_ms + startup_ms as f64
}

pub fn remaining_ms(deadline: f64, now_ms: f64) -> f64 {
    (deadline - now_ms).max(1.0)
}

/// Today's startup failure: the server never greeted in time, with its last words.
pub fn did_not_start(said: &str) -> Error {
    let trimmed = said.trim();
    let last = trimmed.rsplit('\n').next().unwrap_or("");
    let message = if last.is_empty() {
        "scrcpy-server did not start".to_string()
    } else {
        format!("scrcpy-server did not start: {last}")
    };
    failed(
        message,
        "Use an Android 5 or later device or emulator image, or stop other screen mirroring tools.",
    )
}

/// The server went away mid-handshake.
pub fn closed_during_startup() -> Error {
    failed(
        "scrcpy-server closed during startup".to_string(),
        "Start the device view again.",
    )
}

pub fn push_failed() -> Error {
    failed(
        "Could not copy scrcpy-server to the device".to_string(),
        "Check that the device has free space in /data/local/tmp.",
    )
}

pub fn forward_failed() -> Error {
    failed(
        "adb could not forward the scrcpy socket".to_string(),
        "Restart adb with `adb kill-server`, then start the device view again.",
    )
}

fn failed(message: String, hint: &str) -> Error {
    Error::Failed(Failure {
        code: Code::CommandFailed,
        message,
        hint: hint.to_string(),
    })
}

#[cfg(test)]
mod tests;
