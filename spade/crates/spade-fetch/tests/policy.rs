//! Which addresses the default policy, and the loopback-allowing one, let Spade connect to.

use std::net::IpAddr;

use spade_fetch::Policy;

fn ip(text: &str) -> IpAddr {
    text.parse()
        .unwrap_or_else(|_| panic!("{text} is not an address"))
}

const REFUSED: &[&str] = &[
    "127.0.0.1",
    "127.255.0.9",
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "169.254.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "224.0.0.1",
    "239.255.255.250",
    "255.255.255.255",
    "240.0.0.1",
    "192.0.2.1",
    "198.18.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "febf::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::10.0.0.1",
    "2002:c0a8:0101::1", // 6to4 around 192.168.1.1
    "2001::1",           // Teredo
    "2001:db8::1",
];

const ALLOWED: &[&str] = &[
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "169.253.0.1",
    "192.169.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
];

#[test]
fn the_default_policy_refuses_local_private_and_special_addresses() {
    let policy = Policy::default();
    for text in REFUSED {
        assert!(!policy.allows(ip(text)), "{text} should be refused");
    }
}

#[test]
fn the_default_policy_allows_public_addresses() {
    let policy = Policy::default();
    for text in ALLOWED {
        assert!(policy.allows(ip(text)), "{text} should be allowed");
    }
}

#[test]
fn allowing_loopback_opens_loopback_and_nothing_else() {
    let policy = Policy::allowing_loopback();
    for text in ["127.0.0.1", "127.8.8.8", "::1", "::ffff:127.0.0.1"] {
        assert!(policy.allows(ip(text)), "{text} should be allowed");
    }
    for text in [
        "10.0.0.1",
        "192.168.0.1",
        "169.254.169.254",
        "fe80::1",
        "0.0.0.0",
        "::",
    ] {
        assert!(!policy.allows(ip(text)), "{text} should still be refused");
    }
}

#[test]
fn the_nat64_local_use_prefix_is_refused_whatever_it_carries() {
    let policy = Policy::default();
    for text in [
        "64:ff9b:1::a00:1",
        "64:ff9b:1::808:808",
        "64:ff9b:1:ffff::1",
    ] {
        assert!(!policy.allows(ip(text)), "{text} should be refused");
    }
}

#[test]
fn an_interface_network_holds_its_own_address_and_its_link_only() {
    use spade_fetch::Network;
    let laptop = Network {
        addr: ip("2a00:1450:4001::5"),
        prefix: 64,
    };
    assert!(laptop.contains(ip("2a00:1450:4001::5")));
    assert!(laptop.contains(ip("2a00:1450:4001::ffff")));
    assert!(!laptop.contains(ip("2a00:1450:4002::5")));
    let office = Network {
        addr: ip("93.184.216.34"),
        prefix: 24,
    };
    assert!(office.contains(ip("::ffff:93.184.216.1")));
    assert!(!office.contains(ip("93.184.217.1")));
    let everything = Network {
        addr: ip("8.8.8.8"),
        prefix: 0,
    };
    assert!(everything.contains(ip("8.8.8.8")));
    assert!(!everything.contains(ip("1.1.1.1")));
}
