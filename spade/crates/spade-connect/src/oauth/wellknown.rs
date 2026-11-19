//! Where metadata lives (RFC 9728 section 3, RFC 8414 section 3.1 and 5, as the MCP
//! authorization spec orders them) and which addresses Spade will talk to. Pure.

use url::Url;

/// An address Spade may send sign-in traffic to: https, or http on this machine (the spec allows
/// loopback, and tests run there). Nothing with credentials or a fragment.
pub fn checked(address: &str) -> Result<Url, String> {
    let url =
        Url::parse(address.trim()).map_err(|_| format!("{address:?} is not a web address"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the address must not carry a user name or password".into());
    }
    if url.fragment().is_some() {
        return Err("the address must not have a # part".into());
    }
    match url.scheme() {
        "https" => Ok(url),
        "http" if is_loopback(&url) => Ok(url),
        "http" => Err("the address must use https".into()),
        _ => Err("the address must start with https://".into()),
    }
}

pub fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// The server's resource identifier: its address without a query, fragment or trailing slash.
pub fn canonical_resource(url: &Url) -> String {
    let mut url = url.clone();
    url.set_query(None);
    url.set_fragment(None);
    let text = url.to_string();
    match text.strip_suffix('/') {
        Some(trimmed) if url.path() == "/" => trimmed.to_owned(),
        _ => text,
    }
}

fn origin(url: &Url) -> String {
    let mut text = format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        text.push_str(&format!(":{port}"));
    }
    text
}

fn path(url: &Url) -> String {
    url.path().trim_end_matches('/').to_owned()
}

/// Where to look for a server's protected-resource metadata when its challenge does not say:
/// at the MCP endpoint's path, then at the root.
pub fn resource_metadata(server: &Url) -> Vec<String> {
    let base = format!("{}/.well-known/oauth-protected-resource", origin(server));
    let path = path(server);
    if path.is_empty() {
        vec![base]
    } else {
        vec![format!("{base}{path}"), base]
    }
}

/// Where to look for an authorization server's metadata, in the spec's order: OAuth with the
/// path inserted, OpenID Connect with it inserted, then appended; without a path, OAuth then
/// OpenID Connect at the root.
pub fn authorization_server_metadata(issuer: &Url) -> Vec<String> {
    let origin = origin(issuer);
    let path = path(issuer);
    if path.is_empty() {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server"),
            format!("{origin}/.well-known/openid-configuration"),
        ]
    } else {
        vec![
            format!("{origin}/.well-known/oauth-authorization-server{path}"),
            format!("{origin}/.well-known/openid-configuration{path}"),
            format!("{origin}{path}/.well-known/openid-configuration"),
        ]
    }
}

/// Whether two addresses are on the same scheme, host and port.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    origin(a) == origin(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap_or_else(|e| panic!("{text}: {e}"))
    }

    #[test]
    fn resource_metadata_is_looked_for_at_the_endpoint_path_then_the_root() {
        assert_eq!(
            resource_metadata(&url("https://example.com/public/mcp")),
            vec![
                "https://example.com/.well-known/oauth-protected-resource/public/mcp",
                "https://example.com/.well-known/oauth-protected-resource",
            ]
        );
        assert_eq!(
            resource_metadata(&url("https://mcp.stripe.com/")),
            vec!["https://mcp.stripe.com/.well-known/oauth-protected-resource"]
        );
        assert_eq!(
            resource_metadata(&url("http://127.0.0.1:8123/mcp/")),
            vec![
                "http://127.0.0.1:8123/.well-known/oauth-protected-resource/mcp",
                "http://127.0.0.1:8123/.well-known/oauth-protected-resource",
            ]
        );
    }

    #[test]
    fn authorization_server_metadata_follows_the_spec_order() {
        assert_eq!(
            authorization_server_metadata(&url("https://auth.example.com/tenant1")),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server/tenant1",
                "https://auth.example.com/.well-known/openid-configuration/tenant1",
                "https://auth.example.com/tenant1/.well-known/openid-configuration",
            ]
        );
        assert_eq!(
            authorization_server_metadata(&url("https://auth.example.com")),
            vec![
                "https://auth.example.com/.well-known/oauth-authorization-server",
                "https://auth.example.com/.well-known/openid-configuration",
            ]
        );
    }

    #[test]
    fn only_https_or_loopback_http_is_accepted() {
        assert!(checked("https://mcp.linear.app/mcp").is_ok());
        assert!(checked("http://127.0.0.1:9/mcp").is_ok());
        assert!(checked("http://localhost:9/mcp").is_ok());
        assert!(checked("http://[::1]:9/mcp").is_ok());
        assert!(checked("http://mcp.linear.app/mcp").is_err());
        assert!(checked("http://10.0.0.5/mcp").is_err());
        assert!(checked("ftp://example.com").is_err());
        assert!(checked("https://user:pw@example.com").is_err());
        assert!(checked("https://example.com/#x").is_err());
        assert!(checked("example.com").is_err());
    }

    #[test]
    fn the_resource_identifier_drops_the_query_and_a_bare_trailing_slash() {
        assert_eq!(
            canonical_resource(&url("https://mcp.stripe.com/")),
            "https://mcp.stripe.com"
        );
        assert_eq!(
            canonical_resource(&url("https://api.githubcopilot.com/mcp/")),
            "https://api.githubcopilot.com/mcp/"
        );
        assert_eq!(
            canonical_resource(&url("https://mcp.sentry.dev/mcp?experimental=1")),
            "https://mcp.sentry.dev/mcp"
        );
    }
}
