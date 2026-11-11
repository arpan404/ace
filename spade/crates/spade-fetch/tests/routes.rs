//! On-link routes read from each operating system's routing table.

use std::net::IpAddr;

use spade_fetch::Network;
use spade_fetch::routes::{from_netsh, from_netstat, from_proc};

fn ip(text: &str) -> IpAddr {
    text.parse()
        .unwrap_or_else(|_| panic!("{text} is not an address"))
}

fn covers(networks: &[Network], text: &str) -> bool {
    networks.iter().any(|n| n.contains(ip(text)))
}

const NETSTAT: &str = "\
Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            link#28            UCSIg               utun4
0/1                link#28            UCSI                utun4
default            192.168.1.1        UGScg               en0
93.184.216/24      link#14            UCS                 en0
10/24              link#14            UCS                 en0
8.8.8.8/32         192.168.1.1        UGSc                en0
127                127.0.0.1          UCS                 lo0

Internet6:
Destination                             Gateway                                 Flags   Netif Expire
default                                 fe80::1%en0                             UGcg    en0
::/1                                    link#28                                 UCS     utun4
2a00:1450:4001::/64                     link#14                                 UC      en0
2a00:1450:4001::5                       a4:83:e7:00:00:01                       UHL     lo0
2606:4700::/32                          fe80::1%en0                             UGc     en0
fe80::%en0/64                           link#14                                 UCI     en0
";

#[test]
fn netstat_on_link_routes_are_read_and_gateway_and_wide_routes_are_not() {
    let nets = from_netstat(NETSTAT);
    assert!(covers(&nets, "93.184.216.200"));
    assert!(covers(&nets, "10.0.0.9"));
    assert!(covers(&nets, "2a00:1450:4001::99"));
    assert!(covers(&nets, "fe80::7"));
    assert!(!covers(&nets, "8.8.8.8"), "a gateway route is not on-link");
    assert!(
        !covers(&nets, "2606:4700::1"),
        "a gateway route is not on-link"
    );
    assert!(
        !covers(&nets, "1.1.1.1"),
        "a VPN's split default route is too wide"
    );
    assert!(!covers(&nets, "2001:4860::8888"), "::/1 is too wide");
}

#[test]
fn proc_on_link_routes_are_read_in_kernel_byte_order() {
    let ipv4 = "\
Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT
eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0
eth0\t00D8B85D\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0
eth0\t08080808\t0101A8C0\t0007\t0\t0\t100\tFFFFFFFF\t0\t0\t0
";
    let ipv6 = "\
2a001450400100000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000001 00000000 00000001 eth0
2a001450400100000000000000000005 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000002 00000000 80200001 lo
00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003 eth0
";
    let nets = from_proc(ipv4, ipv6);
    assert!(covers(&nets, "93.184.216.7"));
    assert!(!covers(&nets, "8.8.8.8"));
    assert!(covers(&nets, "2a00:1450:4001::99"));
    assert!(!covers(&nets, "2606:4700::1"));
}

#[test]
fn netsh_on_link_routes_are_the_ones_naming_an_interface() {
    let text = "\
Publish  Type      Met  Prefix                    Idx  Gateway/Interface Name
-------  --------  ---  ------------------------  ---  ------------------------
No       Manual    256  ::/0                       12  fe80::1
No       System    256  2a00:1450:4001::/64        12  Ethernet 2
No       Manual    256  2606:4700::/32             12  fe80::1
No       System    256  93.184.216.0/24            12  Wi-Fi
No       Manual    0    0.0.0.0/0                  12  192.168.1.1
";
    let nets = from_netsh(text);
    assert!(covers(&nets, "2a00:1450:4001::99"));
    assert!(covers(&nets, "93.184.216.9"));
    assert!(!covers(&nets, "2606:4700::1"));
    assert!(!covers(&nets, "8.8.8.8"));
}
