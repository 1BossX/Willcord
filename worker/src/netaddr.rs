//! Addresses of this machine that a browser or worker on the network could
//! use to reach the main node, ranked so the likeliest one comes first.
use std::net::Ipv4Addr;

#[derive(Debug, PartialEq)]
pub struct Candidate {
    pub interface: String,
    pub address: Ipv4Addr,
    /// The overlay network it belongs to, when it is one the person knows by name.
    pub overlay: Option<&'static str>,
}

/// Interfaces that exist only inside this host or between it and its virtual
/// machines: container and VM bridges and the like. `feth` is not here: on macOS
/// it is also what ZeroTier uses, and a ZeroTier address is a valid choice.
const VIRTUAL_PREFIXES: [&str; 12] = [
    "docker", "br-", "veth", "virbr", "cni", "flannel", "podman", "bridge", "vmnet", "vmenet",
    "vboxnet", "vnic",
];
/// Names of real network cards, which come before tunnels and the rest at the same rank.
const PHYSICAL_PREFIXES: [&str; 6] = ["en", "eth", "wl", "wlan", "ens", "eno"];

/// 198.18.0.0/15 is reserved for benchmarking; a proxy's virtual interface
/// (Clash, Surge, …) sits there and no other machine can reach it.
fn is_benchmark(address: Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    a == 198 && (b == 18 || b == 19)
}

fn is_physical(name: &str) -> bool {
    PHYSICAL_PREFIXES.iter().any(|p| name.starts_with(p))
}

fn in_cgnat(address: Ipv4Addr) -> bool {
    let [a, b, ..] = address.octets();
    a == 100 && (64..128).contains(&b)
}

/// Overlay networks a main node is often reached through. The name decides
/// where the system tells them apart (`tailscale0`, `wt0`, `zt…`, macOS's
/// `feth` pair); a macOS tunnel (`utun…`) in 100.64.0.0/10 is Tailscale's or
/// NetBird's default range, and nothing here can say which.
fn overlay_kind(name: &str, address: Ipv4Addr) -> Option<&'static str> {
    if name.starts_with("tailscale") {
        Some("Tailscale")
    } else if name.starts_with("wt") && name[2..].bytes().all(|b| b.is_ascii_digit()) {
        Some("NetBird")
    } else if name.starts_with("zt") || name.starts_with("feth") {
        Some("ZeroTier")
    } else if in_cgnat(address) {
        Some("Tailscale / NetBird")
    } else {
        None
    }
}

fn rank(address: Ipv4Addr) -> u8 {
    if address.is_private() {
        0
    } else if in_cgnat(address) {
        // Carrier-grade NAT space, which is also what Tailscale and NetBird hand out.
        1
    } else {
        2
    }
}

/// Drops addresses nobody else can reach, then orders private ranges first.
/// Equal ranks keep the order the system listed them in.
pub fn rank_candidates(found: Vec<(String, Ipv4Addr)>) -> Vec<Candidate> {
    let mut kept: Vec<Candidate> = found
        .into_iter()
        .filter(|(name, address)| {
            !address.is_loopback()
                && !address.is_link_local()
                && !address.is_unspecified()
                && !is_benchmark(*address)
                && !VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p))
        })
        .map(|(interface, address)| Candidate {
            overlay: overlay_kind(&interface, address),
            interface,
            address,
        })
        .collect();
    // Within a range a real card comes first, then overlay networks, then the rest.
    // A stable sort: equal keys keep the order the system listed them in.
    kept.sort_by_key(|c| {
        let class = if is_physical(&c.interface) {
            0
        } else if c.overlay.is_some() {
            1
        } else {
            2
        };
        (rank(c.address), class)
    });
    let mut seen = std::collections::HashSet::new();
    kept.retain(|c| seen.insert(c.address));
    kept
}

/// `name=address,name=address`, the form tests use instead of real interfaces.
#[cfg(debug_assertions)]
fn from_override(list: &str) -> Vec<(String, Ipv4Addr)> {
    list.split(',')
        .filter_map(|pair| {
            let (name, address) = pair.split_once('=')?;
            Some((name.to_string(), address.parse().ok()?))
        })
        .collect()
}

fn system_addresses() -> Vec<(String, Ipv4Addr)> {
    let mut found = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return found;
    }
    let mut cursor = list;
    while !cursor.is_null() {
        let entry = unsafe { &*cursor };
        cursor = entry.ifa_next;
        let up = entry.ifa_flags & libc::IFF_UP as u32 != 0;
        if !up || entry.ifa_addr.is_null() {
            continue;
        }
        if unsafe { (*entry.ifa_addr).sa_family } as i32 != libc::AF_INET {
            continue;
        }
        let socket = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
        let name = unsafe { std::ffi::CStr::from_ptr(entry.ifa_name) }
            .to_string_lossy()
            .into_owned();
        found.push((name, Ipv4Addr::from(u32::from_be(socket.sin_addr.s_addr))));
    }
    unsafe { libc::freeifaddrs(list) };
    found
}

