// SPDX-License-Identifier: Apache-2.0
//! TLS to a `wss://` relay (ace's hosted relay), with rustls on ring.
//!
//! - **Trust.** The relay's certificate is verified against the OS trust store, read once
//!   (`rustls-native-certs`, which also honours `SSL_CERT_FILE` and `SSL_CERT_DIR`, as OpenSSL
//!   tools do). Nothing is pinned, no invalid certificate is ever accepted, and there is no
//!   switch to skip verification. The name checked, and sent as SNI, is the relay URL's host.
//! - **No allocation per frame.** rustls's buffered connection queues a `Vec` per outgoing
//!   record, so this drives the unbuffered API instead: records are encrypted into one outgoing
//!   buffer sized once for the largest frame, and received records are decrypted in place in an
//!   incoming buffer, also sized once.
//!
//! One task owns the socket and the connection; reading and writing take turns in it.
use rustls::client::UnbufferedClientConnection;
use rustls::pki_types::ServerName;
use rustls::unbuffered::{ConnectionState, UnbufferedStatus};
use rustls::{ClientConfig, RootCertStore};
use std::io;
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;

use super::relay::{Out, RelayEvent};
use super::relay_ws::{self, Masks, OP_BINARY, OP_CLOSE, OP_PING, OP_PONG};
use crate::engine::relay::Pool;
use media_wire::control::Id;

/// Received TLS bytes held at once: more than one whole record (16 KiB plus overhead).
const INCOMING: usize = 64 * 1024;
/// One frame's records: a 14-byte WebSocket header and a 65,535-byte payload come to five
/// records of at most 16 KiB, each with its few bytes of record overhead.
const OUTGOING: usize = 80 * 1024;

/// The client configuration, built once from the OS trust store. `Err` when no root loads.
fn config() -> Result<Arc<ClientConfig>, &'static str> {
    static CONFIG: OnceLock<Result<Arc<ClientConfig>, &'static str>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            let (added, _unparsable) =
                roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            if added == 0 {
                return Err("tls-no-roots");
            }
            let provider = Arc::new(rustls::crypto::ring::default_provider());
            let config = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|_| "tls-config")?
                .with_root_certificates(roots)
                .with_no_client_auth();
            Ok(Arc::new(config))
        })
        .clone()
}

fn failed(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("tls: {error}"))
}

/// What the connection needs next.
enum Step {
    /// More records from the relay.
    Read,
    /// `outgoing[..n]` must reach the relay.
    Transmit(usize),
    /// Application data may be written (and nothing whole is left to read).
    Writable,
    Closed,
}

pub struct Tls {
    tcp: TcpStream,
    conn: UnbufferedClientConnection,
    incoming: Vec<u8>,
    used: usize,
    outgoing: Vec<u8>,
}

impl Tls {
    /// The handshake with `name` (the relay's host). Fails on any certificate the trust store
    /// doesn't vouch for that name: expired, for another host, or from an unknown CA.
    pub async fn connect(tcp: TcpStream, name: &str) -> io::Result<Self> {
        let config = config().map_err(failed)?;
        let server = ServerName::try_from(name.to_owned()).map_err(failed)?;
        let conn = UnbufferedClientConnection::new(config, server).map_err(failed)?;
        let mut tls = Self {
            tcp,
            conn,
            incoming: vec![0; INCOMING],
            used: 0,
            outgoing: vec![0; OUTGOING],
        };
        let mut early = Vec::new();
        tls.settle(&mut early).await?;
        if !early.is_empty() {
            return Err(failed("data before the handshake finished"));
        }
        Ok(tls)
    }

    /// Waits until the socket has something to read.
    pub async fn wait_readable(&self) -> io::Result<()> {
        self.tcp.readable().await
    }

