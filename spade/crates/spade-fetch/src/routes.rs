//! On-link routes from the routing table. An address can sit on a /128 with its /64 on-link only
//! through a route (RFC 5942), so the interface list alone misses the person's own network.
//!
//! The parsers are pure: each takes the text an operating system gives and returns the routes
//! that reach their destination directly, without a gateway. Very wide ones (shorter than /16 for
//! IPv4 or /32 for IPv6, such as a VPN's split default routes) are left out, as they would refuse
//! every address.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::process::Command;

use crate::local::Network;

const NARROWEST_V4: u8 = 16;
const NARROWEST_V6: u8 = 32;

/// The on-link networks in a list of routes, as `(network, has_gateway)`.
fn on_link(routes: impl IntoIterator<Item = (Network, bool)>) -> Vec<Network> {
    routes
        .into_iter()
        .filter(|(net, gateway)| {
            let narrowest = if net.addr.is_ipv4() {
                NARROWEST_V4
            } else {
                NARROWEST_V6
            };
            !gateway && net.prefix >= narrowest
        })
        .map(|(net, _)| net)
        .collect()
}

/// Linux: `/proc/net/route` (IPv4) and `/proc/net/ipv6_route`.
#[must_use]
pub fn from_proc(ipv4: &str, ipv6: &str) -> Vec<Network> {
    const UP: u32 = 0x1;
    const GATEWAY: u32 = 0x2;
    let v4 = ipv4.lines().skip(1).filter_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let dest = u32::from_str_radix(f.get(1)?, 16).ok()?;
        let flags = u32::from_str_radix(f.get(3)?, 16).ok()?;
        let mask = u32::from_str_radix(f.get(7)?, 16).ok()?;
        (flags & UP != 0).then_some(())?;
        // The table is in the kernel's byte order, little-endian on every Linux Spade runs on.
        let addr = Ipv4Addr::from(dest.swap_bytes());
        let prefix = u8::try_from(mask.swap_bytes().leading_ones()).ok()?;
        Some((
            Network {
                addr: IpAddr::V4(addr),
                prefix,
            },
            flags & GATEWAY != 0,
        ))
    });
    let v6 = ipv6.lines().filter_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let dest = u128::from_str_radix(f.first()?, 16).ok()?;
        let prefix = u8::from_str_radix(f.get(1)?, 16).ok()?;
        let flags = u32::from_str_radix(f.get(8)?, 16).ok()?;
        (flags & UP != 0).then_some(())?;
        Some((
            Network {
                addr: IpAddr::V6(Ipv6Addr::from(dest)),
                prefix,
            },
            flags & GATEWAY != 0,
        ))
    });
    on_link(v4.chain(v6).collect::<Vec<_>>())
}

/// macOS and the BSDs: `netstat -rn`.
#[must_use]
pub fn from_netstat(text: &str) -> Vec<Network> {
    on_link(text.lines().filter_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let flags = f.get(2)?;
        let net = netstat_destination(f.first()?)?;
        Some((net, flags.contains('G')))
    }))
}

/// A `netstat` destination: `2a00:1450::/64`, `fe80::%en0/64`, a host address, or IPv4 written
/// short (`192.168.1` for 192.168.1.0/24, `10/8`).
fn netstat_destination(text: &str) -> Option<Network> {
    let (addr, prefix) = match text.split_once('/') {
        Some((a, p)) => (a, Some(p.parse::<u8>().ok()?)),
        None => (text, None),
    };
    let addr = addr.split('%').next()?;
    if addr.contains(':') {
        let ip: Ipv6Addr = addr.parse().ok()?;
        return Some(Network {
            addr: IpAddr::V6(ip),
            prefix: prefix.unwrap_or(128),
        });
    }
    let parts: Vec<u8> = addr
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut octets = [0u8; 4];
    octets[..parts.len()].copy_from_slice(&parts);
    let given = u8::try_from(parts.len()).ok()? * 8;
    Some(Network {
        addr: IpAddr::V4(Ipv4Addr::from(octets)),
        prefix: prefix.unwrap_or(given),
    })
}

/// Windows: `netsh interface ipv4 show route` and `... ipv6 show route`. The last column is a
/// gateway address, or an interface name when the route is on-link.
#[must_use]
pub fn from_netsh(text: &str) -> Vec<Network> {
    on_link(text.lines().filter_map(|line| {
        let f: Vec<&str> = line.split_whitespace().collect();
        let (addr, prefix) = f.get(3)?.split_once('/')?;
        let net = Network {
            addr: addr.parse().ok()?,
            prefix: prefix.parse().ok()?,
        };
        let gateway = f.get(5..)?.join(" ").parse::<IpAddr>().is_ok();
        Some((net, gateway))
    }))
}

/// This machine's on-link routes. Any failure to read the table is an error.
pub fn read() -> io::Result<Vec<Network>> {
    if cfg!(target_os = "linux") || cfg!(target_os = "android") {
        let ipv4 = std::fs::read_to_string("/proc/net/route")?;
        // A kernel without IPv6 has no IPv6 routes to miss.
        let ipv6 = match std::fs::read_to_string("/proc/net/ipv6_route") {
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            other => other?,
        };
        Ok(from_proc(&ipv4, &ipv6))
    } else if cfg!(windows) {
        let netsh = std::env::var_os("SystemRoot")
            .map(|root| {
                std::path::PathBuf::from(root)
                    .join("System32")
                    .join("netsh.exe")
            })
            .ok_or_else(|| io::Error::other("SystemRoot is not set"))?;
        let mut routes = Vec::new();
        for family in ["ipv4", "ipv6"] {
            let text = run(Command::new(&netsh).args(["interface", family, "show", "route"]))?;
            routes.extend(from_netsh(&text));
        }
        Ok(routes)
    } else {
        Ok(from_netstat(&run(
            Command::new("/usr/sbin/netstat").arg("-rn")
        )?))
    }
}

fn run(command: &mut Command) -> io::Result<String> {
    let output = command.output()?;
    if !output.status.success() {
        return Err(io::Error::other("the routing table could not be read"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}
