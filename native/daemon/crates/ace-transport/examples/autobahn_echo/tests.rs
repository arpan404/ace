// SPDX-License-Identifier: Apache-2.0
//! What the Autobahn scratch server must do for the suite, over a real TCP
//! connection: echo the suite's large messages without stalling, and end a
//! connection whose peer drops it without a close frame. Both were found by the
//! T1b.5 run: the echo never released its inbound credit, so a 256 KiB message
//! (9.1.2) hung the reader, and a dropped peer was left in CLOSE_WAIT.

use super::*;
use ace_transport::deflate::{Body, Deflater, INFLATE_WINDOW};
use ace_transport::frame::assemble::MessageBody;
use tokio::time::timeout;

const PATTERN: &[u8] = b"BAsd7&jh23";
/// 9.1.2's size.
const LARGE: usize = 256 * 1024;
/// The largest message the cargo tests send; the suite's 16 MiB case (9.1.6) is
/// the scratch server's, and would only slow these down under load.
const LARGEST: usize = 4 * 1024 * 1024;

/// A server on a fresh port that keeps accepting, as `main` does, so a test can
/// open a second connection after the first.
async fn server() -> std::net::SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let handler = WebSocketUpgrades::with_deflate(
                Arc::new(AcceptAll {
                    next: AtomicU64::new(1),
                }),
                Arc::new(Echo),
            );
            tokio::spawn(serve(Arc::new(handler), stream));
        }
    });
    address
}

async fn connect(compressed: bool) -> TcpStream {
    let address = server().await;
    connect_to(address, compressed).await
}

async fn connect_to(address: std::net::SocketAddr, compressed: bool) -> TcpStream {
    let mut client = TcpStream::connect(address).await.unwrap();
    let offer = if compressed {
        "Sec-WebSocket-Extensions: permessage-deflate\r\n"
    } else {
        ""
    };
    client
        .write_all(
            format!(
                "GET / HTTP/1.1\r\nHost: {address}\r\nConnection: Upgrade\r\n\
                 Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n{offer}\r\n"
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    let mut head = Vec::new();
    while !head.ends_with(b"\r\n\r\n") {
        head.push(client.read_u8().await.unwrap());
    }
    let head = String::from_utf8(head).unwrap().to_ascii_lowercase();
    assert!(head.starts_with("http/1.1 101 "));
    assert_eq!(
        head.contains("\r\nsec-websocket-extensions: permessage-deflate"),
        compressed
    );
    client
}

/// One masked frame of a fragmented message, with the FIN bit chosen: empty
/// fragments are enough to pass the fragment bound.
fn masked_fragment(opcode: u8, fin: bool, payload: &[u8]) -> Vec<u8> {
    let mut frame = masked_text(payload, false);
    frame[0] = (if fin { 0x80 } else { 0 }) | opcode;
    frame
}

fn masked_text(payload: &[u8], compressed: bool) -> Vec<u8> {
    let mut frame = vec![if compressed { 0xc1 } else { 0x81 }];
    match payload.len() {
        length @ 0..=125 => frame.push(0x80 | length as u8),
        length @ 126..=65535 => {
            frame.push(0xfe);
            frame.extend_from_slice(&(length as u16).to_be_bytes());
        }
        length => {
            frame.push(0xff);
            frame.extend_from_slice(&(length as u64).to_be_bytes());
        }
    }
    let mask = [0x37, 0xfa, 0x21, 0x3d];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(i, byte)| byte ^ mask[i % 4]),
    );
    frame
}

async fn expect_echo(client: &mut TcpStream, expected: &[u8], compressed: bool) {
    assert_eq!(
        client.read_u8().await.unwrap(),
        if compressed { 0xc1 } else { 0x81 }
    );
    let length = match client.read_u8().await.unwrap() {
        126 => usize::from(client.read_u16().await.unwrap()),
        127 => usize::try_from(client.read_u64().await.unwrap()).unwrap(),
        length @ 0..=125 => usize::from(length),
        other => panic!("unexpected server length byte {other:#x}"),
    };
    let mut wire = vec![0; length];
    client.read_exact(&mut wire).await.unwrap();
    if compressed {
        // The echo is inflated under the same bound the scratch server accepts.
        let mut body = Body::compressed_with_limit(LARGEST);
        body.begin(true);
        body.feed(&wire, true).unwrap();
        assert_eq!(body.finish().as_slice(), expected);
    } else {
        assert_eq!(wire, expected);
    }
}

async fn large_echo(compressed: bool, size: usize, count: usize) {
    let mut client = connect(compressed).await;
    let payload: Vec<_> = PATTERN.iter().copied().cycle().take(size).collect();
    let wire = if compressed {
        Deflater::new(INFLATE_WINDOW).deflate(&payload).unwrap()
    } else {
        payload.clone()
    };
    let frame = masked_text(&wire, compressed);
    for _ in 0..count {
        client.write_all(&frame).await.unwrap();
        expect_echo(&mut client, &payload, compressed).await;
    }
}

// Each of these sends past the socket's 1 MiB inbound credit, so the reader
// stops after the first message or two unless the echo releases it. Five 256 KiB
// messages are one credit's worth; one 16 MiB message is sixteen.

#[tokio::test]
async fn echoes_256_kib_text_messages_past_the_inbound_credit() {
    timeout(Duration::from_secs(20), large_echo(false, LARGE, 5))
        .await
        .unwrap();
}

#[tokio::test]
async fn echoes_256_kib_text_messages_past_the_inbound_credit_with_deflate() {
    timeout(Duration::from_secs(20), large_echo(true, LARGE, 5))
        .await
        .unwrap();
}

