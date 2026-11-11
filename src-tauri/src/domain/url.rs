//! Turn browser URLs into site names. Only the host is ever stored: never paths or queries.

/// Lower-cased host of an http(s) URL without a leading `www.`, e.g.
/// `https://user@www.YouTube.com:443/watch?v=1` -> `youtube.com`.
/// Anything else (`file:`, `chrome:`, `about:`, garbage) gives `None`.
pub fn host_of(url: &str) -> Option<String> {
    let url = url.trim();
    let (scheme, rest) = url.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        // IPv6 literal: [::1]:8080
        format!("[{}]", stripped.split(']').next().unwrap_or(""))
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    clean_host(&host)
}

fn clean_host(host: &str) -> Option<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_string();
    let valid = !host.is_empty()
        && host.len() <= 253
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'));
    valid.then_some(host)
}

/// Normalise a user-typed site rule: `https://www.Reddit.com/r/x` or `reddit.com` -> `reddit.com`.
pub fn normalize_domain(input: &str) -> Option<String> {
    let input = input.trim();
    if input.contains("://") {
        return host_of(input);
    }
    let host = input.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    clean_host(host)
}

/// `m.youtube.com` matches `youtube.com`; `notyoutube.com` does not.
pub fn domain_matches(host: &str, domain: &str) -> bool {
    host == domain || (host.len() > domain.len() && host.ends_with(domain) && host.as_bytes()[host.len() - domain.len() - 1] == b'.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_hosts() {
        assert_eq!(host_of("https://www.YouTube.com/watch?v=1").as_deref(), Some("youtube.com"));
        assert_eq!(host_of("http://user:pw@Example.org:8080/a#b").as_deref(), Some("example.org"));
        assert_eq!(host_of("HTTPS://m.reddit.com").as_deref(), Some("m.reddit.com"));
        assert_eq!(host_of("https://localhost:5173/").as_deref(), Some("localhost"));
        assert_eq!(host_of("http://[::1]:8080/x").as_deref(), Some("[::1]"));
        assert_eq!(host_of("https://example.com.").as_deref(), Some("example.com"));
        for bad in ["", "youtube.com", "file:///Users/me", "chrome://settings", "about:blank", "https://", "https://bad host/"] {
            assert_eq!(host_of(bad), None, "{bad}");
        }
    }

    #[test]
    fn normalizes_typed_domains() {
        assert_eq!(normalize_domain(" https://www.Reddit.com/r/adhd ").as_deref(), Some("reddit.com"));
        assert_eq!(normalize_domain("www.youtube.com/").as_deref(), Some("youtube.com"));
        assert_eq!(normalize_domain("x.com").as_deref(), Some("x.com"));
        assert_eq!(normalize_domain("news.ycombinator.com:443").as_deref(), Some("news.ycombinator.com"));
        assert_eq!(normalize_domain("   "), None);
        assert_eq!(normalize_domain("not a site"), None);
    }

    #[test]
    fn matches_subdomains_only_on_label_boundaries() {
        assert!(domain_matches("youtube.com", "youtube.com"));
        assert!(domain_matches("m.youtube.com", "youtube.com"));
        assert!(!domain_matches("notyoutube.com", "youtube.com"));
        assert!(!domain_matches("youtube.com.evil.io", "youtube.com"));
        assert!(!domain_matches("com", "youtube.com"));
    }
}
