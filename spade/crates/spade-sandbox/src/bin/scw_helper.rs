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
            // Network probes (ADR 0167, networked runs), each 0 reached, 2 refused, 7 Winsock
            // couldn't even start in this token (std panics when WSAStartup fails).
            // `winsock`: a loopback listener of its own; `resolve <host>`: a name lookup;
            // `tcp <addr>`: a plain TCP connect; `udp-dns <ip>`: a DNS query over UDP, answered.
            // `run-env <envfile> <outfile> <program> [args…]`: runs `program` (in this same token
            // and job) with the `NAME=value` lines of `envfile` added, its stdout and stderr in
            // `outfile`; answers its exit code (99 when it couldn't start).
            Some("run-env") => run_env(&rest),
            // `bind-why <outfile>`: a loopback listener, and why not, written to `outfile`.
            Some("bind-why") => {
                let out = rest.first().copied().unwrap_or("");
                std::panic::set_hook(Box::new(|_| {}));
                let tried = std::panic::catch_unwind(|| {
                    std::net::TcpListener::bind(("127.0.0.1", 0)).map(|_| ())
                });
                let (code, why) = match tried {
                    Ok(Ok(())) => (0, "bound".to_owned()),
                    Ok(Err(error)) => (2, format!("{error} (os error {:?})", error.raw_os_error())),
                    Err(_) => (7, "Winsock could not start".to_owned()),
                };
                let _ = std::fs::write(out, why);
                code
            }
            Some("winsock") => probe(|| std::net::TcpListener::bind(("127.0.0.1", 0)).is_ok()),
            Some("resolve") => {
                let host = format!("{}:443", rest.first().copied().unwrap_or(""));
                probe(move || {
                    std::net::ToSocketAddrs::to_socket_addrs(&host)
                        .map(|mut found| found.next().is_some())
                        .unwrap_or(false)
                })
            }
            Some("tcp") => {
                let addr = rest.first().copied().unwrap_or("").to_owned();
                probe(move || {
                    addr.parse().is_ok_and(|target| {
                        TcpStream::connect_timeout(&target, Duration::from_secs(4)).is_ok()
                    })
                })
            }
            Some("udp-dns") => {
                let server = format!("{}:53", rest.first().copied().unwrap_or(""));
                probe(move || udp_dns(&server))
            }
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
            // `hardlink-direct <existing> <link>`: CreateHardLinkW called directly, no pre-check.
            // 0 made, 6 refused.
            Some("hardlink-direct") => match spade_sandbox::windows::link::create_hard_link(
                std::path::Path::new(rest.first().copied().unwrap_or("")),
                std::path::Path::new(rest.get(1).copied().unwrap_or("")),
            ) {
                Ok(()) => 0,
                Err(_) => 6,
            },
            Some("hardlink-nt") => linked(spade_sandbox::windows::link::via_nt, &rest),
            // What it can reach beyond files and network, each 0 reached, 2 not (ADR 0167 status).
            // `sees <pid>`: lists it among the processes; `ends <pid>`: can open it to end it.
            Some("sees") => {
                let pid: u32 = rest.first().and_then(|p| p.parse().ok()).unwrap_or(0);
                match spade_sandbox::windows::reach::visible_processes() {
                    Ok(pids) if pids.contains(&pid) => 0,
                    _ => 2,
                }
            }
            Some("ends") => {
                let pid: u32 = rest.first().and_then(|p| p.parse().ok()).unwrap_or(0);
                if spade_sandbox::windows::reach::can_terminate(pid) {
                    0
                } else {
                    2
                }
            }
            Some("device") => {
                if spade_sandbox::windows::reach::can_open_device(
                    rest.first().copied().unwrap_or(""),
                ) {
                    0
                } else {
                    2
                }
            }
            Some("event") => {
                if spade_sandbox::windows::reach::can_open_event(
                    rest.first().copied().unwrap_or(""),
                ) {
                    0
                } else {
                    2
                }
            }
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

    fn run_env(rest: &[&str]) -> u8 {
        let (Some(env), Some(out), Some(program)) = (rest.first(), rest.get(1), rest.get(2)) else {
            return 99;
        };
        let Ok(lines) = std::fs::read_to_string(env) else {
            return 99;
        };
        let Ok(file) = std::fs::File::create(out) else {
            return 99;
        };
        let Ok(err) = file.try_clone() else {
            return 99;
        };
        let mut command = std::process::Command::new(program);
        command
            .args(&rest[3..])
            .stdout(file)
            .stderr(err)
            .stdin(std::process::Stdio::null());
        for line in lines.lines() {
            if let Some((name, value)) = line.split_once('=') {
                command.env(name, value);
            }
        }
        match command.status() {
            Ok(status) => u8::try_from(status.code().unwrap_or(98) & 0xff).unwrap_or(98),
            Err(_) => 99,
        }
    }

    /// Runs one network probe: 0 when it reached, 2 when refused, 7 when Winsock couldn't start
    /// (std panics then; the panic is caught and kept quiet).
    fn probe(check: impl FnOnce() -> bool + std::panic::UnwindSafe) -> u8 {
        std::panic::set_hook(Box::new(|_| {}));
        match std::panic::catch_unwind(check) {
            Ok(true) => 0,
            Ok(false) => 2,
            Err(_) => 7,
        }
    }

    /// Sends a DNS query for `example.com` to `server` over UDP and waits for any answer.
    fn udp_dns(server: &str) -> bool {
        let Ok(socket) = std::net::UdpSocket::bind(("0.0.0.0", 0)) else {
            return false;
        };
        let _ = socket.set_read_timeout(Some(Duration::from_secs(3)));
        // id 0x1234, recursion desired, one question: example.com A IN.
        let query: [u8; 29] = [
            0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 7, b'e', b'x', b'a', b'm', b'p', b'l', b'e',
            3, b'c', b'o', b'm', 0, 0, 1, 0, 1,
        ];
        if socket.send_to(&query, server).is_err() {
            return false;
        }
        let mut answer = [0u8; 512];
        socket.recv_from(&mut answer).is_ok()
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
