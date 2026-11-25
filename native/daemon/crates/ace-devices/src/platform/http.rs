// SPDX-License-Identifier: Apache-2.0
//! The download client the device tools use: HTTPS over `rustls` with the operating system's
//! trust store (`rustls-native-certs`), and plain HTTP for a local test server. `reqwest`'s
//! platform verifier would bring `webpki-root-certs` (CDLA-Permissive-2.0), which ace's licence
//! allowlist does not admit; the OS store keeps the same trust decisions without that bundle.

use std::collections::BTreeMap;
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use url::Url;

use super::Error;

/// A connection after TLS, whatever the transport was.
trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// A download client: one TLS configuration, shared by every request.
pub struct Client {
    config: Arc<rustls::ClientConfig>,
}

struct Response {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn invalid(detail: String) -> Error {
    super::Error::Invalid(format!("device tools download: {detail}"))
}

impl Client {
    /// A client that trusts the certificates the operating system already trusts.
    pub fn new() -> Result<Self, Error> {
        let mut roots = rustls::RootCertStore::empty();
        let loaded = rustls_native_certs::load_native_certs();
        for certificate in loaded.certs {
            roots
                .add(certificate)
                .map_err(|error| invalid(format!("a system certificate is not usable: {error}")))?;
        }
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(|error| invalid(format!("no usable TLS versions: {error}")))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            config: Arc::new(config),
        })
    }

    /// `GET url`, following redirects, with the body refused once it passes `limit` bytes.
    pub async fn get(&self, url: &str, limit: u64, label: &str) -> Result<Vec<u8>, Error> {
        let mut current = Url::parse(url)
            .map_err(|error| invalid(format!("{label} URL is not valid: {error}")))?;
        for _ in 0..10 {
            let response = self.once(&current, limit, label).await?;
            match response.status {
                301 | 302 | 303 | 307 | 308 => {
                    let Some(location) = response.headers.get("location") else {
                        return Err(bad(label, "a redirect without a location".to_string()));
                    };
                    current = current.join(location).map_err(|error| {
                        invalid(format!("{label} redirect is not a URL: {error}"))
                    })?;
                }
                status if (200..300).contains(&status) => return Ok(response.body),
                status => {
                    return Err(bad(label, format!("download failed with HTTP {status}")));
                }
            }
        }
        Err(bad(
            label,
            "download failed: too many redirects".to_string(),
        ))
    }

    async fn once(&self, url: &Url, limit: u64, label: &str) -> Result<Response, Error> {
        let host = url
            .host_str()
            .ok_or_else(|| invalid(format!("{label} URL names no host")))?;
        let port = url
            .port_or_known_default()
            .ok_or_else(|| invalid(format!("{label} URL names no port")))?;
        let socket = TcpStream::connect((host, port))
            .await
            .map_err(|error| bad(label, format!("download failed: {error}")))?;
        let stream: Box<dyn Stream> = match url.scheme() {
            "https" => {
                let server = rustls::pki_types::ServerName::try_from(host.to_string())
                    .map_err(|error| invalid(format!("{label} host is not a name: {error}")))?;
                let connector = tokio_rustls::TlsConnector::from(self.config.clone());
                Box::new(
                    connector
                        .connect(server, socket)
                        .await
                        .map_err(|error| bad(label, format!("download failed: {error}")))?,
                )
            }
            "http" => Box::new(socket),
            scheme => {
                return Err(invalid(format!(
                    "{label} URL uses an unsupported scheme: {scheme}"
                )));
            }
        };
        let mut stream = stream;
        let mut target = url.path().to_string();
        if let Some(query) = url.query() {
            target.push('?');
            target.push_str(query);
        }
        let authority = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        let request = format!(
            "GET {target} HTTP/1.1\r\nhost: {authority}\r\nconnection: close\r\naccept: */*\r\nuser-agent: ace-devices\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| bad(label, format!("download failed: {error}")))?;
        stream
            .flush()
            .await
            .map_err(|error| bad(label, format!("download failed: {error}")))?;

        let mut reader = BufReader::new(stream);
        let mut head_bytes = 0usize;
        let status_line = read_line(&mut reader, &mut head_bytes, label).await?;
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse::<u16>().ok())
            .ok_or_else(|| bad(label, "download failed: no HTTP status".to_string()))?;
        let mut headers = BTreeMap::new();
        loop {
            let line = read_line(&mut reader, &mut head_bytes, label).await?;
            if line == "\r\n" || line == "\n" || line.is_empty() {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
            }
        }
        let chunked = headers
            .get("transfer-encoding")
            .is_some_and(|value| value.to_ascii_lowercase().contains("chunked"));
        let length = headers
            .get("content-length")
            .and_then(|value| value.parse::<u64>().ok());
        let mut body = Vec::new();
        if chunked {
            loop {
                let line = read_line(&mut reader, &mut head_bytes, label).await?;
                let size = usize::from_str_radix(line.trim(), 16)
                    .map_err(|_| bad(label, "download failed: bad chunk".to_string()))?;
                if size == 0 {
                    break;
                }
                if body.len() as u64 + size as u64 > limit {
                    return Err(bad(label, "download is too large".to_string()));
                }
                let mut chunk = vec![0u8; size];
                reader
                    .read_exact(&mut chunk)
                    .await
                    .map_err(|error| bad(label, format!("download failed: {error}")))?;
                body.extend_from_slice(&chunk);
                let mut tail = [0u8; 2];
                reader
                    .read_exact(&mut tail)
                    .await
                    .map_err(|error| bad(label, format!("download failed: {error}")))?;
            }
        } else if let Some(length) = length {
            if length > limit {
                return Err(bad(label, "download is too large".to_string()));
            }
            body = vec![0u8; length as usize];
            reader
                .read_exact(&mut body)
                .await
                .map_err(|error| bad(label, format!("download failed: {error}")))?;
        } else {
            read_limited(&mut reader, &mut body, limit, label).await?;
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }
}

