// SPDX-License-Identifier: Apache-2.0
//! The private control socket: accepts the priority and egress lanes once each, for the holder
//! of the lane secret, and refuses every other connection by closing it without a word.
use super::budget::Cap;
use crate::auth::{LANE_ACCEPTED, LaneAuth, SocketLane, Verdict};
use crate::secret::LaneSecret;
use media_wire::lane::{HELLO_LEN, NONCE_LEN, PROOF_LEN};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{mpsc, oneshot};

/// How long a connection may take to send its hello and its proof.
const HELLO_WITHIN: Duration = Duration::from_secs(5);
/// Connections still sending their hello at once; more are closed at accept.
const MAX_PENDING: usize = 8;

pub struct Lanes {
    pub priority: UnixStream,
    pub egress: UnixStream,
}

/// Serves the control socket for the process's lifetime. The lanes arrive once both are up.
pub fn serve(listener: UnixListener, secret: LaneSecret) -> oneshot::Receiver<Lanes> {
    let (done, lanes) = oneshot::channel();
    let auth = Arc::new(Mutex::new(LaneAuth::new(secret)));
    let pending = Cap::new(MAX_PENDING);
    tokio::spawn(async move {
        let (accepted_tx, mut accepted) = mpsc::channel::<(SocketLane, UnixStream)>(2);
        let mut done = Some(done);
        let (mut priority, mut egress) = (None, None);
        loop {
            tokio::select! {
                connection = listener.accept() => {
                    let Ok((stream, _)) = connection else { continue };
                    let Some(slot) = pending.take() else { continue };
                    let (auth, accepted) = (auth.clone(), accepted_tx.clone());
                    tokio::spawn(async move {
                        hello(stream, auth, accepted).await;
                        drop(slot);
                    });
                }
                Some((lane, stream)) = accepted.recv() => {
                    match lane {
                        SocketLane::Priority => priority = Some(stream),
                        SocketLane::Egress => egress = Some(stream),
                    }
                    if priority.is_some() && egress.is_some()
                        && let (Some(done), Some(priority), Some(egress)) =
                            (done.take(), priority.take(), egress.take())
                    {
                        let _ = done.send(Lanes { priority, egress });
                    }
                }
            }
        }
    });
    lanes
}

async fn hello(
    mut stream: UnixStream,
    auth: Arc<Mutex<LaneAuth>>,
    accepted: mpsc::Sender<(SocketLane, UnixStream)>,
) {
    let handshake = async {
        let mut hello = [0u8; HELLO_LEN];
        stream.read_exact(&mut hello).await.ok()?;
        // Fresh for every connection: a proof from another one can't match it.
        let mut nonce = [0u8; NONCE_LEN];
        ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut nonce).ok()?;
        let challenge = auth.lock().ok()?.challenge(&hello, nonce)?;
        stream.write_all(challenge.reply()).await.ok()?;
        let mut proof = zeroize::Zeroizing::new([0u8; PROOF_LEN]);
        stream.read_exact(&mut proof[..]).await.ok()?;
        let verdict = auth.lock().ok()?.accept(&challenge, &proof[..]);
        Some(verdict)
    };
    let Ok(Some(Verdict::Accept(lane))) = tokio::time::timeout(HELLO_WITHIN, handshake).await
    else {
        return;
    };
    if stream.write_all(&[LANE_ACCEPTED]).await.is_ok() {
        let _ = accepted.send((lane, stream)).await;
    }
}
