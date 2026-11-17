//! A test helper run inside the Windows sandbox (ADR 0167): it does one small thing and reports
//! through its exit code, so the real-process tests can see what the AppContainer allows. It is
//! also the egress bridge for those tests (`sandbox-net-bridge`), standing in for Spade's own
//! binary. It is not shipped; on non-Windows it does nothing.

#[cfg(windows)]
fn main() -> std::process::ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::ExitCode::from(windows::run(&args))
}

#[cfg(not(windows))]
fn main() -> std::process::ExitCode {
    std::process::ExitCode::SUCCESS
}

#[cfg(windows)]
mod windows {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::time::Duration;

    pub fn run(args: &[String]) -> u8 {
        let rest: Vec<&str> = args.iter().skip(1).map(String::as_str).collect();
        match args.first().map(String::as_str) {
            Some("sandbox-net-bridge") => {
                let port = rest.get(1).and_then(|p| p.parse().ok()).unwrap_or(0);
                let ready = rest.get(2).and_then(|p| p.parse().ok()).unwrap_or(0);
                spade_sandbox::windows::bridge::in_container(
                    rest.first().unwrap_or(&""),
                    port,
                    ready,
                )
            }
            Some("connect") => connect(rest.first().copied().unwrap_or("")),
            Some("write") => match std::fs::write(rest.first().unwrap_or(&""), b"x") {
                Ok(()) => 0,
                Err(_) => 2,
            },
            Some("read") => match std::fs::read(rest.first().unwrap_or(&"")) {
                Ok(_) => 0,
                Err(_) => 2,
            },
            Some("ls") => match std::fs::read_dir(rest.first().unwrap_or(&"")) {
                Ok(mut entries) => {
                    // A readable-but-empty folder still counts as readable.
                    let _ = entries.next();
                    0
                }
                Err(_) => 2,
            },
            // `hardlink <existing> <link>`: the Win32 CreateHardLink path. `hardlink-nt`: the
            // native NtSetInformationFile path. 0 made, 2 stopped opening the source, 5 the source
            // opened but the link couldn't be created.
            Some("hardlink") => linked(spade_sandbox::windows::link::via_win32, &rest),
            Some("hardlink-nt") => linked(spade_sandbox::windows::link::via_nt, &rest),
            _ => 3,
        }
    }

    /// Runs one hard-link attempt on `rest` (`<existing> <link>`) and reports its stage.
    fn linked(
        attempt: fn(
            &std::path::Path,
            &std::path::Path,
        ) -> Result<(), spade_sandbox::windows::link::LinkError>,
        rest: &[&str],
    ) -> u8 {
        use spade_sandbox::windows::link::Stage;
        let path = |at: usize| std::path::Path::new(rest.get(at).copied().unwrap_or(""));
        match attempt(path(0), path(1)) {
            Ok(()) => 0,
            Err(failed) if failed.stage == Stage::OpenSource => 2,
            Err(_) => 5,
        }
    }

    /// Connects to `addr`, sends `ping!` and expects `pong!`. Exit 0 on success, 2 on a failure to
    /// connect, 3 on a failure after connecting.
    fn connect(addr: &str) -> u8 {
        let Ok(target) = addr.parse() else { return 4 };
        let Ok(mut stream) = TcpStream::connect_timeout(&target, Duration::from_secs(4)) else {
            return 2;
        };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(4)));
        if stream.write_all(b"ping!").is_err() {
            return 3;
        }
        let mut buf = [0u8; 5];
        match stream.read_exact(&mut buf) {
            Ok(()) if &buf == b"pong!" => 0,
            _ => 3,
        }
    }
}