pub fn candidates() -> Vec<Candidate> {
    #[cfg(debug_assertions)]
    if let Ok(list) = std::env::var("WILLCORD_TEST_ADDRS") {
        return rank_candidates(from_override(&list));
    }
    rank_candidates(system_addresses())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(pairs: &[(&str, &str)]) -> Vec<(String, Ipv4Addr)> {
        pairs
            .iter()
            .map(|(n, a)| (n.to_string(), a.parse().unwrap()))
            .collect()
    }

    #[test]
    fn private_ranges_come_before_cgnat_and_public() {
        let ranked = rank_candidates(found(&[
            ("eth1", "203.0.113.9"),
            ("tailscale0", "100.101.1.2"),
            ("en0", "192.168.1.5"),
            ("eth0", "10.0.0.7"),
            ("eth2", "172.16.4.1"),
        ]));
        let order: Vec<String> = ranked.iter().map(|c| c.address.to_string()).collect();
        assert_eq!(
            order,
            [
                "192.168.1.5",
                "10.0.0.7",
                "172.16.4.1",
                "100.101.1.2",
                "203.0.113.9"
            ]
        );
        assert_eq!(ranked[0].interface, "en0");
    }

    #[test]
    fn loopback_link_local_and_container_networks_are_dropped() {
        let ranked = rank_candidates(found(&[
            ("lo", "127.0.0.1"),
            ("en0", "169.254.7.7"),
            ("docker0", "172.17.0.1"),
            ("br-1a2b3c", "172.18.0.1"),
            ("veth9f", "10.200.0.1"),
            ("virbr0", "192.168.122.1"),
            ("en1", "192.168.1.5"),
        ]));
        assert_eq!(ranked.len(), 1);
        assert_eq!(
            ranked[0].address,
            "192.168.1.5".parse::<Ipv4Addr>().unwrap()
        );
    }

    #[test]
    fn vm_bridges_and_proxy_tunnels_are_dropped_but_overlay_networks_stay() {
        // Taken from a Mac running OrbStack, other VMs, a proxy's TUN device and
        // ZeroTier (feth), NetBird and Tailscale (utun).
        let ranked = rank_candidates(found(&[
            ("feth1832", "192.168.193.11"),
            ("en1", "192.168.30.113"),
            ("bridge100", "192.168.139.3"),
            ("bridge101", "192.168.117.0"),
            ("utun100", "100.90.36.151"),
            ("utun4", "100.99.69.60"),
            ("utun5", "198.18.0.1"),
        ]));
        let listed: Vec<(&str, Option<&str>)> = ranked
            .iter()
            .map(|c| (c.interface.as_str(), c.overlay))
            .collect();
        assert_eq!(
            listed,
            [
                ("en1", None),
                ("feth1832", Some("ZeroTier")),
                ("utun100", Some("Tailscale / NetBird")),
                ("utun4", Some("Tailscale / NetBird")),
            ]
        );
    }

    #[test]
    fn tailscale_zerotier_and_netbird_are_named_on_linux() {
        let ranked = rank_candidates(found(&[
            ("tailscale0", "100.101.1.2"),
            ("wt0", "100.64.7.9"),
            ("ztabcdefgh", "10.147.17.5"),
            ("eth0", "192.168.1.5"),
        ]));
        let listed: Vec<(&str, Option<&str>)> = ranked
            .iter()
            .map(|c| (c.interface.as_str(), c.overlay))
            .collect();
        assert_eq!(
            listed,
            [
                ("eth0", None),
                ("ztabcdefgh", Some("ZeroTier")),
                ("tailscale0", Some("Tailscale")),
                ("wt0", Some("NetBird")),
            ]
        );
    }

    #[test]
    fn only_a_digit_suffix_makes_wt_a_netbird_interface() {
        assert_eq!(
            overlay_kind("wt0", "100.64.0.1".parse().unwrap()),
            Some("NetBird")
        );
        assert_eq!(
            overlay_kind("wt", "10.0.0.1".parse().unwrap()),
            Some("NetBird")
        );
        assert_eq!(overlay_kind("wtf", "10.0.0.1".parse().unwrap()), None);
    }

    #[test]
    fn a_real_card_comes_before_another_interface_of_the_same_range() {
        let ranked = rank_candidates(found(&[("utun3", "10.8.0.2"), ("eth0", "10.0.0.7")]));
        assert_eq!(ranked[0].interface, "eth0");
    }

    #[test]
    fn an_address_on_two_interfaces_is_listed_once() {
        let ranked = rank_candidates(found(&[("en0", "10.0.0.7"), ("en1", "10.0.0.7")]));
        assert_eq!(ranked.len(), 1);
    }

    #[test]
    fn the_test_override_parses_pairs_and_skips_junk() {
        assert_eq!(
            from_override("en0=192.168.1.5,bad,x=nope,utun3=10.8.0.2"),
            found(&[("en0", "192.168.1.5"), ("utun3", "10.8.0.2")])
        );
    }

    #[test]
    fn this_machines_interfaces_can_be_listed() {
        // Whatever the host has, nothing unusable may come back.
        for c in rank_candidates(system_addresses()) {
            assert!(!c.address.is_loopback() && !c.address.is_link_local());
        }
    }
}
