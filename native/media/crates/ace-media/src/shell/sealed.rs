// SPDX-License-Identifier: Apache-2.0
//! An accepted lane behind its record layer (`crate::lane_cipher`): the shell reads and writes
//! plaintext on a duplex as before, and two tasks seal what it writes into records and open the
//! records that arrive. A record that fails to open ends the lane at once, as a closed lane.
use crate::lane_cipher::{MAX_PLAIN, Records};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, DuplexStream};

/// Bytes the plaintext side may hold in each direction before its writer waits.
const DUPLEX: usize = 256 * 1024;

pub fn sealed<S>(raw: S, records: Records) -> DuplexStream
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (plain, inner) = tokio::io::duplex(DUPLEX);
    let (mut from_shell, mut to_shell) = tokio::io::split(inner);
    let (mut raw_read, mut raw_write) = tokio::io::split(raw);
    let records = Arc::new(Mutex::new(records));
    let sealer = records.clone();
    let opener = records.clone();
    let outbound = async move {
        // Both reused for the lane's life: sealing allocates nothing per record.
        let mut chunk = vec![0u8; MAX_PLAIN];
        let mut out = Vec::with_capacity(MAX_PLAIN + 18);
        while let Ok(n) = from_shell.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            out.clear();
            let sealed = matches!(
                sealer.lock().map(|mut r| r.seal(&chunk[..n], &mut out)),
                Ok(Ok(()))
            );
            if !sealed || raw_write.write_all(&out).await.is_err() {
                break;
            }
        }
        let _ = raw_write.shutdown().await;
    };
    let inbound = async move {
        let mut body = vec![0u8; MAX_PLAIN + 16];
        loop {
            let mut length = [0u8; 2];
            if raw_read.read_exact(&mut length).await.is_err() {
                break;
            }
            let length = usize::from(u16::from_be_bytes(length));
            // A record cut off by the end of the stream fails here, like a bad one.
            if !(16..=body.len()).contains(&length)
                || raw_read.read_exact(&mut body[..length]).await.is_err()
            {
                break;
            }
            let opened = match opener.lock() {
                Ok(mut records) => records.open(&mut body[..length]).map(|plain| plain.len()),
                Err(_) => break,
            };
            // Modified, replayed, injected or out of sequence: the lane ends here.
            let Ok(plain) = opened else { break };
            if to_shell.write_all(&body[..plain]).await.is_err() {
                break;
            }
        }
    };
    // One supervisor for both pumps: when either ends, for any reason, the other is cancelled,
    // both halves of the socket and of the duplex are dropped (closing both directions), and the
    // keys are wiped.
    tokio::spawn(async move {
        tokio::select! {
            () = outbound => {}
            () = inbound => {}
        }
        if let Ok(mut records) = records.lock() {
            records.close();
        }
    });
    plain
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;
    use crate::lane_cipher::derive;
    use crate::secret::LaneSecret;
    use std::time::Duration;

    fn records() -> Records {
        let secret = LaneSecret::from_payload(&[5; 32]).unwrap();
        Records::media_side(derive(&secret, b"transcript")).unwrap()
    }

    /// Both directions are closed: the shell reads its lane's end, and so does the peer.
    async fn both_closed(plain: &mut DuplexStream, peer: &mut DuplexStream) {
        let mut byte = [0u8; 64];
        let shell = tokio::time::timeout(Duration::from_secs(1), plain.read(&mut byte)).await;
        assert!(
            matches!(shell, Ok(Ok(0)) | Ok(Err(_))),
            "the shell's side is still open"
        );
        let raw = tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte)).await;
        assert!(
            matches!(raw, Ok(Ok(0)) | Ok(Err(_))),
            "the socket's sending side is still open"
        );
    }

    #[tokio::test]
    async fn a_half_close_from_the_peer_ends_both_pumps() {
        let (ours, mut peer) = tokio::io::duplex(64 * 1024);
        let mut plain = sealed(ours, records());
        peer.shutdown().await.unwrap();
        both_closed(&mut plain, &mut peer).await;
    }

    #[tokio::test]
    async fn a_record_cut_off_by_the_peer_ends_both_pumps() {
        let (ours, mut peer) = tokio::io::duplex(64 * 1024);
        let mut plain = sealed(ours, records());
        peer.write_all(&[0, 40]).await.unwrap();
        peer.write_all(&[1; 10]).await.unwrap();
        peer.shutdown().await.unwrap();
        both_closed(&mut plain, &mut peer).await;
    }

    #[tokio::test]
    async fn the_shell_closing_its_side_ends_the_socket_both_ways() {
        let (ours, mut peer) = tokio::io::duplex(64 * 1024);
        let plain = sealed(ours, records());
        drop(plain);
        let mut byte = [0u8; 64];
        let raw = tokio::time::timeout(Duration::from_secs(1), peer.read(&mut byte)).await;
        assert!(
            matches!(raw, Ok(Ok(0)) | Ok(Err(_))),
            "the socket stayed open"
        );
        // And the receiving pump let go: a write from the peer finds nobody.
        let write = tokio::time::timeout(Duration::from_secs(1), async {
            for _ in 0..64 {
                if peer.write_all(&[0; 1024]).await.is_err() {
                    return true;
                }
            }
            false
        })
        .await;
        assert!(
            matches!(write, Ok(true)),
            "the receiving pump is still reading"
        );
    }
}
