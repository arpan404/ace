// SPDX-License-Identifier: Apache-2.0
//! The blocking WebSocket a host dials a relay with (`apps/relay/src/socket.ts`): the address
//! rules of `relayAddress`, the upgrade with its subprotocol and app header, binary frames only,
//! the frame bound, a read timeout that lets the caller run liveness, and a close that says why.
//!
//! The read timeout is the caller's clock: `next` reports `Idle` when it passes, so the host pings
//! and — past its idle deadline — terminates, as `watchLiveness` does (`liveness.ts`).

use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tungstenite::ClientRequestBuilder;
use tungstenite::error::{Error as WsError, ProtocolError};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::cipher::MAX_MESSAGE;
use crate::error::RelayError;

/// What one read produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    /// One data frame, as the relay sent it.
    Data(Vec<u8>),
    /// The read timeout passed with nothing read.
    Idle,
    /// The peer's close handshake. The socket is finished.
    Closed { code: u16, reason: String },
}

/// How long a dial and a read may take.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    /// One read: also the caller's ping interval, so an idle peer is noticed promptly.
    pub read: Duration,
}

/// A relay URL with a path and query, exactly as `relayAddress` builds it.
pub fn relay_address(base: &str, path: &str, query: &[(&str, &str)]) -> Result<String, RelayError> {
    let mut url = url::Url::parse(base).map_err(|_| RelayError::Address(base.to_owned()))?;
    if !matches!(url.scheme(), "ws" | "wss") {
        return Err(RelayError::Address(base.to_owned()));
    }
    url.set_path(path);
    url.set_query(None);
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    url.set_fragment(None);
    Ok(url.to_string())
}

/// A dialed relay socket.
pub struct Link {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    finished: bool,
}

