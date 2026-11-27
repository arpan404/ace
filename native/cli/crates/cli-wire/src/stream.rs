// SPDX-License-Identifier: Apache-2.0
//! Blocking TCP and TLS transport streams with per-syscall absolute deadline enforcement and
//! deadline-bounded DNS resolution.

use std::fmt;
use std::io::{self, ErrorKind, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use crate::error::WireError;

/// A [`TcpStream`] wrapper that recomputes the remaining time until an absolute [`Instant`]
/// deadline before every single `read`, `write`, and `flush` call.
///
/// This guarantees that multi-read operations (TLS handshakes, WebSocket HTTP upgrades, partial
/// frames trickled byte-by-byte) can never overrun the caller's deadline.
#[derive(Debug)]
pub struct DeadlineTcpStream {
    tcp: TcpStream,
    deadline: Option<Instant>,
}

impl DeadlineTcpStream {
    /// Wraps a connected [`TcpStream`] with an optional absolute deadline.
    #[must_use]
    pub const fn new(tcp: TcpStream, deadline: Option<Instant>) -> Self {
        Self { tcp, deadline }
    }

    /// Underlying [`TcpStream`].
    #[must_use]
    pub const fn inner(&self) -> &TcpStream {
        &self.tcp
    }

    /// Updates the active absolute deadline, failing immediately if it is already spent.
    pub fn set_deadline(
        &mut self,
        deadline: Instant,
        context: &'static str,
    ) -> Result<Duration, WireError> {
        let remaining = remaining_until(deadline, context)?;
        self.deadline = Some(deadline);
        Ok(remaining)
    }

    fn remaining_io(&self) -> io::Result<Option<Duration>> {
        let Some(deadline) = self.deadline else {
            return Ok(None);
        };
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .map(Some)
            .ok_or_else(|| io::Error::new(ErrorKind::TimedOut, "deadline exceeded"))
    }
}

impl Read for DeadlineTcpStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if let Some(remaining) = self.remaining_io()? {
            self.tcp.set_read_timeout(Some(remaining))?;
        }
        self.tcp.read(buf)
    }
}

impl Write for DeadlineTcpStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if let Some(remaining) = self.remaining_io()? {
            self.tcp.set_write_timeout(Some(remaining))?;
        }
        self.tcp.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(remaining) = self.remaining_io()? {
            self.tcp.set_write_timeout(Some(remaining))?;
        }
        self.tcp.flush()
    }
}

/// A blocking byte stream to a local (`Plain`) or pinned-TLS remote (`Tls`) daemon.
pub enum TransportStream {
    /// Local loopback TCP stream.
    Plain(DeadlineTcpStream),
    /// Remote TLS stream verified with certificate public-key pinning.
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, DeadlineTcpStream>>),
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
            Self::Plain(stream) => stream.inner(),
            Self::Tls(tls) => tls.get_ref().inner(),
        }
    }

    /// Sets the active absolute deadline enforced before every underlying read/write syscall.
    pub fn set_deadline(
        &mut self,
        deadline: Instant,
        context: &'static str,
    ) -> Result<Duration, WireError> {
        match self {
            Self::Plain(stream) => stream.set_deadline(deadline, context),
            Self::Tls(tls) => tls.get_mut().set_deadline(deadline, context),
        }
    }

    /// Best-effort shutdown of the underlying TCP connection.
    pub fn shutdown_both(&self) {
        let _ = self.tcp().shutdown(Shutdown::Both);
    }
}

impl Read for TransportStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.read(buf),
            Self::Tls(tls) => tls.read(buf),
        }
    }
}

impl Write for TransportStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Plain(stream) => stream.write(buf),
            Self::Tls(tls) => tls.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Plain(stream) => stream.flush(),
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
pub fn connect_local_tcp(
    addr: SocketAddr,
    deadline: Instant,
) -> Result<DeadlineTcpStream, WireError> {
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
    Ok(DeadlineTcpStream::new(stream, Some(deadline)))
}

/// Resolves `host:port` on a helper thread bounded by `deadline`, avoiding unbounded DNS stalls.
pub fn resolve_within_deadline(
    host: &str,
    port: u16,
    deadline: Instant,
) -> Result<Vec<SocketAddr>, WireError> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let remaining = remaining_until(deadline, "Connection")?;
    let host_owned = host.to_owned();
    let (tx, rx) = mpsc::channel();
    thread::Builder::new()
        .name("cli-wire-dns".into())
        .spawn(move || {
            let result = (host_owned.as_str(), port)
                .to_socket_addrs()
                .map(Iterator::collect::<Vec<SocketAddr>>);
            let _ = tx.send(result);
        })
        .map_err(|err| WireError::Offline {
            detail: format!("Failed to start DNS resolver: {err}"),
        })?;

    match rx.recv_timeout(remaining) {
        Ok(Ok(addrs)) if !addrs.is_empty() => Ok(addrs),
        Ok(Ok(_)) => Err(WireError::Offline {
            detail: format!("No addresses resolved for {host}:{port}"),
        }),
        Ok(Err(err)) => Err(WireError::Offline {
            detail: format!("Failed to resolve {host}:{port}: {err}"),
        }),
        Err(RecvTimeoutError::Timeout) => Err(WireError::Timeout {
            context: "Connection",
        }),
        Err(RecvTimeoutError::Disconnected) => Err(WireError::Offline {
            detail: format!("DNS resolver exited unexpectedly for {host}:{port}"),
        }),
    }
}

/// Connects to a remote host and port within `deadline` (bounding both DNS and TCP connect).
pub fn connect_remote_tcp(
    host: &str,
    port: u16,
    deadline: Instant,
) -> Result<DeadlineTcpStream, WireError> {
    let addrs = resolve_within_deadline(host, port, deadline)?;

    let mut last_err: Option<io::Error> = None;
    for addr in addrs {
        let timeout = remaining_until(deadline, "Connection")?;
        match TcpStream::connect_timeout(&addr, timeout) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(DeadlineTcpStream::new(stream, Some(deadline)));
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