fn bad(label: &str, detail: String) -> Error {
    super::Error::Failed(super::Failure {
        code: super::Code::ToolMissing,
        message: format!("{label} {detail}"),
        hint: super::words::hint("downloadHint")
            .unwrap_or_default()
            .to_string(),
    })
}

async fn read_line(
    reader: &mut BufReader<Box<dyn Stream>>,
    seen: &mut usize,
    label: &str,
) -> Result<String, Error> {
    let mut line = String::new();
    let read = reader
        .read_line(&mut line)
        .await
        .map_err(|error| bad(label, format!("download failed: {error}")))?;
    if read == 0 {
        return Err(bad(label, "download failed: the answer ended".to_string()));
    }
    *seen += read;
    if *seen > 64 * 1024 {
        return Err(bad(label, "download failed: too many headers".to_string()));
    }
    Ok(line)
}

async fn read_limited(
    reader: &mut BufReader<Box<dyn Stream>>,
    body: &mut Vec<u8>,
    limit: u64,
    label: &str,
) -> Result<(), Error> {
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| bad(label, format!("download failed: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        if body.len() as u64 + read as u64 > limit {
            return Err(bad(label, "download is too large".to_string()));
        }
        body.extend_from_slice(&chunk[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    /// A network smoke check, never part of a normal run: the pinned hosts' certificates must
    /// satisfy the operating system's trust store. Both answers are larger than one byte, so a
    /// TLS or trust failure is the only other outcome.
    #[test]
    #[ignore = "network: verifies the pinned download hosts' TLS"]
    fn the_pinned_hosts_answer_over_tls() {
        let client = Client::new().expect("client");
        for url in [
            "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz",
            "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
        ] {
            let error = block_on(client.get(url, 1, "probe")).expect_err("too large");
            assert!(error.to_string().contains("too large"), "{url}: {error}");
        }
    }
}