impl Link {
    /// Dial `url` (a `ws`/`wss` address, already through [`relay_address`]).
    pub fn dial(
        url: &str,
        protocols: &[String],
        ace_client: Option<&str>,
        timeouts: Timeouts,
    ) -> Result<Self, RelayError> {
        let parsed = url::Url::parse(url).map_err(|_| RelayError::Address(url.to_owned()))?;
        let tls = parsed.scheme() == "wss";
        let host = parsed
            .host_str()
            .ok_or_else(|| RelayError::Address(url.to_owned()))?;
        let port = parsed
            .port_or_known_default()
            .unwrap_or(if tls { 443 } else { 80 });
        let addresses: Vec<_> = (host, port)
            .to_socket_addrs()
            .map_err(|_| RelayError::Address(url.to_owned()))?
            .collect();
        let mut last = None;
        let mut stream = None;
        for address in &addresses {
            match TcpStream::connect_timeout(address, timeouts.connect) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(error) => last = Some(error),
            }
        }
        let Some(stream) = stream else {
            return Err(RelayError::Address(format!(
                "{}: {}",
                url,
                last.map(|error| error.to_string()).unwrap_or_default()
            )));
        };
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(timeouts.read));
        let _ = stream.set_write_timeout(Some(timeouts.connect));

        let uri = parsed
            .as_str()
            .parse::<tungstenite::http::Uri>()
            .map_err(|_| RelayError::Address(url.to_owned()))?;
        let mut request = ClientRequestBuilder::new(uri);
        for protocol in protocols {
            request = request.with_sub_protocol(protocol.clone());
        }
        if let Some(name) = ace_client {
            request = request.with_header("x-ace-client", name);
        }
        let config = Some(
            WebSocketConfig::default()
                .max_frame_size(Some(MAX_MESSAGE))
                .max_message_size(Some(MAX_MESSAGE)),
        );
        let handshaked = if tls {
            tungstenite::client_tls_with_config(request, stream, config, None)
        } else {
            tungstenite::client::client_with_config(request, MaybeTlsStream::Plain(stream), config)
        };
        let socket = match handshaked {
            Ok((socket, _response)) => socket,
            Err(tungstenite::HandshakeError::Failure(error)) => {
                return Err(handshake_error(error));
            }
            Err(tungstenite::HandshakeError::Interrupted(_)) => {
                return Err(RelayError::Protocol("Relay upgrade was interrupted"));
            }
        };
        Ok(Self {
            socket,
            finished: false,
        })
    }

    /// One binary data frame. The relay's protocol carries nothing else.
    pub fn send(&mut self, frame: &[u8]) -> Result<(), RelayError> {
        if self.finished {
            return Err(RelayError::Protocol("Relay connection closed"));
        }
        self.socket
            .send(Message::binary(tungstenite::Bytes::copy_from_slice(frame)))
            .map_err(|error| socket_error(error, &mut self.finished))
    }

    /// The keep-alive probe (`socket.ping()`).
    pub fn ping(&mut self) -> Result<(), RelayError> {
        if self.finished {
            return Ok(());
        }
        self.socket
            .send(Message::Ping(tungstenite::Bytes::new()))
            .map_err(|error| socket_error(error, &mut self.finished))
    }

    /// The next data frame, an idle timeout, or the peer's close. A text frame is refused: every
    /// relay frame is binary.
    pub fn read(&mut self) -> Result<Incoming, RelayError> {
        if self.finished {
            return Ok(Incoming::Closed {
                code: 1006,
                reason: String::new(),
            });
        }
        loop {
            match self.socket.read() {
                Ok(Message::Binary(bytes)) => return Ok(Incoming::Data(bytes.to_vec())),
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => continue,
                Ok(Message::Text(_)) => {
                    self.terminate();
                    return Err(RelayError::Protocol("Binary frames required"));
                }
                Ok(Message::Close(frame)) => {
                    self.finished = true;
                    return Ok(Incoming::Closed {
                        code: frame.as_ref().map_or(1005, |frame| u16::from(frame.code)),
                        reason: frame
                            .map(|frame| frame.reason.to_string())
                            .unwrap_or_default(),
                    });
                }
                Ok(Message::Frame(_)) => continue,
                Err(WsError::Io(error))
                    if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    return Ok(Incoming::Idle);
                }
                Err(error) => return Err(socket_error(error, &mut self.finished)),
            }
        }
    }

    /// What is queued for writing, for a channel's backpressure report. Sends are synchronous,
    /// so nothing of ours waits in the socket unless a write half-completed.
    pub fn buffered(&self) -> usize {
        0
    }

    /// The close handshake once what was queued has gone out.
    pub fn close(mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        let _ = self.socket.flush();
        let _ = self.socket.close(None);
        let _ = self.socket.flush();
    }

    /// Drop the connection without a close handshake (a refusal's timing depends on it).
    pub fn terminate(&mut self) {
        self.finished = true;
        match self.socket.get_mut() {
            MaybeTlsStream::Plain(stream) => {
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
            #[allow(unreachable_patterns)]
            MaybeTlsStream::Rustls(stream) => {
                let _ = stream.sock.shutdown(std::net::Shutdown::Both);
            }
            _ => {}
        }
    }
}

fn socket_error(error: WsError, finished: &mut bool) -> RelayError {
    *finished = true;
    match error {
        WsError::Protocol(ProtocolError::ResetWithoutClosingHandshake) => RelayError::Closed {
            code: 1006,
            reason: String::new(),
        },
        WsError::ConnectionClosed => RelayError::Closed {
            code: 1000,
            reason: String::new(),
        },
        WsError::Io(error) => RelayError::Closed {
            code: 1006,
            reason: error.to_string(),
        },
        other => RelayError::Closed {
            code: 1006,
            reason: other.to_string(),
        },
    }
}

fn handshake_error(error: WsError) -> RelayError {
    RelayError::Closed {
        code: 1006,
        reason: format!("Relay upgrade refused: {error}"),
    }
}

#[cfg(test)]
mod tests;
