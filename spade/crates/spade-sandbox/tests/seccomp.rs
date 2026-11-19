//! The network, other processes and the kernel under Linux's sandbox (ADR 0167 decision 1): its
//! seccomp filter and supervisor, with real commands. Each refusal is checked against the same
//! command outside the sandbox where that one works, so a test can't pass for another reason.
#![cfg(all(target_os = "linux", feature = "landlock"))]

mod linux;

use std::io::{Read, Write};
use std::net::{TcpListener, UdpSocket};

use linux::{has, ok, policy, quoted, refused, unconfined, world};

/// A listener on `address` that answers each connection with `ok`, outside the sandbox.
fn listener(address: &str) -> u16 {
    let socket = TcpListener::bind(address).unwrap_or_else(|_| std::process::abort());
    let port = socket.local_addr().map(|a| a.port()).unwrap_or(0);
    std::thread::spawn(move || {
        for mut stream in socket.incoming().flatten() {
            let mut buffer = [0u8; 1024];
            let _ = stream.read(&mut buffer);
            let _ = stream.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
        }
    });
    port
}

/// This machine's address on its network (no packet is sent to learn it).
fn own_address() -> Option<std::net::IpAddr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("192.0.2.1:9").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then_some(ip)
}

fn python(code: &str) -> String {
    format!("python3 -c '{code}'")
}

#[test]
fn tcp_reaches_only_the_proxys_port_on_loopback() {
    let world = world();
    // Listening on every interface, so the same port is reachable at this machine's address.
    let proxy = listener("0.0.0.0:0");
    let other = listener("127.0.0.1:0");
    let policy = policy(&world, Some(proxy));
    assert_eq!(
        ok(&policy, &format!("curl -sS -m 5 http://127.0.0.1:{proxy}/")),
        "ok"
    );
    assert_eq!(
        ok(
            &policy,
            &format!("curl -sS -m 5 -g 'http://[::1]:{proxy}/'")
        ),
        "ok"
    );
    refused(&policy, &format!("curl -sS -m 5 http://127.0.0.1:{other}/"));
    // The proxy's port at another address: Landlock's port rule alone would let this through.
    if let Some(ip) = own_address() {
        let url = format!("http://{ip}:{proxy}/");
        assert_eq!(
            unconfined(&world.root, &format!("curl -sS -m 5 {url}")).0,
            0
        );
        refused(&policy, &format!("curl -sS -m 5 {url}"));
    }
    let offline = linux::policy(&world, None);
    refused(
        &offline,
        &format!("curl -sS -m 5 http://127.0.0.1:{proxy}/"),
    );
}

#[test]
fn no_names_resolve_and_no_udp_raw_packet_or_netlink_socket_opens() {
    let world = world();
    let policy = policy(&world, None);
    let text = refused(&policy, "curl -sS -m 5 https://example.com/");
    assert!(text.contains("Could not resolve host"), "{text}");
    refused(&policy, "getent hosts example.com");
    for (family, kind) in [
        ("AF_INET", "SOCK_DGRAM"),
        ("AF_INET6", "SOCK_DGRAM"),
        ("AF_NETLINK", "SOCK_RAW"),
        ("AF_UNIX", "SOCK_DGRAM"),
    ] {
        let code = python(&format!(
            "import socket; socket.socket(socket.{family}, socket.{kind})"
        ));
        // Each opens outside the sandbox.
        assert_eq!(unconfined(&world.root, &code).0, 0, "{family} {kind}");
        let text = refused(&policy, &code);
        assert!(
            text.contains("Operation not permitted"),
            "{family} {kind}: {text}"
        );
    }
    for (family, kind) in [("AF_INET", "SOCK_RAW"), ("AF_PACKET", "SOCK_RAW")] {
        let code = python(&format!(
            "import socket; socket.socket(socket.{family}, socket.{kind}, 0)"
        ));
        refused(&policy, &code);
    }
    // A Unix datagram pair could send to any socket by path.
    refused(
        &policy,
        &python("import socket; socket.socketpair(socket.AF_UNIX, socket.SOCK_DGRAM)"),
    );
    ok(
        &policy,
        &python("import socket; socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)"),
    );
}

#[test]
fn a_dev_server_listens_on_loopback_only() {
    let world = world();
    let policy = policy(&world, None);
    let port = ok(
        &policy,
        &python(
            "import socket; s=socket.socket(); s.bind((\"127.0.0.1\", 0)); s.listen(1); \
             print(s.getsockname()[1])",
        ),
    );
    assert!(port.trim().parse::<u16>().is_ok_and(|p| p > 0), "{port}");
    refused(
        &policy,
        &python("import socket; s=socket.socket(); s.bind((\"0.0.0.0\", 0))"),
    );
    // Unbound, `listen` would bind every interface.
    refused(
        &policy,
        &python("import socket; s=socket.socket(); s.listen(1)"),
    );
}