    /// Processes what has arrived until the connection can write, transmitting what it asks
    /// to and reading only while the handshake is blocked; decrypted data is appended to `plain`.
    async fn settle(&mut self, plain: &mut Vec<u8>) -> io::Result<()> {
        loop {
            match self.process(plain)? {
                Step::Writable => return Ok(()),
                Step::Transmit(n) => self.tcp.write_all(&self.outgoing[..n]).await?,
                Step::Read => self.read_more().await?,
                Step::Closed => return Err(io::ErrorKind::UnexpectedEof.into()),
            }
        }
    }

    async fn read_more(&mut self) -> io::Result<()> {
        if self.used == self.incoming.len() {
            return Err(failed("record larger than the incoming buffer"));
        }
        let n = self.tcp.read(&mut self.incoming[self.used..]).await?;
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        self.used += n;
        Ok(())
    }

    /// Reads what the socket has now, without waiting. False when the relay closed it.
    pub fn read_ready(&mut self) -> io::Result<bool> {
        if self.used == self.incoming.len() {
            return Err(failed("record larger than the incoming buffer"));
        }
        match self.tcp.try_read(&mut self.incoming[self.used..]) {
            Ok(0) => Ok(false),
            Ok(n) => {
                self.used += n;
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(true),
            Err(error) => Err(error),
        }
    }

    /// Decrypts every whole record received, appending its data to `plain`, and answers what
    /// the connection asks for (a key update, an alert).
    pub async fn receive(&mut self, plain: &mut Vec<u8>) -> io::Result<()> {
        loop {
            match self.process(plain)? {
                Step::Writable | Step::Read => return Ok(()),
                Step::Transmit(n) => self.tcp.write_all(&self.outgoing[..n]).await?,
                Step::Closed => return Err(io::ErrorKind::UnexpectedEof.into()),
            }
        }
    }

    /// Ends the connection gracefully: TLS's close_notify, normal linger (what the kernel holds
    /// is delivered, not reset), then our FIN.
    pub async fn finish(&mut self) -> io::Result<()> {
        let mut plain = Vec::new();
        self.settle(&mut plain).await?;
        let n = {
            let UnbufferedStatus { state, .. } = self.conn.process_tls_records(&mut []);
            let ConnectionState::WriteTraffic(mut writer) = state.map_err(failed)? else {
                return Err(failed("not writable"));
            };
            writer
                .queue_close_notify(&mut self.outgoing)
                .map_err(failed)?
        };
        self.tcp.write_all(&self.outgoing[..n]).await?;
        #[allow(deprecated)] // `None` only turns linger off; nothing blocks on drop.
        self.tcp.set_linger(None)?;
        self.tcp.shutdown().await
    }

    /// Encrypts `parts` as application data into the outgoing buffer and writes it in one go.
    /// Data that arrives meanwhile is appended to `plain`.
    pub async fn send(&mut self, parts: &[&[u8]], plain: &mut Vec<u8>) -> io::Result<()> {
        self.settle(plain).await?;
        let mut n = 0;
        {
            let UnbufferedStatus { state, .. } = self.conn.process_tls_records(&mut []);
            let ConnectionState::WriteTraffic(mut writer) = state.map_err(failed)? else {
                return Err(failed("not writable"));
            };
            for part in parts {
                n += writer
                    .encrypt(part, &mut self.outgoing[n..])
                    .map_err(failed)?;
            }
        }
        self.tcp.write_all(&self.outgoing[..n]).await
    }

    fn process(&mut self, plain: &mut Vec<u8>) -> io::Result<Step> {
        let mut encoded = 0;
        loop {
            let UnbufferedStatus { mut discard, state } = self
                .conn
                .process_tls_records(&mut self.incoming[..self.used]);
            let step = match state.map_err(failed)? {
                ConnectionState::ReadTraffic(mut traffic) => {
                    while let Some(record) = traffic.next_record() {
                        let record = record.map_err(failed)?;
                        discard += record.discard;
                        plain.extend_from_slice(record.payload);
                    }
                    None
                }
                ConnectionState::EncodeTlsData(mut data) => {
                    encoded += data.encode(&mut self.outgoing[encoded..]).map_err(failed)?;
                    None
                }
                ConnectionState::TransmitTlsData(transmit) => {
                    transmit.done();
                    Some(Step::Transmit(encoded))
                }
                ConnectionState::BlockedHandshake => Some(Step::Read),
                ConnectionState::WriteTraffic(_) => Some(Step::Writable),
                ConnectionState::PeerClosed | ConnectionState::Closed => Some(Step::Closed),
                _ => return Err(failed("unexpected state")),
            };
            if discard > 0 {
                self.incoming.copy_within(discard..self.used, 0);
                self.used -= discard;
            }
            if let Some(step) = step {
                return Ok(step);
            }
        }
    }
}

/// One TLS stream's socket: frames from the relay go to the main loop as they come whole, and
/// queued frames (sealed, in pooled buffers) are masked in place, encrypted into the outgoing
/// buffer and written, their buffers returned to the pool.
pub(super) async fn pump_tls(
    stream: Id,
    mut tls: Box<Tls>,
    mut plain: Vec<u8>,
    mut rx: mpsc::Receiver<Out>,
    events: mpsc::Sender<RelayEvent>,
    pool: Pool,
) {
    let mut masks = Masks::new();
    let reason = 'pump: loop {
        // Every whole frame received so far, before waiting again.
        loop {
            match relay_ws::take_frame(&mut plain) {
                Err(reason) => break 'pump reason,
                Ok(None) => break,
                Ok(Some((OP_BINARY, frame))) => {
                    let event = RelayEvent::Frame {
                        stream: stream.clone(),
                        frame,
                    };
                    if events.send(event).await.is_err() {
                        return;
                    }
                }
                Ok(Some((OP_PING, mut data))) => {
                    let key = masks.next();
                    let (head, n) = relay_ws::header(OP_PONG, data.len(), key);
                    relay_ws::mask(&mut data, key);
                    if tls.send(&[&head[..n], &data], &mut plain).await.is_err() {
                        break 'pump "write";
                    }
                }
                Ok(Some((OP_PONG, _))) => {}
                Ok(Some((OP_CLOSE, _))) => break 'pump "closed",
                Ok(Some(_)) => break 'pump "protocol",
            }
        }
        tokio::select! {
            readable = tls.wait_readable() => {
                if readable.is_err() || !matches!(tls.read_ready(), Ok(true)) {
                    break "closed";
                }
                if tls.receive(&mut plain).await.is_err() {
                    break "closed";
                }
            }
            out = rx.recv() => {
                let Some(out) = out else { return };
                let (opcode, mut payload) = match out {
                    Out::Frame(frame) => (OP_BINARY, frame),
                    Out::Pong(data) => (OP_PONG, data),
                    Out::Close => {
                        // A graceful close: the WebSocket close, TLS's close_notify, normal
                        // linger and our FIN; then the relay's side until it closes it.
                        let (head, n) = relay_ws::header(OP_CLOSE, 0, masks.next());
                        if tls.send(&[&head[..n]], &mut plain).await.is_ok() {
                            let _ = tls.finish().await;
                            while tls.wait_readable().await.is_ok()
                                && matches!(tls.read_ready(), Ok(true))
                                && tls.receive(&mut plain).await.is_ok()
                            {
                                plain.clear();
                            }
                        }
                        return;
                    }
                };
                let key = masks.next();
                let (head, n) = relay_ws::header(opcode, payload.len(), key);
                relay_ws::mask(&mut payload, key);
                let written = tls.send(&[&head[..n], &payload], &mut plain).await;
                if opcode == OP_BINARY {
                    pool.give(payload);
                }
                if written.is_err() {
                    break "write";
                }
            }
        }
    };
    let _ = events.send(RelayEvent::Ended { stream, reason }).await;
}
