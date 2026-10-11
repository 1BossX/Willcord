//! Addresses of this machine that a browser or worker on the network could
//! use to reach the main node, ranked so the likeliest one comes first.
use std::net::Ipv4Addr;

#[derive(Debug, PartialEq)]
pub struct Candidate {
    pub interface: String,
    pub address: Ipv4Addr,
}

/// Interfaces that exist only inside this host: container bridges and the like.
const VIRTUAL_PREFIXES: [&str; 7] = ["docker", "br-", "veth", "virbr", "cni", "flannel", "podman"];

fn rank(address: Ipv4Addr) -> u8 {
    let [a, b, ..] = address.octets();
    if address.is_private() {
        0
    } else if a == 100 && (64..128).contains(&b) {
        // Carrier-grade NAT space, which is also what Tailscale hands out.
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
                && !VIRTUAL_PREFIXES.iter().any(|p| name.starts_with(p))
        })
        .map(|(interface, address)| Candidate { interface, address })
        .collect();
    kept.sort_by_key(|c| rank(c.address));
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