#[tokio::test]
async fn echoes_4_mib_text_messages_past_the_inbound_credit() {
    timeout(Duration::from_secs(30), large_echo(false, LARGEST, 2))
        .await
        .unwrap();
}

#[tokio::test]
async fn echoes_4_mib_text_messages_past_the_inbound_credit_with_deflate() {
    timeout(Duration::from_secs(30), large_echo(true, LARGEST, 2))
        .await
        .unwrap();
}

async fn peer_fin(partial: bool, after_echoes: bool) {
    let mut client = connect(false).await;
    let payload = vec![b'a'; LARGE];
    let frame = masked_text(&payload, false);
    if after_echoes {
        for _ in 0..4 {
            client.write_all(&frame).await.unwrap();
            expect_echo(&mut client, &payload, false).await;
        }
    }
    if partial {
        client.write_all(&frame[..20]).await.unwrap();
    }
    // Send TCP FIN without a WebSocket close. Keep the read half to observe
    // the server dropping its stream.
    client.shutdown().await.unwrap();
    assert_eq!(client.read(&mut [0]).await.unwrap(), 0);
}

#[tokio::test]
async fn drops_an_idle_socket_on_tcp_eof() {
    timeout(Duration::from_secs(5), peer_fin(false, false))
        .await
        .unwrap();
}

#[tokio::test]
async fn drops_a_socket_on_tcp_eof_inside_a_frame() {
    timeout(Duration::from_secs(5), peer_fin(true, false))
        .await
        .unwrap();
}

#[tokio::test]
async fn drops_an_idle_socket_on_tcp_eof_after_echoing() {
    timeout(Duration::from_secs(5), peer_fin(false, true))
        .await
        .unwrap();
}

#[tokio::test]
async fn drops_a_socket_on_tcp_eof_inside_a_frame_after_echoing() {
    timeout(Duration::from_secs(5), peer_fin(true, true))
        .await
        .unwrap();
}

#[tokio::test]
async fn echoes_the_suites_4_mib_fragment_case() {
    // 9.3.1/9.4.1: 4 MiB in 64-byte fragments and the suite's closing empty
    // fragment, 65,537 frames. The daemon's 16,384 refuses it, and a harness
    // kept at 65,536 refused it in the T1b.5 run; both legs now raise the bound
    // together, and `ws` accepting N frames is what fixes the number.
    let mut client = connect(false).await;
    let payload: Vec<u8> = PATTERN.iter().copied().cycle().take(LARGEST).collect();
    let mut bytes = Vec::with_capacity(LARGEST + 6 * 65_537);
    for (index, chunk) in payload.chunks(64).enumerate() {
        let opcode = if index == 0 { 0x1 } else { 0x0 };
        bytes.extend(masked_fragment(opcode, false, chunk));
    }
    bytes.extend(masked_fragment(0x0, true, b""));
    timeout(Duration::from_secs(60), client.write_all(&bytes))
        .await
        .expect("the fragments are written")
        .expect("the peer reads them");
    timeout(
        Duration::from_secs(60),
        expect_echo(&mut client, &payload, false),
    )
    .await
    .expect("the message is echoed");
}

#[tokio::test]
async fn a_thousand_round_trips_leave_the_next_connection_working() {
    // 9.7.x: 1,000 messages round trip per case, then the suite's next case
    // opens a new connection. A finished connection must not keep the server
    // from accepting.
    let address = server().await;
    let mut client = connect_to(address, false).await;
    let message = masked_fragment(0x1, true, b"case 9.7");
    for _ in 0..1_000 {
        client.write_all(&message).await.unwrap();
        expect_echo(&mut client, b"case 9.7", false).await;
    }
    client.shutdown().await.unwrap();

    let mut next = timeout(Duration::from_secs(1), connect_to(address, false))
        .await
        .expect("the next connection is accepted and upgraded at once");
    next.write_all(&masked_fragment(0x1, true, b"after"))
        .await
        .unwrap();
    expect_echo(&mut next, b"after", false).await;
}

/// A listener whose first `fails` accepts fail the way `EMFILE` does, then a
/// real one.
struct FailingOnce {
    listener: TcpListener,
    fails: usize,
}

impl Connections for FailingOnce {
    fn accept(
        &mut self,
    ) -> impl Future<Output = std::io::Result<(TcpStream, std::net::SocketAddr)>> {
        let failure = (self.fails > 0).then(|| {
            self.fails -= 1;
            std::io::Error::from_raw_os_error(24) // EMFILE
        });
        async move {
            match failure {
                Some(error) => Err(error),
                None => self.listener.accept().await,
            }
        }
    }
}

#[tokio::test]
async fn an_accept_that_fails_is_reported_once_and_the_listener_keeps_serving() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handler = WebSocketUpgrades::with_deflate(
        Arc::new(AcceptAll {
            next: AtomicU64::new(1),
        }),
        Arc::new(Echo),
    );
    // Three failures in a row, then the real listener: the loop must report the
    // run once, back off, and serve the connection that follows.
    let failures = Arc::new(AtomicU64::new(0));
    let counted = Arc::clone(&failures);
    tokio::spawn(accept_loop(
        FailingOnce { listener, fails: 3 },
        Arc::new(handler),
        move |_| {
            counted.fetch_add(1, Ordering::Relaxed);
        },
    ));

    let mut client = timeout(Duration::from_secs(2), connect_to(address, false))
        .await
        .expect("the connection after the failures is served");
    client
        .write_all(&masked_fragment(0x1, true, b"after"))
        .await
        .unwrap();
    timeout(
        Duration::from_secs(2),
        expect_echo(&mut client, b"after", false),
    )
    .await
    .expect("the echo arrives");
    assert_eq!(
        failures.load(Ordering::Relaxed),
        1,
        "a run of accept failures is reported once"
    );
}
