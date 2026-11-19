//! Proxy settings in the environment are never used: a proxy could see every page Spade
//! fetches, and would make the connection somewhere other than the address that was checked.
//! The variables are set on a child copy of this test binary, so no other test sees them.

mod common;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;

use common::{Result, start, with_dns};
use spade_fetch::{Page, Policy};

const CHILD: &str = "SPADE_FETCH_PROXY_CHILD";

#[test]
fn proxy_variables_in_the_environment_are_never_used() -> Result {
    let proxy = TcpListener::bind("127.0.0.1:0")?;
    let proxy_addr = proxy.local_addr()?;
    let contacted = Arc::new(AtomicUsize::new(0));
    let seen = contacted.clone();
    thread::spawn(move || {
        for stream in proxy.incoming().flatten() {
            seen.fetch_add(1, Ordering::SeqCst);
            let mut stream = stream;
            let mut buf = [0; 1024];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
        }
    });
    let proxy_url = format!("http://{proxy_addr}");
    let status = Command::new(std::env::current_exe()?)
        .args([
            "--exact",
            "child_fetches_with_proxy_variables_set",
            "--ignored",
            "--test-threads=1",
        ])
        .env(CHILD, "1")
        .env("HTTP_PROXY", &proxy_url)
        .env("http_proxy", &proxy_url)
        .env("HTTPS_PROXY", &proxy_url)
        .env("https_proxy", &proxy_url)
        .env("ALL_PROXY", &proxy_url)
        .env("all_proxy", &proxy_url)
        .env_remove("NO_PROXY")
        .env_remove("no_proxy")
        .status()?;
    assert!(status.success(), "the fetch in the child failed");
    assert_eq!(
        contacted.load(Ordering::SeqCst),
        0,
        "the proxy was contacted"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "run by proxy_variables_in_the_environment_are_never_used, in a child process"]
async fn child_fetches_with_proxy_variables_set() -> Result {
    if std::env::var_os(CHILD).is_none() {
        return Ok(());
    }
    let addr = start().await?;
    // A name rather than 127.0.0.1, so no built-in loopback exception skips the proxy.
    let fetcher = with_dns(Policy::allowing_loopback(), vec![addr]);
    let got = fetcher
        .fetch(
            &format!("http://pages.example:{}/page", addr.port()),
            Page::default(),
        )
        .await?;
    assert_eq!(got.title.as_deref(), Some("A page"));
    Ok(())
}
