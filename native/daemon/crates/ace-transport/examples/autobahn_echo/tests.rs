// SPDX-License-Identifier: Apache-2.0

use super::*;
use ace_transport::deflate::{Body, Deflater, INFLATE_WINDOW};
use ace_transport::frame::assemble::MessageBody;
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(3);
const LARGE: usize = 256 * 1024;
const PATTERN: &[u8] = b"BAsd7&jh23";

async fn connect(compressed: bool) -> TcpStream {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let handler = WebSocketUpgrades::with_deflate(
            Arc::new(AcceptAll {
                next: AtomicU64::new(1),
            }),
            Arc::new(Echo),
        );
        serve(Arc::new(handler), stream).await;
    });
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
        let mut body = Body::compressed();
        body.begin(true);
        body.feed(&wire, true).unwrap();
        assert_eq!(body.finish().as_slice(), expected);
    } else {
        assert_eq!(wire, expected);
    }
}

async fn large_echo(compressed: bool, count: usize) {
    let mut client = connect(compressed).await;
    let payload: Vec<_> = PATTERN.iter().copied().cycle().take(LARGE).collect();
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

#[tokio::test]
async fn echoes_one_masked_256_kib_text_frame() {
    timeout(DEADLINE, large_echo(false, 1)).await.unwrap();
}

#[tokio::test]
async fn echoes_one_masked_256_kib_text_message_with_deflate() {
    timeout(DEADLINE, large_echo(true, 1)).await.unwrap();
}

#[tokio::test]
async fn keeps_echoing_after_a_mebibyte_of_delivered_text() {
    timeout(DEADLINE, large_echo(false, 5)).await.unwrap();
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
    timeout(DEADLINE, peer_fin(false, false)).await.unwrap();
}

#[tokio::test]
async fn drops_a_socket_on_tcp_eof_inside_a_frame() {
    timeout(DEADLINE, peer_fin(true, false)).await.unwrap();
}

#[tokio::test]
async fn drops_an_idle_socket_on_tcp_eof_after_echoing() {
    timeout(DEADLINE, peer_fin(false, true)).await.unwrap();
}

#[tokio::test]
async fn drops_a_socket_on_tcp_eof_inside_a_frame_after_echoing() {
    timeout(DEADLINE, peer_fin(true, true)).await.unwrap();
}