#[test]
fn unix_sockets_are_reached_only_in_the_workspace() {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::net::{SocketAddr, UnixListener};

    let world = world();
    let policy = policy(&world, None);
    let inside = UnixListener::bind(world.workspace.join("db.sock"));
    let outside = UnixListener::bind(world.root.join("outside.sock"));
    let name = format!("spade-test-{}", std::process::id());
    let abstract_ = SocketAddr::from_abstract_name(name.as_bytes())
        .and_then(|address| UnixListener::bind_addr(&address));
    assert!(inside.is_ok() && outside.is_ok() && abstract_.is_ok());
    let connect = |target: &str| {
        python(&format!(
            "import socket; socket.socket(socket.AF_UNIX).connect({target})"
        ))
    };
    ok(&policy, &connect("\"db.sock\""));
    let outside_path = format!("\"{}\"", world.root.join("outside.sock").display());
    assert_eq!(unconfined(&world.root, &connect(&outside_path)).0, 0);
    refused(&policy, &connect(&outside_path));
    let abstract_path = format!("\"\\0{name}\"");
    assert_eq!(unconfined(&world.root, &connect(&abstract_path)).0, 0);
    refused(&policy, &connect(&abstract_path));
    // A link in the workspace to a socket outside it isn't followed.
    let _ = std::os::unix::fs::symlink(
        world.root.join("outside.sock"),
        world.workspace.join("link.sock"),
    );
    refused(&policy, &connect("\"link.sock\""));
    // A server in the workspace binds its own socket there, and nowhere else.
    ok(
        &policy,
        &python(
            "import socket; s=socket.socket(socket.AF_UNIX); s.bind(\"run.sock\"); s.listen(1)",
        ),
    );
    assert!(world.workspace.join("run.sock").exists());
    refused(
        &policy,
        &python(&format!(
            "import socket; socket.socket(socket.AF_UNIX).bind(\"{}\")",
            world.root.join("planted.sock").display()
        )),
    );
}

#[test]
fn a_session_bus_is_refused() {
    if !has("dbus-daemon") || !has("dbus-send") {
        eprintln!("dbus-daemon and dbus-send aren't installed: skipped");
        return;
    }
    let world = world();
    let policy = policy(&world, None);
    for address in [
        format!("unix:path={}", world.root.join("bus").display()),
        format!("unix:abstract=spade-test-bus-{}", std::process::id()),
    ] {
        let config = world.root.join("session.conf");
        std::fs::write(
            &config,
            format!(
                "<busconfig><type>session</type><listen>{address}</listen>\
                 <policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/>\
                 <allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>"
            ),
        )
        .unwrap_or_default();
        let mut daemon = std::process::Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address"])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap_or_else(|error| panic!("{error}"));
        // It prints its address once it listens.
        let mut line = String::new();
        if let Some(out) = daemon.stdout.as_mut() {
            let mut byte = [0u8; 1];
            while out.read(&mut byte).unwrap_or(0) == 1 && byte[0] != b'\n' {
                line.push(char::from(byte[0]));
            }
        }
        let send = format!(
            "dbus-send --bus='{line}' --print-reply --dest=org.freedesktop.DBus / \
             org.freedesktop.DBus.ListNames"
        );
        let (code, text) = unconfined(&world.root, &send);
        assert_eq!(code, 0, "the bus answers outside the sandbox: {text}");
        refused(&policy, &send);
        let _ = daemon.kill();
        let _ = daemon.wait();
    }
    // Nothing a desktop would open apps through is in the environment either.
    let env = ok(&policy, "env");
    for name in [
        "DBUS_SESSION_BUS_ADDRESS",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
    ] {
        assert!(!env.contains(name), "{name} in {env}");
    }
}

#[test]
fn tracing_namespaces_mounts_and_typing_into_the_terminal_are_refused() {
    let world = world();
    let policy = policy(&world, None);
    let errno = |call: &str| {
        python(&format!(
            "import ctypes, os; c = ctypes.CDLL(None, use_errno=True); r = {call}; \
             print(r, ctypes.get_errno())"
        ))
    };
    // PTRACE_TRACEME works outside, so the refusal is the sandbox's.
    let trace = errno("c.ptrace(0, 0, 0, 0)");
    assert!(unconfined(&world.root, &trace).1.starts_with("0 "));
    assert_eq!(ok(&policy, &trace).trim(), "-1 1");
    // A user namespace opens outside; inside, unshare and clone's namespace flags are refused.
    if unconfined(&world.root, "unshare --user true").0 == 0 {
        refused(&policy, "unshare --user true");
    }
    assert_eq!(ok(&policy, &errno("c.unshare(0x10000000)")).trim(), "-1 1");
    for call in [
        "c.mount(b\"none\", b\"x\", b\"tmpfs\", 0, None)",
        "c.syscall(430, b\"tmpfs\", 0)",
        "c.syscall(425, 1, None)",
    ] {
        // `mount`, `fsopen` and `io_uring_setup`.
        assert_eq!(ok(&policy, &errno(call)).trim(), "-1 1", "{call}");
    }
    // TIOCSTI on a descriptor that isn't a terminal is ENOTTY outside: EPERM is the filter.
    let tiocsti = errno("c.ioctl(0, 0x5412, ctypes.c_char_p(b\"x\"))");
    assert!(unconfined(&world.root, &tiocsti).1.trim().ends_with(" 25"));
    assert_eq!(ok(&policy, &tiocsti).trim(), "-1 1");
}

#[test]
fn processes_outside_the_sandbox_cant_be_read() {
    let world = world();
    let policy = policy(&world, None);
    let me = std::process::id();
    // This test's own process: its environment and memory are outside the sandbox.
    refused(&policy, &format!("cat /proc/{me}/environ"));
    refused(&policy, &format!("head -c 1 /proc/{me}/mem"));
    // Where its files and folder are (the kernel lets the numbers be listed, not followed).
    refused(&policy, &format!("readlink /proc/{me}/cwd"));
    refused(&policy, &format!("readlink /proc/{me}/fd/0"));
    let file = world.root.join("victim.txt");
    refused(
        &policy,
        &format!("cat /proc/{me}/root{}", quoted(&file).replace('\'', "")),
    );
}
