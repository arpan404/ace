//! Where sign-in traffic may go. Every address Spade fetches or posts to while signing in comes
//! from a server (metadata, registration and token endpoints), so it is checked like a web page
//! Spade fetches (`spade-fetch`'s policy): `https`, and every address its name resolves to public
//! and not this machine's. The request then connects only to the addresses checked, never through
//! a proxy, so a second DNS answer can't swap them. A connector the person explicitly marked as
//! local when adding it (a server on their own machine or network) may use local addresses too;
//! nothing else may, and DNS never decides it: an answer naming any private or local address, even
//! beside public ones, is refused.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use spade_fetch::{LocalNetworks, Policy, Resolve, SystemNetworks, SystemResolver};
use url::{Host, Url};

use super::OauthError;
use super::wellknown;

/// How names are resolved and which networks are this machine's. Injected so tests can point a
/// made-up name at an address of their choosing.
#[derive(Clone)]
pub struct Addresses {
    resolver: Arc<dyn Resolve>,
    networks: Arc<dyn LocalNetworks>,
}

impl Addresses {
    /// The operating system's resolver and interfaces.
    pub fn system() -> Self {
        Self::new(Arc::new(SystemResolver), Arc::new(SystemNetworks))
    }

    pub fn new(resolver: Arc<dyn Resolve>, networks: Arc<dyn LocalNetworks>) -> Self {
        Self { resolver, networks }
    }

    /// The network for signing in to a connector: `local` only when the person marked it so.
    pub fn for_connector(&self, local: bool, timeout: Duration) -> Net {
        Net {
            addresses: self.clone(),
            local,
            timeout,
        }
    }

    async fn resolve(&self, url: &Url) -> Result<Vec<SocketAddr>, OauthError> {
        let port = url
            .port_or_known_default()
            .ok_or_else(|| OauthError::Unsupported("the address has no port".into()))?;
        let found = match url.host() {
            Some(Host::Ipv4(ip)) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Some(Host::Ipv6(ip)) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            Some(Host::Domain(name)) => self
                .resolver
                .lookup(name, port)
                .await
                .map_err(|_| OauthError::Network(format!("could not look up {name}")))?,
            None => return Err(OauthError::Unsupported("the address has no host".into())),
        };
        if found.is_empty() {
            return Err(OauthError::Network(
                "the address resolved to nothing".into(),
            ));
        }
        Ok(found)
    }

    /// Whether every address is public and none is this machine's or on its links.
    async fn all_public(&self, addresses: &[SocketAddr]) -> Result<bool, OauthError> {
        let policy = Policy::default();
        if !addresses.iter().all(|a| policy.allows(a.ip())) {
            return Ok(false);
        }
        let networks = self.networks.clone();
        let networks = tokio::task::spawn_blocking(move || networks.networks())
            .await
            .map_err(|_| OauthError::Network("could not read this machine's networks".into()))?
            .map_err(|_| OauthError::Network("could not read this machine's networks".into()))?;
        Ok(!addresses
            .iter()
            .any(|a| networks.iter().any(|n| n.contains(a.ip()))))
    }
}

/// One sign-in's network: what it may reach, and requests pinned to the addresses checked.
#[derive(Clone)]
pub struct Net {
    addresses: Addresses,
    local: bool,
    timeout: Duration,
}

impl Net {
    /// Checks a server-supplied `address` and resolves it: `https` (or loopback `http` for a local
    /// server) and, unless the server is local, only public addresses.
    pub async fn check(&self, address: &str) -> Result<(Url, Vec<SocketAddr>), OauthError> {
        let url = wellknown::checked(address).map_err(OauthError::Unsupported)?;
        if !self.local && url.scheme() != "https" {
            return Err(OauthError::Unsupported(
                "the sign-in server's address must use https".into(),
            ));
        }
        let addresses = self.addresses.resolve(&url).await?;
        if !self.local && !self.addresses.all_public(&addresses).await? {
            return Err(OauthError::Unsupported(
                "the sign-in server points at a private or local address, which Spade will not reach"
                    .into(),
            ));
        }
        Ok((url, addresses))
    }

    /// An HTTP client for `address` after [`Net::check`]: it reaches only the checked addresses,
    /// follows no redirect and uses no proxy.
    pub async fn client(&self, address: &str) -> Result<(reqwest::Client, Url), OauthError> {
        let (url, addresses) = self.check(address).await?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(self.timeout)
            .user_agent(concat!("spade/", env!("CARGO_PKG_VERSION")))
            .dns_resolver(Nowhere);
        if let Some(Host::Domain(name)) = url.host() {
            builder = builder.resolve_to_addrs(name, &addresses);
        }
        let client = builder
            .build()
            .map_err(|_| OauthError::Network("could not prepare the request".into()))?;
        Ok((client, url))
    }
}

/// The client's own resolver answers nothing: it connects only to the pinned addresses.
struct Nowhere;

