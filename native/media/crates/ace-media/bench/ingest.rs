// SPDX-License-Identifier: Apache-2.0
//! The plan's ingest budget: one producer streaming 60 fps of 33 KB units into a release
//! ace-media should cost at most 1 % of a core. Reads ace-media's own CPU time from `pong`.
//!
//! cargo build --release -p ace-media && cargo run --release -p ace-media --example ingest
#[cfg(unix)]
fn main() -> Result<(), String> {
    bench::run()
}

#[cfg(not(unix))]
fn main() {
    eprintln!("the ingest bench needs the unix ingest socket");
}

#[cfg(unix)]
mod bench {
    use media_wire::control::{ControlFrame, FromMedia, Lane, ToMedia};
    use media_wire::frame::MediaFrame;
    use serde_json::{Value, json};
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    use zeroize::Zeroizing;

    const SECONDS: u64 = 10;

    fn frame(value: Value, payload: &[u8]) -> Result<Vec<u8>, String> {
        let message: ToMedia = serde_json::from_value(value).map_err(|e| e.to_string())?;
        let control = ControlFrame {
            message,
            payload: Zeroizing::new(payload.to_vec()),
        };
        let mut bytes = control.header(Lane::Normal).map_err(|_| "encode")?;
        bytes.extend_from_slice(payload);
        Ok(bytes)
    }

    fn read(reader: &mut impl Read) -> Result<FromMedia, String> {
        let mut prefix = [0u8; 4];
        reader.read_exact(&mut prefix).map_err(|e| e.to_string())?;
        let mut bytes = prefix.to_vec();
        bytes.resize(4 + u32::from_be_bytes(prefix) as usize, 0);
        reader
            .read_exact(&mut bytes[4..])
            .map_err(|e| e.to_string())?;
        ControlFrame::<FromMedia>::decode(&bytes, Lane::Normal)
            .map(|f| f.message)
            .map_err(|_| "decode".into())
    }

    fn unit(kind: u8, payload: Vec<u8>) -> Result<Vec<u8>, String> {
        MediaFrame {
            kind,
            flags: 1,
            age_us: 0,
            width: 1280,
            height: 800,
            display_width: 1280,
            display_height: 800,
            scale: 1000,
            rotation: 0,
            codec: if kind == 5 { 0 } else { 1 },
            encode: 0,
            epoch: 0,
            codec_string: String::new(),
            description: Vec::new(),
            extension: Vec::new(),
            payload,
        }
        .encode()
        .map_err(|_| "frame".into())
    }

    /// ace-media's CPU milliseconds so far.
    fn cpu_ms(stdin: &mut impl Write, stdout: &mut impl Read, id: &str) -> Result<u64, String> {
        stdin
            .write_all(&frame(json!({ "type": "ping", "id": id }), &[])?)
            .map_err(|e| e.to_string())?;
        loop {
            if let FromMedia::Pong { stats, .. } = read(stdout)? {
                return Ok(stats.cpu_ms.get());
            }
        }
    }

    pub fn run() -> Result<(), String> {
        let binary = std::env::args()
            .nth(1)
            .unwrap_or_else(|| "target/release/ace-media".into());
        let dir = std::env::temp_dir().join(format!("am-bench-{}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let mut child = Command::new(&binary)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{binary}: {e}"))?;
        let (Some(mut stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            return Err("no pipes".into());
        };
        let path = dir.to_string_lossy();
        let init = json!({ "type": "init", "protocol": 1, "version": "bench", "runtimeDir": path,
        "dataDir": path, "settings": { "recordings": "legacy", "stills": "legacy",
        "encode": "auto", "delivery": "auto" } });
        stdin
            .write_all(&frame(init, &[1; 32])?)
            .map_err(|e| e.to_string())?;
        let FromMedia::Ready { ingest, .. } = read(&mut stdout)? else {
            return Err("no ready".into());
        };
        let open = json!({ "type": "source.open", "source": "s1", "handle": 1, "epoch": 0,
        "origin": { "kind": "tab" } });
        stdin
            .write_all(&frame(open, &[2; 32])?)
            .map_err(|e| e.to_string())?;

        let idle_start = cpu_ms(&mut stdin, &mut stdout, "a")?;
        std::thread::sleep(Duration::from_secs(SECONDS));
        let idle = cpu_ms(&mut stdin, &mut stdout, "b")? - idle_start;

        let mut producer = UnixStream::connect(&ingest.socket).map_err(|e| e.to_string())?;
        producer
            .write_all(&unit(5, vec![2; 32])?)
            .map_err(|e| e.to_string())?;
        let payload = unit(1, vec![0x5a; 33 * 1024])?;
        let busy_start = cpu_ms(&mut stdin, &mut stdout, "c")?;
        let started = Instant::now();
        let frames = 60 * SECONDS;
        for n in 0..frames {
            let due = started + Duration::from_micros(n * 1_000_000 / 60);
            if let Some(wait) = due.checked_duration_since(Instant::now()) {
                std::thread::sleep(wait);
            }
            producer.write_all(&payload).map_err(|e| e.to_string())?;
        }
        let elapsed = started.elapsed().as_millis() as u64;
        let busy = cpu_ms(&mut stdin, &mut stdout, "d")? - busy_start;
        let _ = child.kill();
        let _ = std::fs::remove_dir_all(&dir);

        let percent = |cpu: u64, wall: u64| cpu as f64 * 100.0 / wall as f64;
        let wall = SECONDS * 1000;
        println!(
            "idle: {idle} ms CPU in {wall} ms ({:.2} % of a core)",
            percent(idle, wall)
        );
        println!(
            "ingest 60 fps x 33 KB: {busy} ms CPU in {elapsed} ms ({:.2} % of a core; budget 1 %)",
            percent(busy, elapsed)
        );
        Ok(())
    }
}
