//! This machine's own networks. A public address can still be the person's own laptop (its global
//! IPv6 address, say) or a neighbour on their network, so every destination is also checked
//! against the machine's interface addresses and their on-link prefixes.

use std::io;
use std::net::IpAddr;

/// One interface address and its prefix length, such as `2a00:1450::5/64`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Network {
    pub addr: IpAddr,
    pub prefix: u8,
}

impl Network {
    /// Whether `ip` is this address or on its link.
    #[must_use]
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr.to_canonical(), ip.to_canonical()) {
            (IpAddr::V4(net), IpAddr::V4(ip)) => same_prefix(
                u128::from(net.to_bits()),
                u128::from(ip.to_bits()),
                self.prefix,
                32,
            ),
            (IpAddr::V6(net), IpAddr::V6(ip)) => {
                same_prefix(net.to_bits(), ip.to_bits(), self.prefix, 128)
            }
            _ => false,
        }
    }
}

fn same_prefix(a: u128, b: u128, prefix: u8, width: u32) -> bool {
    let prefix = u32::from(prefix).min(width);
    if prefix == 0 {
        // A zero-length prefix would cover every address; keep just the address itself.
        return a == b;
    }
    let shift = width - prefix;
    (a >> shift) == (b >> shift)
}

/// Reads the machine's networks. Injected so tests can supply their own.
pub trait LocalNetworks: Send + Sync {
    fn networks(&self) -> io::Result<Vec<Network>>;
}

/// The operating system's interface list.
pub struct SystemNetworks;

impl LocalNetworks for SystemNetworks {
    fn networks(&self) -> io::Result<Vec<Network>> {
        Ok(if_addrs::get_if_addrs()?
            .into_iter()
            .map(|interface| match interface.addr {
                if_addrs::IfAddr::V4(v4) => Network {
                    addr: IpAddr::V4(v4.ip),
                    prefix: mask_len(u128::from(v4.netmask.to_bits()) << 96),
                },
                if_addrs::IfAddr::V6(v6) => Network {
                    addr: IpAddr::V6(v6.ip),
                    prefix: mask_len(v6.netmask.to_bits()),
                },
            })
            .collect())
    }
}

/// The prefix length of a left-aligned netmask.
fn mask_len(mask: u128) -> u8 {
    u8::try_from(mask.leading_ones()).unwrap_or(128)
}
