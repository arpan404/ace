// SPDX-License-Identifier: Apache-2.0
//! Blocking TCP and TLS transport stream with deadline enforcement.

use std::fmt;
use std::io::{self, ErrorKind, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

use crate::error::WireError;

/// A blocking byte stream to a local (`Plain`) or pinned-TLS remote (`Tls`) daemon.
pub enum TransportStream {
    /// Local loopback TCP stream.
    Plain(TcpStream),
    /// Remote TLS stream verified with certificate public-key pinning.
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl fmt::Debug for TransportStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Plain(_) => f.write_str("TransportStream::Plain(..)"),
            Self::Tls(_) => f.write_str("TransportStream::Tls(..)"),
        }
    }
}

impl TransportStream {
    /// Underlying TCP socket.
    #[must_use]
    pub fn tcp(&self) -> &TcpStream {
        match self {
            Self::Plain(tcp) => tcp,
            Self::Tls(tls) => tls.get_ref(),
        }
    }

    /// Applies the remaining time before `deadline` as both read and write socket timeouts.
    pub fn apply_deadline(
        &self,
        deadline: Instant,
        context: &'static str,
    ) -> Result<Duration, WireError> {
        let remaining = remaining_until(deadline, context)?;
        let tcp = self.tcp();
        tcp.set_read_timeout(Some(remaining))
            .map_err(|e| WireError::Offline {
                detail: format!("Failed to set read timeout: {e}"),
            })?;
        tcp.set_write_timeout(Some(remaining))
            .map_err(|e| WireError::Offline {
                detail: format!("Failed to set write timeout: {e}"),
            })?;
        Ok(remaining)
    }

    /// Best-effort shutdown of the underlying TCP connection.
    pub fn shutdown_both(&self) {
        let _ = self.tcp().shutdown(Shutdown::Both);
    }
}

impl Read for TransportStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(tcp) => tcp.read(buf),
            Self::Tls(tls) => tls.read(buf),
        }
    }
}

impl Write for TransportStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(tcp) => tcp.write(buf),
            Self::Tls(tls) => tls.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(tcp) => tcp.flush(),
            Self::Tls(tls) => tls.flush(),
        }
    }
}

/// Computes remaining time before `deadline`, returning [`WireError::Timeout`] if already expired.
pub fn remaining_until(deadline: Instant, context: &'static str) -> Result<Duration, WireError> {
    let remaining = deadline
        .checked_duration_since(Instant::now())
        .ok_or(WireError::Timeout { context })?;
    if remaining.is_zero() {
        return Err(WireError::Timeout { context });
    }
    Ok(remaining)
}

/// Connects to a local loopback daemon socket within `deadline`, mapping active refusal to
/// [`WireError::DaemonDown`].
pub fn connect_local_tcp(addr: SocketAddr, deadline: Instant) -> Result<TcpStream, WireError> {
    let timeout = remaining_until(deadline, "Connection")?;
    let stream = TcpStream::connect_timeout(&addr, timeout).map_err(|err| match err.kind() {
        ErrorKind::ConnectionRefused | ErrorKind::ConnectionReset => WireError::DaemonDown,
        ErrorKind::TimedOut | ErrorKind::WouldBlock => WireError::Timeout {
            context: "Connection",
        },
        _ => WireError::Offline {
            detail: format!("Failed to connect to local daemon: {err}"),
        },
    })?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Connects to a remote host and port within `deadline`.
pub fn connect_remote_tcp(
    host: &str,
    port: u16,
    deadline: Instant,
) -> Result<TcpStream, WireError> {
    let addrs: Vec<SocketAddr> = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        (host, port)
            .to_socket_addrs()
            .map_err(|err| WireError::Offline {
                detail: format!("Failed to resolve {host}:{port}: {err}"),
            })?
            .collect()
    };

    if addrs.is_empty() {
        return Err(WireError::Offline {
            detail: format!("No addresses resolved for {host}:{port}"),
        });
    }

    let mut last_err: Option<io::Error> = None;
    for addr in addrs {
        let timeout = remaining_until(deadline, "Connection")?;
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(err) => {
                if matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)
                    && deadline <= Instant::now()
                {
                    return Err(WireError::Timeout {
                        context: "Connection",
                    });
                }
                last_err = Some(err);
            }
        }
    }

    Err(match last_err {
        Some(err) if matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
            WireError::Timeout {
                context: "Connection",
            }
        }
        Some(err) => WireError::Offline {
            detail: format!("Failed to connect to {host}:{port}: {err}"),
        },
        None => WireError::Offline {
            detail: format!("Failed to connect to {host}:{port}"),
        },
    })
}

/// Classifies a socket I/O error into [`WireError::Timeout`] or [`WireError::Offline`].
#[must_use]
pub fn classify_io_error(err: &io::Error, context: &'static str) -> WireError {
    if matches!(err.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) {
        WireError::Timeout { context }
    } else {
        WireError::Offline {
            detail: err.to_string(),
        }
    }
}
