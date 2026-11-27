// SPDX-License-Identifier: Apache-2.0
//! `ureq` v3 [`Connector`] and [`Transport`] adapters wrapping our pinned `rustls::ClientConfig`.

use std::fmt;
use std::io::{self, Read, Write};
use std::sync::Arc;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, Error as RustlsError, StreamOwned};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, Either, LazyBuffers, NextTimeout, Transport,
    TransportAdapter,
};

/// `ureq` v3 [`Connector`] wrapping a chained TCP transport with our pinned `rustls::ClientConfig`.
pub(crate) struct PinnedTlsConnector {
    rustls_config: Arc<ClientConfig>,
}

impl PinnedTlsConnector {
    pub(crate) const fn new(rustls_config: Arc<ClientConfig>) -> Self {
        Self { rustls_config }
    }
}

impl fmt::Debug for PinnedTlsConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PinnedTlsConnector").finish()
    }
}

impl<In: Transport> Connector<In> for PinnedTlsConnector {
    type Out = Either<In, PinnedTlsTransport>;

    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<In>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        let Some(transport) = chained else {
            return Err(ureq::Error::Tls(
                "PinnedTlsConnector requires a chained TCP transport",
            ));
        };
        if !details.needs_tls() || transport.is_tls() {
            return Ok(Some(Either::A(transport)));
        }

        let host = details
            .uri
            .host()
            .ok_or(ureq::Error::Tls("Missing host for TLS"))?;
        let bare_host = host
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .unwrap_or(host);
        let server_name = ServerName::try_from(bare_host.to_owned())
            .map_err(|_| ureq::Error::Tls("Invalid TLS server name"))?;

        let mut conn = ClientConnection::new(Arc::clone(&self.rustls_config), server_name)?;
        let mut sock = TransportAdapter::new(transport.boxed(), Arc::clone(&details.current_time));
        sock.set_timeout(details.timeout);
        while conn.is_handshaking() {
            match conn.complete_io(&mut sock) {
                Ok((0, 0)) if conn.is_handshaking() => {
                    return Err(ureq::Error::Io(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "TLS peer closed during handshake",
                    )));
                }
                Ok(_) => {}
                Err(io_err) => return Err(extract_ureq_tls_error(io_err)),
            }
        }

        let buffers = LazyBuffers::new(
            details.config.input_buffer_size(),
            details.config.output_buffer_size(),
        );
        Ok(Some(Either::B(PinnedTlsTransport {
            buffers,
            stream: StreamOwned::new(conn, sock),
        })))
    }
}

/// Active pinned-TLS transport for `ureq`.
pub(crate) struct PinnedTlsTransport {
    buffers: LazyBuffers,
    stream: StreamOwned<ClientConnection, TransportAdapter>,
}

impl fmt::Debug for PinnedTlsTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PinnedTlsTransport").finish()
    }
}

impl Transport for PinnedTlsTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let output = &self.buffers.output()[..amount];
        self.stream
            .write_all(output)
            .map_err(extract_ureq_tls_error)
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let input = self.buffers.input_append_buf();
        let amount = self.stream.read(input).map_err(extract_ureq_tls_error)?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        self.stream.get_mut().get_mut().is_open()
    }

    fn is_tls(&self) -> bool {
        true
    }
}

fn extract_ureq_tls_error(err: io::Error) -> ureq::Error {
    match err.downcast::<ureq::Error>() {
        Ok(ureq_err) => ureq_err,
        Err(err) => match err.downcast::<RustlsError>() {
            Ok(tls_err) => ureq::Error::Rustls(tls_err),
            Err(io_err) => ureq::Error::Io(io_err),
        },
    }
}
