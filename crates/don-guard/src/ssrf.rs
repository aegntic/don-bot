use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

pub fn is_blocked_ipv4(ip: Ipv4Addr) -> Option<&'static str> {
    let o = ip.octets();
    if ip.is_loopback() {
        return Some("loopback (127.0.0.0/8)");
    }
    if o[0] == 0 {
        return Some("unspecified network (0.0.0.0/8)");
    }
    if o[0] == 10 {
        return Some("private RFC1918 (10.0.0.0/8)");
    }
    if o[0] == 100 && (o[1] & 0b1100_0000) == 64 {
        return Some("Tailscale / CGNAT (100.64.0.0/10)");
    }
    if o[0] == 169 && o[1] == 254 {
        return Some("cloud metadata / link-local (169.254.0.0/16)");
    }
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return Some("private RFC1918 (172.16.0.0/12)");
    }
    if o[0] == 192 && o[1] == 168 {
        return Some("private RFC1918 (192.168.0.0/16)");
    }
    if o[0] == 198 && (o[1] == 18 || o[1] == 19) {
        return Some("benchmark reserve (198.18.0.0/15)");
    }
    if ip.is_multicast() || ip.is_broadcast() || o[0] >= 240 {
        return Some("multicast or reserved IPv4 range");
    }
    None
}

pub fn is_blocked_ip(ip: IpAddr) -> Option<&'static str> {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

pub fn is_blocked_ipv6(ip: Ipv6Addr) -> Option<&'static str> {
    if ip.is_loopback() {
        return Some("IPv6 loopback (::1)");
    }
    if ip.is_unspecified() {
        return Some("IPv6 unspecified (::)");
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(v4);
    }
    let seg = ip.segments();
    // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48
    if seg[0] == 0x0064 && seg[1] == 0xff9b {
        if seg[2] == 0 && seg[3] == 0 && seg[4] == 0 && seg[5] == 0 {
            let embedded = Ipv4Addr::new(
                (seg[6] >> 8) as u8,
                (seg[6] & 0xff) as u8,
                (seg[7] >> 8) as u8,
                (seg[7] & 0xff) as u8,
            );
            return is_blocked_ipv4(embedded).or(Some("NAT64 prefix (64:ff9b::/96)"));
        }
        if seg[2] == 1 {
            return Some("NAT64 local-use prefix (64:ff9b:1::/48)");
        }
    }
    // Unique local fc00::/7
    if (seg[0] & 0xfe00) == 0xfc00 {
        return Some("IPv6 unique-local (fc00::/7)");
    }
    // Link-local fe80::/10
    if (seg[0] & 0xffc0) == 0xfe80 {
        return Some("IPv6 link-local (fe80::/10)");
    }
    if ip.is_multicast() {
        return Some("IPv6 multicast");
    }
    None
}

fn parse_host_and_port(raw_url: &str) -> Result<(String, u16), String> {
    let lower = raw_url.trim();
    let (scheme, rest) = lower
        .split_once("://")
        .ok_or_else(|| "URL missing scheme".to_string())?;
    let scheme_lower = scheme.to_ascii_lowercase();
    let default_port = match scheme_lower.as_str() {
        "http" => 80u16,
        "https" => 443u16,
        other => return Err(format!("Blocked URL scheme \"{other}\"")),
    };

    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return Err("URL missing host".to_string());
    }
    let host_port = authority
        .rsplit_once('@')
        .map(|(_, hp)| hp)
        .unwrap_or(authority);

    if host_port.starts_with('[') {
        let end = host_port
            .find(']')
            .ok_or_else(|| "Malformed IPv6 host brackets".to_string())?;
        let host = host_port[1..end].to_string();
        let port = host_port[end + 1..]
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(default_port);
        return Ok((host, port));
    }

    if let Some((h, p)) = host_port.rsplit_once(':') {
        if let Ok(parsed_port) = p.parse::<u16>() {
            return Ok((h.to_string(), parsed_port));
        }
    }
    Ok((host_port.to_string(), default_port))
}

pub fn check_url(raw_url: &str, supplied_ips: Option<&[IpAddr]>) -> Result<Vec<String>, String> {
    let (host, port) = parse_host_and_port(raw_url)?;
    let host_lower = host.to_ascii_lowercase();

    if host_lower == "localhost"
        || host_lower.ends_with(".localhost")
        || host_lower.ends_with(".local")
        || host_lower.ends_with(".internal")
        || host_lower == "metadata.google.internal"
    {
        return Err(format!("Blocked internal or metadata hostname \"{host}\""));
    }

    if let Ok(literal_ip) = host.parse::<IpAddr>() {
        if let Some(reason) = is_blocked_ip(literal_ip) {
            return Err(format!("Blocked IP address {literal_ip}: {reason}"));
        }
        return Ok(vec![literal_ip.to_string()]);
    }

    let resolved: Vec<IpAddr> = if let Some(ips) = supplied_ips {
        ips.to_vec()
    } else {
        (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("DNS resolution failed for \"{host}\": {e}"))?
            .map(|sa| sa.ip())
            .collect()
    };

    if resolved.is_empty() {
        return Err(format!("Host \"{host}\" resolved to zero IP addresses"));
    }

    let mut out = Vec::with_capacity(resolved.len());
    for ip in resolved {
        if let Some(reason) = is_blocked_ip(ip) {
            return Err(format!("DNS rebinding / SSRF blocked for \"{host}\" ({ip}): {reason}"));
        }
        out.push(ip.to_string());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_non_http_schemes_and_internal_hostnames() {
        assert!(check_url("file:///etc/passwd", None).is_err());
        assert!(check_url("gopher://127.0.0.1:70/", None).is_err());
        assert!(check_url("https://localhost/admin", None).is_err());
        assert!(check_url("https://metadata.google.internal/computeMetadata/v1/", None).is_err());
        assert!(check_url("https://svc.cluster.local/api", None).is_err());
    }

    #[test]
    fn blocks_private_cgnat_metadata_and_ipv6_bypass_ranges() {
        let blocked_ips = [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.4.2",
            "192.168.1.50",
            "100.64.0.1",
            "100.127.255.254",
            "169.254.169.254",
            "::1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "::ffff:127.0.0.1",
            "64:ff9b::10.0.0.1",
            "64:ff9b:1::1",
        ];
        for raw in blocked_ips {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(is_blocked_ip(ip).is_some(), "expected IP {raw} to be blocked");
            let rebinding: &[IpAddr] = &[ip];
            assert!(
                check_url("https://public.example/webhook", Some(rebinding)).is_err(),
                "expected DNS rebinding check to block {raw}"
            );
        }
    }

    #[test]
    fn allows_public_ip_addresses() {
        let pub_v4: IpAddr = "140.82.121.6".parse().unwrap();
        let pub_v6: IpAddr = "2606:4700:4700::1111".parse().unwrap();
        assert!(is_blocked_ip(pub_v4).is_none());
        assert!(is_blocked_ip(pub_v6).is_none());
        let ok = check_url("https://api.github.com/zen", Some(&[pub_v4])).unwrap();
        assert_eq!(ok, vec!["140.82.121.6".to_string()]);
    }
}
