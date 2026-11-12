//! The service's settings, from the environment only (`spade/docs/cloud.md`, "Configuration").
//! Pure: callers pass the lookup.

use axum::http::HeaderName;

pub const DEFAULT_PUBLIC_URL: &str = "https://cloud.acehq.dev";
/// ace's hosted account backend, which signs the grants (ADR 0111).
pub const DEFAULT_ACCOUNT_ORIGIN: &str = "https://relay.acehq.dev";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub port: u16,
    pub public_url: String,
    pub account_origin: String,
    pub address_header: Option<HeaderName>,
    /// Another apps file instead of the shipped one.
    pub apps_file: Option<String>,
}

impl Config {
    pub fn from_env(env: &dyn Fn(&str) -> Option<String>) -> Result<Self, String> {
        let value = |name: &str| {
            env(name)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let port = match value("PORT") {
            Some(port) => port
                .parse()
                .map_err(|_| format!("PORT is not a port: {port}"))?,
            None => 8080,
        };
        let public_url =
            value("SPADE_CLOUD_PUBLIC_URL").unwrap_or_else(|| DEFAULT_PUBLIC_URL.into());
        let account_origin =
            value("SPADE_CLOUD_ACCOUNT_ORIGIN").unwrap_or_else(|| DEFAULT_ACCOUNT_ORIGIN.into());
        for (name, address) in [
            ("SPADE_CLOUD_PUBLIC_URL", &public_url),
            ("SPADE_CLOUD_ACCOUNT_ORIGIN", &account_origin),
        ] {
            let parsed = url::Url::parse(address).map_err(|_| format!("{name} is not a URL"))?;
            let local = matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"));
            if parsed.scheme() != "https" && !(parsed.scheme() == "http" && local) {
                return Err(format!("{name} must be https"));
            }
        }
        let address_header = value("SPADE_CLOUD_ADDRESS_HEADER")
            .map(|name| {
                HeaderName::try_from(name.to_ascii_lowercase())
                    .map_err(|_| format!("SPADE_CLOUD_ADDRESS_HEADER is not a header: {name}"))
            })
            .transpose()?;
        Ok(Self {
            port,
            public_url: public_url.trim_end_matches('/').to_owned(),
            account_origin: account_origin.trim_end_matches('/').to_owned(),
            address_header,
            apps_file: value("SPADE_CLOUD_APPS_FILE"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_nothing_set_it_serves_cloud_acehq_dev_against_aces_account_backend() {
        let config = Config::from_env(&|_| None).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(config.port, 8080);
        assert_eq!(config.public_url, "https://cloud.acehq.dev");
        assert_eq!(config.account_origin, "https://relay.acehq.dev");
        assert_eq!(config.address_header, None);
    }

    #[test]
    fn a_plain_http_address_is_refused_except_on_this_machine() {
        let with = |url: &'static str| {
            Config::from_env(&move |name| {
                (name == "SPADE_CLOUD_PUBLIC_URL").then(|| url.to_owned())
            })
        };
        assert!(with("http://cloud.example").is_err());
        assert!(with("http://127.0.0.1:8080").is_ok());
        assert!(with("https://cloud.example/").is_ok());
    }
}
