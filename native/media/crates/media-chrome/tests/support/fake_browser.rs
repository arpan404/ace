// SPDX-License-Identifier: Apache-2.0
//! A stand-in browser for contract tests: the test binary itself, started through a small
//! script, speaking Chrome's side of the debugging pipe (fd 3 in, fd 4 out) and the encoder
//! page's side of the sockets. Its "chunks" are not H.264; they carry the picture's sequence.
//!
//! The script's environment picks a behaviour:
//! - `FAKE_EXIT_AFTER=n`: exit after the nth picture (once per `FAKE_ONCE` marker file, if set);
//! - `FAKE_STALL=1`: take pictures and never answer them;
//! - `FAKE_REFUSE_WIDTH=w`: refuse configurations of that width;
//! - `FAKE_NO_PAGE=1`: answer the pipe but never open the page.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};

pub const ENTRY: &str = "MEDIA_CHROME_FAKE";

fn env_u32(name: &str) -> Option<u32> {
    std::env::var(name).ok()?.parse().ok()
}

/// Writes the script that starts this test binary as the fake browser.
pub fn install(dir: &Path, test_name: &str, settings: &[(&str, &str)]) -> std::io::Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir)?;
    let exe = std::env::current_exe()?;
    let vars: String = settings
        .iter()
        .map(|(key, value)| format!("{key}='{value}' "))
        .collect();
    let script = dir.join("fake-chrome");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n{ENTRY}=1 {vars}exec '{}' --exact {test_name} --test-threads=1 --quiet >/dev/null 2>&1\n",
            exe.display()
        ),
    )?;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))?;
    Ok(script)
}

fn connect(url: &str, path: &str) -> Option<WebSocket<TcpStream>> {
    let address = url.strip_prefix("http://")?.split('/').next()?.to_string();
    let target = format!("ws://{}{path}", url.strip_prefix("http://")?);
    let mut request = target.into_client_request().ok()?;
    let origin = format!("http://{address}").parse().ok()?;
    request.headers_mut().insert("Origin", origin);
    let stream = TcpStream::connect(&address).ok()?;
    let (socket, _) = tungstenite::client::client(request, stream).ok()?;
    Some(socket)
}

fn chunk(sequence: u32, generation: u32, key: bool, timestamp: u64) -> Vec<u8> {
    let description: &[u8] = if key { &[1, 0x42, 0xE0, 0x1F] } else { &[] };
    let mut message = vec![1u8, u8::from(key), 0, 0];
    message.extend_from_slice(&sequence.to_le_bytes());
    message.extend_from_slice(&generation.to_le_bytes());
    message.extend_from_slice(&(description.len() as u32).to_le_bytes());
    message.extend_from_slice(&timestamp.to_le_bytes());
    message.extend_from_slice(description);
    message.extend_from_slice(&sequence.to_be_bytes());
    message
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    let mut word = [0u8; 4];
    word.copy_from_slice(&bytes[at..at + 4]);
    u32::from_le_bytes(word)
}

fn page(url: String) {
    let (Some(mut input), Some(mut output)) = (connect(&url, "in"), connect(&url, "out")) else {
        std::process::exit(2);
    };
    let exit_after = env_u32("FAKE_EXIT_AFTER").filter(|_| {
        let Ok(marker) = std::env::var("FAKE_ONCE") else {
            return true;
        };
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(marker)
            .is_ok()
    });
    let stall = std::env::var_os("FAKE_STALL").is_some();
    let refuse = env_u32("FAKE_REFUSE_WIDTH");
    let _ = output.send(Message::text(r#"{"t":"hello","quantizer":true}"#));
    let mut pictures = 0;
    let mut generation = 0;
    while let Ok(message) = input.read() {
        match message {
            Message::Text(text) => {
                let Ok(command) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                let asked = command["generation"].as_u64().unwrap_or(0) as u32;
                let reply = if command["t"] == "configure" {
                    let refused =
                        refuse.is_some_and(|w| command["width"].as_u64() == Some(u64::from(w)));
                    if !refused {
                        generation = asked;
                    }
                    json!({"t": "configured", "generation": asked, "ok": !refused, "reason": "refused by the fake"})
                } else {
                    json!({"t": "flushed", "generation": asked})
                };
                let _ = output.send(Message::text(reply.to_string()));
            }
            Message::Binary(bytes) if bytes.len() >= 32 => {
                pictures += 1;
                if exit_after.is_some_and(|n| pictures >= n) {
                    std::process::exit(1);
                }
                if stall {
                    continue;
                }
                let mut timestamp = [0u8; 8];
                timestamp.copy_from_slice(&bytes[24..32]);
                let reply = chunk(
                    u32_at(&bytes, 4),
                    generation,
                    bytes[2] & 1 == 1,
                    u64::from_le_bytes(timestamp),
                );
                if output.send(Message::binary(reply)).is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }
}

/// The fake browser's main: serves the pipe until `Browser.close` or end of file.
pub fn run() {
    let (Ok(commands), Ok(mut replies)) = (
        std::fs::File::open("/dev/fd/3"),
        std::fs::OpenOptions::new().write(true).open("/dev/fd/4"),
    ) else {
        std::process::exit(3);
    };
    let mut commands = BufReader::new(commands);
    let mut message = Vec::new();
    while commands.read_until(0, &mut message).is_ok_and(|n| n > 0) {
        message.pop();
        let Ok(command) = serde_json::from_slice::<Value>(&message) else {
            break;
        };
        message.clear();
        let method = command["method"].as_str().unwrap_or("");
        if method == "Target.createTarget" && std::env::var_os("FAKE_NO_PAGE").is_none() {
            let url = command["params"]["url"].as_str().unwrap_or("").to_string();
            std::thread::spawn(move || page(url));
        }
        let mut reply = json!({"id": command["id"], "result": {"targetId": "fake"}})
            .to_string()
            .into_bytes();
        reply.push(0);
        let _ = replies.write_all(&reply);
        if method == "Browser.close" {
            break;
        }
    }
    std::process::exit(0);
}
