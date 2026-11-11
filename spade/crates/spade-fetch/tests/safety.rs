//! What the fetcher refuses to connect to, over HTTP against a local server.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use common::{FakeNetworks, Result, UnreadableNetworks, local, net, start, with_dns};
use spade_fetch::{FetchError, Fetcher, Page, Policy};

#[tokio::test]
async fn the_connection_goes_to_the_checked_address_not_a_second_lookup() -> Result {
    let addr = start().await?;
    // The name exists nowhere but in the injected resolver, so the request can only arrive if
    // the client connected to the address that was checked.
    let fetcher = with_dns(Policy::allowing_loopback(), vec![addr]);
    let got = fetcher
        .fetch(
            &format!("http://spade-check.invalid:{}/host", addr.port()),
            Page::default(),
        )
        .await?;
    assert_eq!(got.text, format!("spade-check.invalid:{}", addr.port()));
    Ok(())
}

#[tokio::test]
async fn the_default_policy_refuses_loopback_localhost_and_private_hosts() -> Result {
    let addr = start().await?;
    let port = addr.port();
    let fetcher = Fetcher::new(Policy::default(), Duration::from_secs(5));
    for (url, host) in [
        (format!("http://127.0.0.1:{port}/page"), "127.0.0.1"),
        (format!("http://localhost:{port}/page"), "localhost"),
        (format!("http://[::1]:{port}/page"), "[::1]"),
        (format!("http://2130706433:{port}/page"), "127.0.0.1"), // 127.0.0.1 as one number
        (
            format!("http://[::ffff:127.0.0.1]:{port}/page"),
            "[::ffff:7f00:1]",
        ),
        ("http://10.1.2.3/".to_owned(), "10.1.2.3"),
        (
            "http://169.254.169.254/latest/meta-data/".to_owned(),
            "169.254.169.254",
        ),
    ] {
        let got = fetcher.fetch(&url, Page::default()).await;
        assert_eq!(got, Err(FetchError::Refused(host.to_owned())), "{url}");
    }
    Ok(())
}

#[tokio::test]
async fn a_name_that_resolves_to_any_private_address_is_refused() -> Result {
    let public: SocketAddr = "93.184.216.34:80".parse()?;
    let private: SocketAddr = "192.168.1.10:80".parse()?;
    let fetcher = with_dns(Policy::default(), vec![public, private]);
    let got = fetcher
        .fetch("http://looks-public.example/", Page::default())
        .await;
    assert_eq!(
        got,
        Err(FetchError::Refused("looks-public.example".to_owned()))
    );
    Ok(())
}

#[tokio::test]
async fn a_redirect_to_a_private_address_is_refused() -> Result {
    let addr = start().await?;
    for (target, host) in [
        (
            "http://169.254.169.254/latest/meta-data/",
            "169.254.169.254",
        ),
        ("http://10.0.0.1/admin", "10.0.0.1"),
        ("http://[fd00::1]/", "[fd00::1]"),
    ] {
        let got = local()
            .fetch(&format!("http://{addr}/to?where={target}"), Page::default())
            .await;
        assert_eq!(got, Err(FetchError::Refused(host.to_owned())), "{target}");
    }
    Ok(())
}

#[tokio::test]
async fn only_http_and_https_are_fetched() -> Result {
    for (url, scheme) in [
        ("file:///etc/passwd", "file"),
        ("ftp://example.com/x", "ftp"),
        ("gopher://example.com/", "gopher"),
    ] {
        let got = local().fetch(url, Page::default()).await;
        assert_eq!(got, Err(FetchError::Scheme(scheme.to_owned())), "{url}");
    }
    assert!(matches!(
        local().fetch("not a url", Page::default()).await,
        Err(FetchError::BadUrl(_))
    ));
    Ok(())
}

const NAT64_LOCAL: &str = "64:ff9b:1::a00:1"; // 10.0.0.1 behind the local-use NAT64 prefix

#[tokio::test]
async fn a_nat64_local_use_literal_is_refused() -> Result {
    let fetcher = Fetcher::new(Policy::default(), Duration::from_secs(5));
    let got = fetcher
        .fetch(&format!("http://[{NAT64_LOCAL}]/"), Page::default())
        .await;
    assert_eq!(got, Err(FetchError::Refused(format!("[{NAT64_LOCAL}]"))));
    Ok(())
}

#[tokio::test]
async fn a_name_answering_with_a_nat64_local_use_address_is_refused() -> Result {
    let answer = SocketAddr::new(NAT64_LOCAL.parse()?, 80);
    let got = with_dns(Policy::default(), vec![answer])
        .fetch("http://nat64.example/", Page::default())
        .await;
    assert_eq!(got, Err(FetchError::Refused("nat64.example".to_owned())));
    Ok(())
}

#[tokio::test]
async fn a_redirect_to_a_nat64_local_use_address_is_refused() -> Result {
    let addr = start().await?;
    let got = local()
        .fetch(
            &format!("http://{addr}/to?where=http://[{NAT64_LOCAL}]/"),
            Page::default(),
        )
        .await;
    assert_eq!(got, Err(FetchError::Refused(format!("[{NAT64_LOCAL}]"))));
    Ok(())
}

/// A laptop with a global IPv6 address on a /64 and a public IPv4 address on a /24.
fn on_own_networks(fetcher: Fetcher) -> Fetcher {
    fetcher.with_local_networks(Arc::new(FakeNetworks(vec![
        net("2a00:1450:4001::5/64"),
        net("93.184.216.34/24"),
        net("127.0.0.1/8"),
    ])))
}

#[tokio::test]
async fn the_machines_own_public_addresses_and_their_links_are_refused() -> Result {
    let fetcher = on_own_networks(Fetcher::new(Policy::default(), Duration::from_secs(5)));
    for (url, host) in [
        ("http://[2a00:1450:4001::5]:8080/", "[2a00:1450:4001::5]"),
        ("http://[2a00:1450:4001::99]/", "[2a00:1450:4001::99]"),
        ("http://[::ffff:93.184.216.34]:8080/", "[::ffff:5db8:d822]"),
        ("http://93.184.216.200/", "93.184.216.200"),
    ] {
        let got = fetcher.fetch(url, Page::default()).await;
        assert_eq!(got, Err(FetchError::Refused(host.to_owned())), "{url}");
    }
    Ok(())
}

#[tokio::test]
async fn a_name_answering_with_the_machines_own_address_is_refused() -> Result {
    let own = SocketAddr::new("2a00:1450:4001::5".parse()?, 8080);
    let fetcher = on_own_networks(with_dns(Policy::default(), vec![own]));
    let got = fetcher
        .fetch("http://laptop.example:8080/", Page::default())
        .await;
    assert_eq!(got, Err(FetchError::Refused("laptop.example".to_owned())));
    Ok(())
}

#[tokio::test]
async fn an_unreadable_interface_list_refuses_the_fetch() -> Result {
    let addr = start().await?;
    let fetcher = local().with_local_networks(Arc::new(UnreadableNetworks));
    let got = fetcher
        .fetch(&format!("http://{addr}/page"), Page::default())
        .await;
    assert_eq!(got, Err(FetchError::LocalNetworks));
    Ok(())
}

#[tokio::test]
async fn allowed_loopback_still_works_though_loopback_is_a_local_network() -> Result {
    let addr = start().await?;
    let fetcher = on_own_networks(local());
    let got = fetcher
        .fetch(&format!("http://{addr}/page"), Page::default())
        .await?;
    assert_eq!(got.title.as_deref(), Some("A page"));
    Ok(())
}
