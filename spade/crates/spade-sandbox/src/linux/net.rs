//! What Linux's network filter lets a sandboxed `connect`, `bind` or `listen` do (ADR 0167
//! decision 1). Pure: the supervisor reads the address the command passed, as raw `sockaddr`
//! bytes, and this decides what the supervisor does on the command's socket itself. The
//! supervisor never continues the command's own call, so a thread that rewrites the address after
//! it was read changes nothing: the socket is connected or bound to the address decided here.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::path::{Component, Path, PathBuf};

const AF_UNSPEC: u16 = 0;
const AF_UNIX: u16 = 1;
const AF_INET: u16 = 2;
const AF_INET6: u16 = 10;

/// The longest `sockaddr` the supervisor reads (`sockaddr_un` is 110 bytes).
pub const MAX_ADDRESS: usize = 128;

/// What the call is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Call {
    Connect,
    Bind,
}

/// What a run may reach.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rules {
    /// The egress proxy's port on loopback: the one place a run may connect to over TCP.
    pub proxy_port: Option<u16>,
    /// Where Unix sockets may be: the bot's workspace.
    pub sockets: PathBuf,
}

/// What the supervisor does for one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Connect the socket to the proxy: `127.0.0.1:<port>`, as `::ffff:127.0.0.1` on an IPv6
    /// socket.
    Proxy {
        v6: bool,
    },
    /// Bind the socket to this loopback address (a dev server).
    Loopback(SocketAddr),
    /// Connect or bind to the Unix socket at this place in the workspace (absolute, without
    /// `.` or `..`). The supervisor opens it without following links.
    Unix(PathBuf),
    /// Dissolve the socket's association (`connect` with `AF_UNSPEC`).
    Unspec,
    Deny,
}

/// The verdict for `call` with the address `bytes`, made by a thread whose working folder is
/// `cwd` (for a relative Unix socket path).
pub fn decide(call: Call, bytes: &[u8], cwd: &Path, rules: &Rules) -> Verdict {
    let Some(family) = bytes.get(..2).map(|b| u16::from_ne_bytes([b[0], b[1]])) else {
        return Verdict::Deny;
    };
    match (family, call) {
        (AF_INET, _) => inet(call, bytes, rules),
        (AF_INET6, _) => inet6(call, bytes, rules),
        (AF_UNIX, _) => unix(bytes, cwd, rules),
        // Binding `AF_UNSPEC` is read as `0.0.0.0` by the kernel: every interface.
        (AF_UNSPEC, Call::Connect) => Verdict::Unspec,
        _ => Verdict::Deny,
    }
}

fn port(bytes: &[u8]) -> Option<u16> {
    bytes.get(2..4).map(|b| u16::from_be_bytes([b[0], b[1]]))
}

fn inet(call: Call, bytes: &[u8], rules: &Rules) -> Verdict {
    let (Some(port), Some(ip)) = (port(bytes), bytes.get(4..8)) else {
        return Verdict::Deny;
    };
    let ip = Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3]);
    match call {
        Call::Connect if ip == Ipv4Addr::LOCALHOST && Some(port) == rules.proxy_port => {
            Verdict::Proxy { v6: false }
        }
        Call::Bind if ip.is_loopback() => Verdict::Loopback(SocketAddrV4::new(ip, port).into()),
        _ => Verdict::Deny,
    }
}

fn inet6(call: Call, bytes: &[u8], rules: &Rules) -> Verdict {
    // `sockaddr_in6` may be given without its scope (the kernel accepts 24 bytes).
    let (Some(port), Some(ip)) = (port(bytes), bytes.get(8..24)) else {
        return Verdict::Deny;
    };
    let mut octets = [0u8; 16];
    octets.copy_from_slice(ip);
    let ip = Ipv6Addr::from(octets);
    let mapped = ip.to_ipv4_mapped();
    match call {
        Call::Connect
            if (ip == Ipv6Addr::LOCALHOST || mapped == Some(Ipv4Addr::LOCALHOST))
                && Some(port) == rules.proxy_port =>
        {
            Verdict::Proxy { v6: true }
        }
        Call::Bind if ip == Ipv6Addr::LOCALHOST || mapped.is_some_and(|v4| v4.is_loopback()) => {
            Verdict::Loopback(SocketAddrV6::new(ip, port, 0, 0).into())
        }
        _ => Verdict::Deny,
    }
}

