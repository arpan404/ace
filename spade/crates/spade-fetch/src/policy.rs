//! Which addresses Spade may connect to. Pages are untrusted and may try to steer the agent at the
//! person's own machine, their network or a cloud metadata service, so only public addresses are
//! allowed unless the policy says otherwise.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// What [`crate::Fetcher`] may connect to. The default allows public addresses only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Policy {
    /// Allow 127.0.0.0/8 and ::1. Tests use this to fetch from a local server.
    pub allow_loopback: bool,
}

impl Policy {
    /// Public addresses and loopback.
    #[must_use]
    pub fn allowing_loopback() -> Self {
        Self {
            allow_loopback: true,
        }
    }

    /// Whether Spade may connect to `ip`.
    #[must_use]
    pub fn allows(&self, ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(v4) => self.allows_v4(v4),
            IpAddr::V6(v6) => self.allows_v6(v6),
        }
    }

    fn allows_v4(&self, ip: Ipv4Addr) -> bool {
        if ip.is_loopback() {
            return self.allow_loopback;
        }
        let [a, b, c, _] = ip.octets();
        let blocked = a == 0 // "this network", including 0.0.0.0
            || a == 10
            || (a == 100 && (64..=127).contains(&b)) // CGNAT 100.64.0.0/10
            || (a == 169 && b == 254) // link-local, cloud metadata
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 168)
            || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
            || (a == 192 && b == 0 && c == 2) // documentation
            || (a == 198 && (b == 18 || b == 19)) // benchmarking
            || (a == 198 && b == 51 && c == 100) // documentation
            || (a == 203 && b == 0 && c == 113) // documentation
            || a >= 224; // multicast, reserved and broadcast
        !blocked
    }

    fn allows_v6(&self, ip: Ipv6Addr) -> bool {
        if ip.is_loopback() {
            return self.allow_loopback;
        }
        if let Some(v4) = embedded_v4(ip) {
            return self.allows_v4(v4);
        }
        let s = ip.segments();
        let blocked = ip.is_unspecified()
            || (s[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
            || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
            || (s[0] & 0xffc0) == 0xfec0 // old site-local fec0::/10
            || (s[0] & 0xff00) == 0xff00 // multicast
            || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
            || (s[0] == 0x2001 && s[1] == 0) // Teredo hides an IPv4 address
            || (s[0] == 0x0100 && s[1..4] == [0, 0, 0]) // discard 100::/64
            || s[..6] == [0; 6]; // the rest of ::/96 (old IPv4-compatible form)
        !blocked
    }
}

/// The IPv4 address carried inside an IPv6 one: IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible
/// (`::a.b.c.d`), NAT64 (`64:ff9b::a.b.c.d`) and 6to4 (`2002:aabb:ccdd::`).
fn embedded_v4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    let tail = |hi: u16, lo: u16| {
        let [a, b] = hi.to_be_bytes();
        let [c, d] = lo.to_be_bytes();
        Ipv4Addr::new(a, b, c, d)
    };
    if s[..5] == [0; 5] && (s[5] == 0xffff || (s[5] == 0 && (s[6] != 0 || s[7] > 1))) {
        return Some(tail(s[6], s[7]));
    }
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        return Some(tail(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return Some(tail(s[1], s[2]));
    }
    None
}
