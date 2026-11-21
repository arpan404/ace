use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use spade_fetch::{LocalNetworks, Lookup, Network, Resolve};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::*;

/// Every name resolves to `ip`.
struct To(IpAddr);

impl Resolve for To {
    fn lookup<'a>(&'a self, _host: &'a str, port: u16) -> Lookup<'a> {
        let ip = self.0;
        Box::pin(async move { Ok(vec![SocketAddr::new(ip, port)]) })
    }
}

struct NoNetworks;

impl LocalNetworks for NoNetworks {
    fn networks(&self) -> io::Result<Vec<Network>> {
        Ok(Vec::new())
    }
}

fn resolving_to(ip: [u8; 4]) -> A2aClient {
    A2aClient::new(Addresses::new(
        Arc::new(To(IpAddr::from(ip))),
        Arc::new(NoNetworks),
    ))
}

/// A listener on this machine that counts the connections it gets and answers each with
/// `answer`.
async fn listener(answer: &'static [u8]) -> (u16, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|e| panic!("addr: {e}"))
        .port();
    let reached = Arc::new(AtomicUsize::new(0));
    let counted = reached.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            counted.fetch_add(1, Ordering::SeqCst);
            tokio::spawn(async move {
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request).await;
                let _ = stream.write_all(answer).await;
            });
        }
    });
    (port, reached)
}

const CARD: &[u8] =
    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}";

#[tokio::test]
async fn a_remote_agents_card_keys_and_calls_never_reach_local_or_private_addresses() {
    let (port, reached) = listener(CARD).await;
    // A remote agent's name that DNS points at this machine, or the network around it.
    for ip in [[127, 0, 0, 1], [10, 0, 0, 5], [169, 254, 169, 254]] {
        let client = resolving_to(ip);
        let card = Url::parse(&format!("https://agents.example.com:{port}/card.json"))
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(client.document(&card, false).await.is_err(), "{ip:?}");
        let called = client
            .call(
                &format!("https://agents.example.com:{port}/a2a"),
                false,
                "GetTask",
                json!({ "id": "t" }),
            )
            .await;
        assert!(matches!(called, Err(Unreached::NotSent(_))), "{called:?}");
    }
    // Plain http to this machine, as a remote card might name it.
    let client = resolving_to([127, 0, 0, 1]);
    let local = format!("http://127.0.0.1:{port}/a2a");
    let called = client.call(&local, false, "GetTask", json!({})).await;
    assert!(matches!(called, Err(Unreached::NotSent(_))), "{called:?}");
    assert!(client.check(&local, false).await.is_err());
    assert_eq!(
        reached.load(Ordering::SeqCst),
        0,
        "a local address was reached"
    );

    // An agent the person added as local may.
    let card =
        Url::parse(&format!("http://127.0.0.1:{port}/card.json")).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(client.document(&card, true).await, Ok(json!({})));
    assert_eq!(reached.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn a_request_connects_to_the_address_that_was_checked_not_a_new_lookup() {
    // `pinned.invalid` exists nowhere but in the checked answer: reaching the listener proves
    // the request used the checked address rather than asking DNS again. The listener answers
    // no TLS; only the connection matters.
    let (port, reached) = listener(b"").await;
    let client = resolving_to([127, 0, 0, 1]);
    let card = Url::parse(&format!("https://pinned.invalid:{port}/card.json"))
        .unwrap_or_else(|e| panic!("{e}"));
    let _ = client.document(&card, true).await;
    assert_eq!(reached.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn an_answer_with_no_length_is_cut_off_at_256_kib_as_it_arrives() {
    // An answer that never ends: it must be refused once 256 KiB have come, not read to the end
    // (or the timeout) first.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .unwrap_or_else(|e| panic!("bind: {e}"));
    let port = listener
        .local_addr()
        .unwrap_or_else(|e| panic!("addr: {e}"))
        .port();
    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let mut request = [0u8; 4096];
        let _ = stream.read(&mut request).await;
        let head = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n";
        if stream.write_all(head).await.is_err() {
            return;
        }
        let chunk = format!("4000\r\n{}\r\n", " ".repeat(0x4000));
        while stream.write_all(chunk.as_bytes()).await.is_ok() {}
    });
    let client = resolving_to([127, 0, 0, 1]);
    let card =
        Url::parse(&format!("http://127.0.0.1:{port}/card.json")).unwrap_or_else(|e| panic!("{e}"));
    let read = tokio::time::timeout(Duration::from_secs(5), client.document(&card, true)).await;
    assert_eq!(read, Ok(Err(TOO_LARGE.to_owned())));
}