fn unix(bytes: &[u8], cwd: &Path, rules: &Rules) -> Verdict {
    use std::os::unix::ffi::OsStrExt;

    let path = &bytes[2..];
    // No path: an unnamed (autobound) socket; a leading NUL: the abstract namespace, where the
    // display server and some session buses listen. Neither is a place in the workspace.
    if path.first().is_none_or(|b| *b == 0) {
        return Verdict::Deny;
    }
    let end = path.iter().position(|b| *b == 0).unwrap_or(path.len());
    let path = Path::new(std::ffi::OsStr::from_bytes(&path[..end]));
    let absolute = lexical(&cwd.join(path));
    if absolute.starts_with(&rules.sockets) && absolute != rules.sockets {
        Verdict::Unix(absolute)
    } else {
        Verdict::Deny
    }
}

/// `path` without `.` and with `..` folded, without touching the file system.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Whether a socket bound to `local` may listen: only on loopback, at a port it was given. An
/// unbound TCP socket that listens is bound by the kernel to every interface, so it may not.
pub fn may_listen(local: Option<SocketAddr>, unix: bool) -> bool {
    match local {
        Some(SocketAddr::V4(addr)) => addr.ip().is_loopback() && addr.port() != 0,
        Some(SocketAddr::V6(addr)) => {
            let ip = addr.ip();
            let loopback = *ip == Ipv6Addr::LOCALHOST
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback());
            loopback && addr.port() != 0
        }
        // A Unix socket can only have been bound in the workspace.
        None => unix,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules() -> Rules {
        Rules {
            proxy_port: Some(4100),
            sockets: PathBuf::from("/h/spade/workspace/b1"),
        }
    }

    fn v4(ip: [u8; 4], port: u16) -> Vec<u8> {
        let mut out = AF_INET.to_ne_bytes().to_vec();
        out.extend(port.to_be_bytes());
        out.extend(ip);
        out.extend([0u8; 8]);
        out
    }

    fn v6(ip: Ipv6Addr, port: u16) -> Vec<u8> {
        let mut out = AF_INET6.to_ne_bytes().to_vec();
        out.extend(port.to_be_bytes());
        out.extend([0u8; 4]);
        out.extend(ip.octets());
        out.extend([0u8; 4]);
        out
    }

    fn unix_at(path: &[u8]) -> Vec<u8> {
        let mut out = AF_UNIX.to_ne_bytes().to_vec();
        out.extend(path);
        out
    }

    fn connect(bytes: &[u8]) -> Verdict {
        decide(
            Call::Connect,
            bytes,
            Path::new("/h/spade/workspace/b1"),
            &rules(),
        )
    }

    fn bind(bytes: &[u8]) -> Verdict {
        decide(
            Call::Bind,
            bytes,
            Path::new("/h/spade/workspace/b1/sub"),
            &rules(),
        )
    }

    #[test]
    fn tcp_reaches_only_the_proxys_port_on_loopback() {
        assert_eq!(
            connect(&v4([127, 0, 0, 1], 4100)),
            Verdict::Proxy { v6: false }
        );
        assert_eq!(
            connect(&v6(Ipv6Addr::LOCALHOST, 4100)),
            Verdict::Proxy { v6: true }
        );
        let mapped = Ipv4Addr::LOCALHOST.to_ipv6_mapped();
        assert_eq!(connect(&v6(mapped, 4100)), Verdict::Proxy { v6: true });
        for refused in [
            v4([127, 0, 0, 1], 4101),
            v4([127, 0, 0, 2], 4100),
            v4([93, 184, 216, 34], 4100),
            v4([10, 0, 0, 5], 4100),
            v4([0, 0, 0, 0], 4100),
            v6(Ipv6Addr::LOCALHOST, 53),
            v6(
                "2606:4700::1".parse().unwrap_or(Ipv6Addr::UNSPECIFIED),
                4100,
            ),
            v6(Ipv4Addr::new(1, 1, 1, 1).to_ipv6_mapped(), 4100),
        ] {
            assert_eq!(connect(&refused), Verdict::Deny, "{refused:?}");
        }
    }

    #[test]
    fn with_no_proxy_nothing_is_reached() {
        let offline = Rules {
            proxy_port: None,
            ..rules()
        };
        let cwd = Path::new("/");
        assert_eq!(
            decide(Call::Connect, &v4([127, 0, 0, 1], 4100), cwd, &offline),
            Verdict::Deny
        );
    }

    #[test]
    fn a_dev_server_binds_on_loopback_only() {
        assert_eq!(
            bind(&v4([127, 0, 0, 1], 3000)),
            Verdict::Loopback("127.0.0.1:3000".parse().unwrap_or_else(|_| unreachable!()))
        );
        assert!(matches!(
            bind(&v6(Ipv6Addr::LOCALHOST, 0)),
            Verdict::Loopback(_)
        ));
        assert_eq!(bind(&v4([0, 0, 0, 0], 3000)), Verdict::Deny);
        assert_eq!(bind(&v4([192, 168, 1, 4], 3000)), Verdict::Deny);
        assert_eq!(bind(&v6(Ipv6Addr::UNSPECIFIED, 3000)), Verdict::Deny);
        // `AF_UNSPEC` binds every interface.
        assert_eq!(bind(&AF_UNSPEC.to_ne_bytes()), Verdict::Deny);
        // ...but connecting with it only dissolves an association.
        assert_eq!(connect(&AF_UNSPEC.to_ne_bytes()), Verdict::Unspec);
    }

    #[test]
    fn unix_sockets_are_reached_only_inside_the_workspace() {
        assert_eq!(
            connect(&unix_at(b"/h/spade/workspace/b1/db.sock\0")),
            Verdict::Unix(PathBuf::from("/h/spade/workspace/b1/db.sock"))
        );
        // Relative to the calling thread's folder, `..` folded before it is judged.
        assert_eq!(
            bind(&unix_at(b"../run/x.sock")),
            Verdict::Unix(PathBuf::from("/h/spade/workspace/b1/run/x.sock"))
        );
        for refused in [
            &b"/run/user/1000/bus"[..],
            b"/tmp/.X11-unix/X0",
            b"/h/spade/workspace/b1/../b2/x.sock",
            b"/h/spade/workspace/b10/x.sock",
            b"../../b2/x.sock",
            b"/h/spade/workspace/b1",
            // The abstract namespace (the display server's and some session buses' sockets).
            b"\0/tmp/.X11-unix/X0",
            b"",
        ] {
            assert_eq!(connect(&unix_at(refused)), Verdict::Deny, "{refused:?}");
        }
    }

    #[test]
    fn other_families_and_short_addresses_are_refused() {
        // AF_NETLINK, AF_PACKET, AF_BLUETOOTH.
        for family in [16u16, 17, 31] {
            let mut bytes = family.to_ne_bytes().to_vec();
            bytes.extend([0u8; 14]);
            assert_eq!(connect(&bytes), Verdict::Deny);
        }
        assert_eq!(connect(&[2]), Verdict::Deny);
        assert_eq!(connect(&v4([127, 0, 0, 1], 4100)[..6]), Verdict::Deny);
    }

    #[test]
    fn only_a_socket_bound_on_loopback_listens() {
        let at = |text: &str| text.parse::<SocketAddr>().ok();
        assert!(may_listen(at("127.0.0.1:3000"), false));
        assert!(may_listen(at("[::1]:3000"), false));
        assert!(!may_listen(at("0.0.0.0:3000"), false));
        // Unbound: the kernel would bind it to every interface.
        assert!(!may_listen(at("0.0.0.0:0"), false));
        assert!(!may_listen(at("[::]:0"), false));
        assert!(may_listen(None, true));
        assert!(!may_listen(None, false));
    }
}