impl reqwest::dns::Resolve for Nowhere {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let name = name.as_str().to_owned();
        Box::pin(async move { Err(format!("{name} was not checked before connecting").into()) })
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use spade_fetch::{Lookup, Network};

    use super::*;

    /// Every name resolves to `ip`.
    struct To(IpAddr);

    impl Resolve for To {
        fn lookup<'a>(&'a self, _host: &'a str, port: u16) -> Lookup<'a> {
            let ip = self.0;
            Box::pin(async move { Ok(vec![SocketAddr::new(ip, port)]) })
        }
    }

    /// This machine's networks, as a test says.
    struct Mine(Vec<Network>);

    impl LocalNetworks for Mine {
        fn networks(&self) -> io::Result<Vec<Network>> {
            Ok(self.0.clone())
        }
    }

    fn addresses(ip: [u8; 4], mine: Vec<Network>) -> Addresses {
        Addresses::new(Arc::new(To(IpAddr::from(ip))), Arc::new(Mine(mine)))
    }

    const PUBLIC: [u8; 4] = [93, 184, 216, 34];

    fn public_connector(resolving_to: [u8; 4], mine: Vec<Network>) -> Net {
        addresses(resolving_to, mine).for_connector(false, Duration::from_secs(5))
    }

    #[tokio::test]
    async fn a_public_servers_sign_in_may_not_reach_private_local_or_plain_http_addresses()
    -> Result<(), OauthError> {
        for private in [
            [10, 0, 0, 5],
            [127, 0, 0, 1],
            [169, 254, 169, 254],
            [192, 168, 1, 2],
        ] {
            let net = public_connector(private, Vec::new());
            assert!(
                net.check("https://auth.example.com/token").await.is_err(),
                "{private:?} was allowed"
            );
        }
        let net = public_connector(PUBLIC, Vec::new());
        assert!(net.check("https://auth.example.com/token").await.is_ok());
        assert!(net.check("http://auth.example.com/token").await.is_err());
        assert!(net.check("http://127.0.0.1:9/token").await.is_err());
        Ok(())
    }

    /// The first answer is private, the second public: a server rebinding its name.
    struct Mixed;

    impl Resolve for Mixed {
        fn lookup<'a>(&'a self, _host: &'a str, port: u16) -> Lookup<'a> {
            Box::pin(async move {
                Ok(vec![
                    SocketAddr::new(IpAddr::from(PUBLIC), port),
                    SocketAddr::new(IpAddr::from([127, 0, 0, 1]), port),
                ])
            })
        }
    }

    #[tokio::test]
    async fn an_answer_mixing_public_and_local_addresses_is_refused_unless_marked_local()
    -> Result<(), OauthError> {
        let mixed = Addresses::new(Arc::new(Mixed), Arc::new(Mine(Vec::new())));
        let refused = mixed
            .for_connector(false, Duration::from_secs(5))
            .check("https://rebind.example.com/token")
            .await;
        assert!(refused.is_err(), "{refused:?}");
        let marked = mixed
            .for_connector(true, Duration::from_secs(5))
            .check("https://rebind.example.com/token")
            .await;
        assert!(marked.is_ok());
        Ok(())
    }

    #[tokio::test]
    async fn a_public_address_on_this_machines_own_network_is_refused() -> Result<(), OauthError> {
        let mine = vec![Network {
            addr: IpAddr::from(PUBLIC),
            prefix: 24,
        }];
        let net = public_connector([93, 184, 216, 99], mine);
        assert!(net.check("https://auth.example.com/token").await.is_err());
        Ok(())
    }

    #[tokio::test]
    async fn a_connector_the_person_marked_local_may_use_local_sign_in_servers()
    -> Result<(), OauthError> {
        let net =
            addresses([192, 168, 1, 20], Vec::new()).for_connector(true, Duration::from_secs(5));
        assert!(net.check("https://auth.home.arpa/token").await.is_ok());
        assert!(net.check("http://127.0.0.1:9/token").await.is_ok());
        Ok(())
    }

    #[tokio::test]
    async fn a_request_connects_to_the_address_that_was_checked_not_a_new_lookup()
    -> Result<(), OauthError> {
        // `pinned.invalid` exists nowhere but in the checked answer: reaching the listener
        // proves the request used the checked address rather than asking DNS again.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| OauthError::Network(e.to_string()))?;
        let port = listener
            .local_addr()
            .map_err(|e| OauthError::Network(e.to_string()))?
            .port();
        let net = addresses([127, 0, 0, 1], Vec::new()).for_connector(true, Duration::from_secs(5));
        let (client, address) = net
            .client(&format!("https://pinned.invalid:{port}/token"))
            .await?;
        let accepted = tokio::time::timeout(Duration::from_secs(2), listener.accept());
        // The listener never answers TLS; only the connection matters.
        let sent = tokio::time::timeout(Duration::from_millis(300), client.get(address).send());
        let (accepted, _) = tokio::join!(accepted, sent);
        assert!(
            matches!(accepted, Ok(Ok(_))),
            "the checked address was not used"
        );
        Ok(())
    }
}
