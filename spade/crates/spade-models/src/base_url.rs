//! Endpoint base URLs, read with the same parser the HTTP client uses, so what Spade checks is
//! where requests really go.

use reqwest::Url;

/// A base URL Spade may call: `http` or `https`, a host, no user info, no backslashes, no query
/// or fragment. Returned normalised, ending with `/`.
pub fn check(raw: &str) -> Result<String, &'static str> {
    let raw = raw.trim();
    if raw.len() > 2_048 || raw.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("the base URL must be one line without spaces, at most 2,048 characters");
    }
    // Parsers disagree about `\`; refusing it leaves nothing to disagree on.
    if raw.contains('\\') {
        return Err("the base URL must not contain a backslash");
    }
    let mut url = Url::parse(raw).map_err(|_| "the base URL is not a URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the base URL must start with https:// or http://");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the base URL must not hold a user name or password; keys go in the keychain");
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("the base URL has no host");
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("the base URL must not have a query or fragment");
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url.to_string())
}

/// Where requests to `raw` go: `scheme://host:port` from the parsed URL. `None` when it does not
/// parse, which never equals another origin.
pub fn origin(raw: &str) -> Option<String> {
    let url = Url::parse(raw.trim()).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    Some(format!("{}://{host}:{port}", url.scheme()))
}

/// Whether `a` and `b` send requests to the same place.
pub fn same_origin(a: &str, b: &str) -> bool {
    matches!((origin(a), origin(b)), (Some(a), Some(b)) if a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_base_url_is_normalised_and_its_origin_compared_as_the_client_reads_it() {
        assert_eq!(
            check("https://API.example.com/v1"),
            Ok("https://api.example.com/v1/".into())
        );
        assert!(same_origin(
            "https://api.example.com:443/v2",
            "https://api.example.com/"
        ));
        assert!(!same_origin("https://a.example/", "https://b.example/"));
        assert!(!same_origin("http://a.example/", "https://a.example/"));
        assert!(!same_origin(
            "https://a.example:8443/",
            "https://a.example/"
        ));
    }

    #[test]
    fn user_info_backslashes_and_other_schemes_are_refused() {
        for bad in [
            "https://evil.example\\@trusted.example/",
            "https://user:pass@trusted.example/",
            "https://evil.example@trusted.example/",
            "ftp://trusted.example/",
            "file:///etc/passwd",
            "https://trusted.example/v1?x=1",
            "https://trusted.example/#f",
            "trusted.example/v1",
        ] {
            assert!(check(bad).is_err(), "{bad}");
        }
        // The case that fooled a hand-written comparison: the client goes to evil.example.
        assert_eq!(
            origin("https://evil.example\\@trusted.example/").as_deref(),
            Some("https://evil.example:443")
        );
    }
}
