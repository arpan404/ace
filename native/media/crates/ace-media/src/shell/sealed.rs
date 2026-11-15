// SPDX-License-Identifier: Apache-2.0
//! An accepted lane behind its record layer (`crate::lane_cipher`): the shell reads and writes
//! plaintext on a duplex as before, and two tasks seal what it writes into records and open the
//! records that arrive. A record that fails to open ends the lane at once, as a closed lane.
use super::listener::{self, Stream};
use crate::lane_cipher::{MAX_PLAIN, Records};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

/// Bytes the plaintext side may hold in each direction before its writer waits.
const DUPLEX: usize = 256 * 1024;

pub fn sealed(raw: Stream, records: Records) -> DuplexStream {
    let (plain, inner) = tokio::io::duplex(DUPLEX);
    let (mut from_shell, mut to_shell) = tokio::io::split(inner);
    let (mut raw_read, mut raw_write) = listener::split(raw);
    let records = Arc::new(Mutex::new(records));
    let sealer = records.clone();
    tokio::spawn(async move {
        // Both reused for the lane's life: sealing allocates nothing per record.
        let mut chunk = vec![0u8; MAX_PLAIN];
        let mut out = Vec::with_capacity(MAX_PLAIN + 18);
        loop {
            let Ok(n) = from_shell.read(&mut chunk).await else {
                break;
            };
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
    });
    tokio::spawn(async move {
        let mut body = vec![0u8; MAX_PLAIN + 16];
        loop {
            let mut length = [0u8; 2];
            if raw_read.read_exact(&mut length).await.is_err() {
                break;
            }
            let length = usize::from(u16::from_be_bytes(length));
            if !(16..=body.len()).contains(&length)
                || raw_read.read_exact(&mut body[..length]).await.is_err()
            {
                break;
            }
            let opened = match records.lock() {
                Ok(mut records) => records.open(&mut body[..length]).map(|plain| plain.len()),
                Err(_) => break,
            };
            // Modified, replayed, injected or out of sequence: the lane ends here.
            let Ok(plain) = opened else { break };
            if to_shell.write_all(&body[..plain]).await.is_err() {
                break;
            }
        }
        // The shell sees its lane close.
        let _ = to_shell.shutdown().await;
    });
    plain
}
