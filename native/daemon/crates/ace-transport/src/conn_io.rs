// SPDX-License-Identifier: Apache-2.0
//! The bytes a connection carries, however it carries them (T1b.1a): the
//! `TcpStream` a loopback listener accepted, or the decrypted stream a remote
//! listener's TLS handshake produced. The connection driver, its prefix and its
//! upgrade handlers are written against this and nothing else, so one
//! implementation serves both listeners.

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::server::TlsStream;

/// One connection's transport, after a listener has finished with it.
pub trait ConnIo: AsyncRead + AsyncWrite + Unpin + Send + 'static {}

impl ConnIo for TcpStream {}
impl ConnIo for TlsStream<TcpStream> {}
