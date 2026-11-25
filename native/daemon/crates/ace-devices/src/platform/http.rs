// SPDX-License-Identifier: Apache-2.0
//! The download client the device tools use: HTTPS over `rustls` with the operating system's
//! trust store (`rustls-native-certs`), and plain HTTP for a local test server. `reqwest`'s
//! platform verifier would bring `webpki-root-certs` (CDLA-Permissive-2.0), which ace's licence
//! allowlist does not admit; the OS store keeps the same trust decisions without that bundle.
//!
//! The environment's `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`/`NO_PROXY` are honoured: an HTTPS
//! request tunnels through the proxy with `CONNECT`, as Bun's fetch does, and `NO_PROXY` skips
//! it.

use std::collections::BTreeMap;
use std::sync::Arc;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use url::Url;

use super::Error;

/// A connection after TLS, whatever the transport was.
trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

/// The proxy settings a request may take, read from the environment or given by a test.
///
/// Bun's rule (bun.com/docs/runtime/networking/fetch.md, "Proxying requests"): `HTTP_PROXY` for
/// `http:` and `HTTPS_PROXY` for `https:`, either case, with `ALL_PROXY` when the scheme's
/// variable is unset; a value naming another kind of proxy (socks5) is ignored; `no_proxy` is
/// read when `NO_PROXY` is unset or empty, with comma or whitespace separated entries.
#[derive(Clone, Default)]
pub struct ProxyEnv {
    /// Each proxy URL with the variable that named it, so an error can name the variable alone.
    http: Option<(String, &'static str)>,
    https: Option<(String, &'static str)>,
    all: Option<(String, &'static str)>,
    no_proxy: Vec<String>,
}

impl std::fmt::Debug for ProxyEnv {
    /// The proxy URL may hold a password: it never reaches a log line.
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProxyEnv")
            .field("http", &self.http.as_ref().map(|(url, _)| redact(url)))
            .field("https", &self.https.as_ref().map(|(url, _)| redact(url)))
            .field("all", &self.all.as_ref().map(|(url, _)| redact(url)))
            .field("no_proxy", &self.no_proxy)
            .finish()
    }
}

/// A proxy URL without its credentials, for logs and errors. Anything before the last `@` is
/// dropped, whatever the value parses to: a password in a malformed or schemeless value never
/// reaches a log line.
fn redact(url: &str) -> String {
    match url.rsplit_once('@') {
        Some((_, after)) => format!("<redacted>@{after}"),
        None => url.to_string(),
    }
}

impl ProxyEnv {
    /// The variables Bun's fetch reads, each time a request is made.
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// The same selection from pairs, for tests and callers that hold their own environment.
    pub fn from_pairs(pairs: &[(&str, &str)]) -> Self {
        Self::from_lookup(|name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.to_string())
        })
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        // A lowercase name wins, then the uppercase one; an empty value is unset.
        let named = |lower: &'static str, upper: &'static str| -> Option<(String, &'static str)> {
            if let Some(value) = lookup(lower).filter(|value| !value.is_empty()) {
                return Some((value, upper));
            }
            lookup(upper)
                .filter(|value| !value.is_empty())
                .map(|value| (value, upper))
        };
        let no_proxy = named("no_proxy", "NO_PROXY")
            .map(|(value, _)| value)
            .map(|value| {
                value
                    .split([',', ' ', '\t', '\n'])
                    .map(|entry| entry.trim().to_ascii_lowercase())
                    .filter(|entry| !entry.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        Self {
            http: named("http_proxy", "HTTP_PROXY"),
            https: named("https_proxy", "HTTPS_PROXY"),
            all: named("all_proxy", "ALL_PROXY"),
            no_proxy,
        }
    }

    /// The proxy a URL goes through, `None` for a direct connection, or the caller's error for a
    /// variable that cannot be used.
    fn proxy_for(&self, url: &Url) -> Result<Option<Url>, Error> {
        let host = host_parts(url)?.bare;
        if self.excluded(&host, url.port_or_known_default()) {
            return Ok(None);
        }
        let raw = match url.scheme() {
            "https" => self.https.clone().or_else(|| self.all.clone()),
            "http" => self.http.clone().or_else(|| self.all.clone()),
            _ => None,
        };
        let Some((raw, name)) = raw else {
            return Ok(None);
        };
        // Bun's fetch reads a proxy given without a scheme as `http://` (oven-sh/bun#38015),
        // as curl does; the value may carry credentials, so nothing raw reaches the error.
        let target = if raw.contains("://") {
            raw
        } else {
            format!("http://{raw}")
        };
        let parsed = Url::parse(&target)
            .map_err(|error| invalid(format!("{name} is not a valid URL: {error}")))?;
        match parsed.scheme().to_ascii_lowercase().as_str() {
            "http" => Ok(Some(parsed)),
            // Only these are proxies ace cannot use; Bun ignores them rather than failing.
            "socks4" | "socks4a" | "socks5" | "socks5h" => Ok(None),
            "https" => Err(invalid(
                "an https:// proxy is not supported; use an http:// CONNECT proxy".to_string(),
            )),
            scheme => Err(invalid(format!(
                "the proxy URL uses an unsupported scheme {scheme:?}"
            ))),
        }
    }

    /// `no_proxy` entries: `*`, a domain (with its subdomains), an IP, or `host:port`.
    fn excluded(&self, host: &str, port: Option<u16>) -> bool {
        self.no_proxy.iter().any(|entry| {
            if entry == "*" {
                return true;
            }
            let (name, allowed_port) = split_no_proxy_entry(entry);
            if allowed_port.is_some() && allowed_port != port {
                return false;
            }
            let name = name.trim_start_matches("*.").trim_start_matches('.');
            host == name || host.ends_with(&format!(".{name}"))
        })
    }
}

/// A `no_proxy` entry's host and optional port. An unbracketed IPv6 literal has no port: its
/// colons are not separators.
fn split_no_proxy_entry(entry: &str) -> (&str, Option<u16>) {
    if let Some(rest) = entry.strip_prefix('[') {
        return match rest.split_once(']') {
            Some((host, suffix)) => match suffix.strip_prefix(':') {
                Some(port) => (host, port.parse::<u16>().ok()),
                None if suffix.is_empty() => (host, None),
                None => (host, None),
            },
            None => (entry, None),
        };
    }
    if entry.matches(':').count() == 1
        && let Some((host, port)) = entry.rsplit_once(':')
        && !port.is_empty()
        && port.chars().all(|c| c.is_ascii_digit())
    {
        return (host, port.parse::<u16>().ok());
    }
    (entry, None)
}

/// A URL's host, bare for TLS and SNI and bracketed for `Host`/`CONNECT`.
struct HostParts {
    bare: String,
    authority: String,
}

fn host_parts(url: &Url) -> Result<HostParts, Error> {
    match url.host() {
        Some(url::Host::Domain(domain)) => Ok(HostParts {
            bare: domain.to_string(),
            authority: domain.to_string(),
        }),
        Some(url::Host::Ipv4(address)) => Ok(HostParts {
            bare: address.to_string(),
            authority: address.to_string(),
        }),
        Some(url::Host::Ipv6(address)) => Ok(HostParts {
            bare: address.to_string(),
            authority: format!("[{address}]"),
        }),
        None => Err(invalid("the URL names no host".to_string())),
    }
}

/// `%XX` escapes as Bun decodes proxy credentials.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && index + 2 < bytes.len()
            && text[index + 1..index + 3]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
            && let Ok(byte) = u8::from_str_radix(&text[index + 1..index + 3], 16)
        {
            decoded.push(byte);
            index += 3;
            continue;
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

/// The `Proxy-Authorization` a proxy URL's userinfo asks for, if any.
fn proxy_authorization(proxy: &Url) -> Option<String> {
    let user = percent_decode(proxy.username());
    let password = proxy.password().map(percent_decode).unwrap_or_default();
    if user.is_empty() && password.is_empty() {
        return None;
    }
    use base64::Engine as _;
    let encoded = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"));
    Some(format!("Basic {encoded}"))
}

/// A download client: one TLS configuration and proxy selection, shared by every request.
pub struct Client {
    config: Arc<rustls::ClientConfig>,
    proxy: ProxyEnv,
    hint: String,
}

struct Response {
    status: u16,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn invalid(detail: String) -> Error {
    Error::Invalid(format!("device tools download: {detail}"))
}

/// A root store from these certificates, refusing only when none can be parsed. One unexpected
/// system root must not take every download down with it.
fn root_store(
    certificates: Vec<rustls::pki_types::CertificateDer<'static>>,
) -> Result<rustls::RootCertStore, Error> {
    let mut roots = rustls::RootCertStore::empty();
    let (added, _ignored) = roots.add_parsable_certificates(certificates);
    if added == 0 {
        return Err(invalid(
            "the operating system offers no certificates this build can read".to_string(),
        ));
    }
    Ok(roots)
}

fn load_system_roots() -> Result<rustls::RootCertStore, Error> {
    root_store(rustls_native_certs::load_native_certs().certs)
}

impl Client {
    /// A client that trusts the certificates the operating system already trusts. Reading the
    /// keychain blocks, so it runs on a blocking task inside the install's deadline.
    pub async fn new() -> Result<Self, Error> {
        let roots = tokio::task::spawn_blocking(load_system_roots)
            .await
            .map_err(|error| {
                invalid(format!("the system trust store could not be read: {error}"))
            })??;
        let hint = super::words::hint("downloadHint")
            .ok_or_else(|| invalid("the device catalog names no download hint".to_string()))?
            .to_string();
        Self::with_roots_and_proxy(roots, ProxyEnv::from_env(), hint)
    }

    /// A client for these certificates and proxy settings, for tests and embedding callers.
    pub fn with_roots_and_proxy(
        roots: rustls::RootCertStore,
        proxy: ProxyEnv,
        hint: String,
    ) -> Result<Self, Error> {
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let config = rustls::ClientConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .map_err(|error| invalid(format!("no usable TLS versions: {error}")))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        Ok(Self {
            config: Arc::new(config),
            proxy,
            hint,
        })
    }

    /// `GET url`, following redirects, with the body refused once it passes `limit` bytes.
    pub async fn get(&self, url: &str, limit: u64, label: &str) -> Result<Vec<u8>, Error> {
        let mut current = Url::parse(url)
            .map_err(|error| invalid(format!("{label} URL is not valid: {error}")))?;
        for _ in 0..10 {
            if !matches!(current.scheme(), "http" | "https") {
                return Err(bad(
                    &self.hint,
                    label,
                    &format!(
                        "refusing a redirect to {}; only http and https are followed",
                        current.scheme()
                    ),
                ));
            }
            let downgrade = current.scheme() == "https";
            let response = self.once(&current, limit, label).await?;
            match response.status {
                301 | 302 | 303 | 307 | 308 => {
                    let Some(location) = response.headers.get("location") else {
                        return Err(bad(&self.hint, label, "a redirect without a location"));
                    };
                    let next = current.join(location).map_err(|error| {
                        invalid(format!("{label} redirect is not a URL: {error}"))
                    })?;
                    if downgrade && next.scheme() == "http" {
                        return Err(bad(
                            &self.hint,
                            label,
                            "refusing to follow a redirect that downgrades HTTPS to HTTP",
                        ));
                    }
                    current = next;
                }
                status if (200..300).contains(&status) => return Ok(response.body),
                status => {
                    return Err(bad(
                        &self.hint,
                        label,
                        &format!("download failed with HTTP {status}"),
                    ));
                }
            }
        }
        Err(bad(
            &self.hint,
            label,
            "download failed: too many redirects",
        ))
    }

    async fn once(&self, url: &Url, limit: u64, label: &str) -> Result<Response, Error> {
        let parts = host_parts(url)?;
        let host = parts.bare.clone();
        let port = url
            .port_or_known_default()
            .ok_or_else(|| invalid(format!("{label} URL names no port")))?;
        let proxy = self.proxy.proxy_for(url)?;
        let absolute = matches!((url.scheme(), &proxy), ("http", Some(_)));
        let stream = match &proxy {
            Some(proxy) => {
                let proxy_parts = host_parts(proxy)?;
                let proxy_port = proxy
                    .port_or_known_default()
                    .ok_or_else(|| invalid(format!("{label} proxy names no port")))?;
                let authorization = proxy_authorization(proxy);
                let mut tunnel = TcpStream::connect((proxy_parts.bare.as_str(), proxy_port))
                    .await
                    .map_err(|error| {
                        bad(&self.hint, label, &format!("download failed: {error}"))
                    })?;
                if absolute {
                    Box::new(tunnel) as Box<dyn Stream>
                } else {
                    // The authority the proxy connects to, then TLS inside the tunnel. CONNECT
                    // always names the port, even the scheme's default.
                    let authority = format!("{}:{port}", parts.authority);
                    let authorization = authorization
                        .map(|value| format!("proxy-authorization: {value}\r\n"))
                        .unwrap_or_default();
                    let request = format!(
                        "CONNECT {authority} HTTP/1.1\r\nhost: {authority}\r\n{authorization}\r\n"
                    );
                    tunnel
                        .write_all(request.as_bytes())
                        .await
                        .map_err(|error| {
                            bad(&self.hint, label, &format!("download failed: {error}"))
                        })?;
                    tunnel.flush().await.map_err(|error| {
                        bad(&self.hint, label, &format!("download failed: {error}"))
                    })?;
                    let mut seen = 0usize;
                    let status_line =
                        read_head_line(&mut tunnel, 8 * 1024, &mut seen, label, &self.hint).await?;
                    let status = parse_status(&status_line).ok_or_else(|| {
                        bad(&self.hint, label, "the proxy answered without a status")
                    })?;
                    if !(200..300).contains(&status) {
                        return Err(bad(
                            &self.hint,
                            label,
                            &format!("the proxy refused CONNECT with HTTP {status}"),
                        ));
                    }
                    skip_headers(&mut tunnel, &mut seen, label, &self.hint).await?;
                    self.tls(&host, tunnel, label).await?
                }
            }
            None => {
                let socket = TcpStream::connect((host.as_str(), port))
                    .await
                    .map_err(|error| {
                        bad(&self.hint, label, &format!("download failed: {error}"))
                    })?;
                if url.scheme() == "https" {
                    self.tls(&host, socket, label).await?
                } else {
                    Box::new(socket)
                }
            }
        };
        let mut stream = stream;
        let target = if absolute {
            url.to_string()
        } else {
            let mut target = url.path().to_string();
            if let Some(query) = url.query() {
                target.push('?');
                target.push_str(query);
            }
            target
        };
        let authority = match url.port() {
            Some(port) => format!("{}:{port}", parts.authority),
            None => parts.authority.clone(),
        };
        let authorization = if absolute {
            proxy
                .as_ref()
                .and_then(proxy_authorization)
                .map(|value| format!("proxy-authorization: {value}\r\n"))
                .unwrap_or_default()
        } else {
            String::new()
        };
        let request = format!(
            "GET {target} HTTP/1.1\r\nhost: {authority}\r\n{authorization}connection: close\r\naccept: */*\r\nuser-agent: ace-devices\r\n\r\n"
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| bad(&self.hint, label, &format!("download failed: {error}")))?;
        stream
            .flush()
            .await
            .map_err(|error| bad(&self.hint, label, &format!("download failed: {error}")))?;

        let mut head_bytes = 0usize;
        let status_line =
            read_head_line(&mut stream, 8 * 1024, &mut head_bytes, label, &self.hint).await?;
        let status = parse_status(&status_line)
            .ok_or_else(|| bad(&self.hint, label, "download failed: no HTTP status"))?;
        let headers = read_headers(&mut stream, &mut head_bytes, label, &self.hint).await?;
        let chunked = match headers.get("transfer-encoding") {
            None => false,
            Some(value) => {
                let codings: Vec<String> = value
                    .split(',')
                    .map(|coding| coding.trim().to_ascii_lowercase())
                    .collect();
                // No other transfer coding has a decoder here, and `chunked` must come last.
                if codings.len() != 1 || codings[0] != "chunked" {
                    return Err(bad(
                        &self.hint,
                        label,
                        &format!("download failed: unsupported transfer coding {value:?}"),
                    ));
                }
                true
            }
        };
        let length = headers
            .get("content-length")
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| bad(&self.hint, label, "download failed: bad content-length"))
            })
            .transpose()?;
        let mut body = Vec::new();
        if chunked {
            loop {
                // A chunk-size line is not a header; the header cap must not count it.
                let mut chunk_seen = 0usize;
                let line =
                    read_head_line(&mut stream, 256, &mut chunk_seen, label, &self.hint).await?;
                // A chunk-size line may carry extensions after `;`.
                let size_text = line.trim().split(';').next().unwrap_or_default();
                if size_text.is_empty()
                    || !size_text
                        .chars()
                        .all(|character| character.is_ascii_hexdigit())
                {
                    return Err(bad(&self.hint, label, "download failed: bad chunk"));
                }
                let size = u64::from_str_radix(size_text, 16)
                    .map_err(|_| bad(&self.hint, label, "download failed: bad chunk"))?;
                if size == 0 {
                    // Trailers end at the blank line, bounded like the headers.
                    let mut trailer_seen = 0usize;
                    skip_headers(&mut stream, &mut trailer_seen, label, &self.hint).await?;
                    break;
                }
                // `size > limit - len` cannot overflow, and no buffer is sized from the wire.
                if size > limit.saturating_sub(body.len() as u64) {
                    return Err(bad(&self.hint, label, "download is too large"));
                }
                let mut left = size;
                let mut buffer = [0u8; 16 * 1024];
                while left > 0 {
                    let take = left.min(buffer.len() as u64) as usize;
                    stream
                        .read_exact(&mut buffer[..take])
                        .await
                        .map_err(|error| {
                            bad(&self.hint, label, &format!("download failed: {error}"))
                        })?;
                    body.extend_from_slice(&buffer[..take]);
                    left -= take as u64;
                }
                let mut tail = [0u8; 2];
                stream.read_exact(&mut tail).await.map_err(|error| {
                    bad(&self.hint, label, &format!("download failed: {error}"))
                })?;
                if tail != *b"\r\n" {
                    return Err(bad(
                        &self.hint,
                        label,
                        "download failed: a chunk did not end in CRLF",
                    ));
                }
            }
        } else if let Some(length) = length {
            if length > limit {
                return Err(bad(&self.hint, label, "download is too large"));
            }
            body = vec![0u8; length as usize];
            stream
                .read_exact(&mut body)
                .await
                .map_err(|error| bad(&self.hint, label, &format!("download failed: {error}")))?;
        } else {
            read_limited(&mut stream, &mut body, limit, label, &self.hint).await?;
        }
        Ok(Response {
            status,
            headers,
            body,
        })
    }

    async fn tls(
        &self,
        host: &str,
        socket: TcpStream,
        label: &str,
    ) -> Result<Box<dyn Stream>, Error> {
        let server = rustls::pki_types::ServerName::try_from(host.to_string())
            .map_err(|error| invalid(format!("{host} is not a TLS name: {error}")))?;
        let connector = tokio_rustls::TlsConnector::from(self.config.clone());
        Ok(Box::new(connector.connect(server, socket).await.map_err(
            |error| bad(&self.hint, label, &format!("TLS failed: {error}")),
        )?))
    }
}

fn parse_status(line: &str) -> Option<u16> {
    line.split_whitespace().nth(1)?.parse().ok()
}

fn bad(hint: &str, label: &str, detail: &str) -> Error {
    super::Error::Failed(super::Failure {
        code: super::Code::ToolMissing,
        message: format!("{label} {detail}"),
        hint: hint.to_string(),
    })
}

/// One head line, bounded per read so a line with no newline cannot grow memory.
async fn read_head_line<R: AsyncRead + Unpin>(
    reader: &mut R,
    max: usize,
    seen: &mut usize,
    label: &str,
    hint: &str,
) -> Result<String, Error> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0u8; 1];
        let read = reader
            .read(&mut byte)
            .await
            .map_err(|error| bad(hint, label, &format!("download failed: {error}")))?;
        if read == 0 {
            if bytes.is_empty() {
                return Err(bad(hint, label, "download failed: the answer ended"));
            }
            break;
        }
        bytes.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
        if bytes.len() > max {
            return Err(bad(
                hint,
                label,
                "download failed: a header line is too long",
            ));
        }
    }
    *seen += bytes.len();
    String::from_utf8(bytes).map_err(|_| bad(hint, label, "download failed: a header is not text"))
}

async fn read_headers<R: AsyncRead + Unpin>(
    reader: &mut R,
    seen: &mut usize,
    label: &str,
    hint: &str,
) -> Result<BTreeMap<String, String>, Error> {
    let mut headers = BTreeMap::new();
    loop {
        let line = read_head_line(reader, 8 * 1024, seen, label, hint).await?;
        if *seen > 64 * 1024 {
            return Err(bad(hint, label, "download failed: too many headers"));
        }
        if line == "\r\n" || line == "\n" || line.is_empty() {
            return Ok(headers);
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            match name.as_str() {
                "content-length" => match headers.get("content-length") {
                    Some(existing) if existing != &value => {
                        return Err(bad(
                            hint,
                            label,
                            "download failed: conflicting content-length headers",
                        ));
                    }
                    Some(_) => {}
                    None => {
                        headers.insert(name, value);
                    }
                },
                // Several transfer-encoding headers name one coding list, in order.
                "transfer-encoding" => {
                    let joined = match headers.get("transfer-encoding") {
                        Some(existing) => format!("{existing}, {value}"),
                        None => value,
                    };
                    headers.insert(name, joined);
                }
                _ => {
                    headers.insert(name, value);
                }
            }
        }
    }
}

async fn skip_headers<R: AsyncRead + Unpin>(
    reader: &mut R,
    seen: &mut usize,
    label: &str,
    hint: &str,
) -> Result<(), Error> {
    loop {
        let line = read_head_line(reader, 8 * 1024, seen, label, hint).await?;
        if *seen > 64 * 1024 {
            return Err(bad(hint, label, "download failed: too many headers"));
        }
        if line == "\r\n" || line == "\n" || line.is_empty() {
            return Ok(());
        }
    }
}

async fn read_limited<R: AsyncRead + Unpin>(
    reader: &mut R,
    body: &mut Vec<u8>,
    limit: u64,
    label: &str,
    hint: &str,
) -> Result<(), Error> {
    let mut chunk = [0u8; 16 * 1024];
    loop {
        let read = reader
            .read(&mut chunk)
            .await
            .map_err(|error| bad(hint, label, &format!("download failed: {error}")))?;
        if read == 0 {
            return Ok(());
        }
        if body.len() as u64 + read as u64 > limit {
            return Err(bad(hint, label, "download is too large"));
        }
        body.extend_from_slice(&chunk[..read]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::{self, JoinHandle};
    use tokio::io::copy_bidirectional;

    const TEST_CERT: &str = concat!(
        "MIIDJjCCAg6gAwIBAgIUfdu0CsYwx9YTqlwm+LGcm+mpY0IwDQYJKoZIhvcNAQELBQAwFDESMBAG",
        "
A1UEAwwJbG9jYWxob3N0MB4XDTI2MTEyNTEyMDg0MVoXDTM2MTEyMjEyMDg0MVowFDESMBAGA1U",
        "E
AwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAw71v7YiJaxySpX",
        "2C
eNdAfP8nkhWtQgYa97i6v7vaYsGnG7W0OMBFtybXtIRGIdMh/i0q83nqE/id8w9YMoOeCgUfA",
        "g8W
xgssI5WsIT0FybxzvGAP+1ar7NnhSpU8T1qQm8cF61GuYNu/lMJ4CjfqimuG7JFoYHmBk5If",
        "zjLz
x5ebKihr3EzpkUyX/yKBg6LqFBZ6ZaDqYllV1W9IgmUeWQlnUzRA/LJtjiEMs7/7HntekIQ",
        "kMO/8
GkXoYC/4/SeRQxVpkI/UXfsxsOjoSxJkRcvDZrRVdjKAg1SSGWnw4p42n6FpaxMEGy7pbR",
        "pxFu78
T2wivr2pVvhwAGE7PkDGPQIDAQABo3AwbjAdBgNVHQ4EFgQUJXcF1qDVhFQtTY65PUm2C",
        "+FgLJgw
GgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/",
        "BAQDAgWg
MBMGA1UdJQQMMAoGCCsGAQUFBwMBMA0GCSqGSIb3DQEBCwUAA4IBAQBBmvgz8DIpiNd",
        "Hmb7/UtQJ
L+RmjtIic6LwP47CZbdpa85QyO11Mtl2X4wgKFdzIztYpjIdM2BpKKja8PZ0Rxu+Dr",
        "AXC7NjBiTQ
smenZq37BBtPKSPGNQ6FwLx70NfM91XXsaX5mw47hBYJCdrz7YtxUAKznpWy9I5eP",
        "J6K80rGlGrU
LsnfxuLkA9s8MKTlUJHRk2LXOQNd4OrMAFz1akOE/mBnno3iTvylmkQhje2vo5zq",
        "5hFgeZG4zKgy
K8sFOUbsYqT53Tfw0ybRUzpvci4AsBCteX6TtUisqSgQ4prFLPO46P1fmDuzFaC",
        "GGT2hLySi//Io
hYu2mMzvKFySMTdb",
    );
    const TEST_KEY: &str = concat!(
        "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDDvW/tiIlrHJKlfYJ410B8/yeS",
        "
Fa1CBhr3uLq/u9piwacbtbQ4wEW3Jte0hEYh0yH+LSrzeeoT+J3zD1gyg54KBR8CDxbGCywjlaw",
        "h
PQXJvHO8YA/7Vqvs2eFKlTxPWpCbxwXrUa5g27+UwngKN+qKa4bskWhgeYGTkh/OMvPHl5sqKG",
        "vc
TOmRTJf/IoGDouoUFnploOpiWVXVb0iCZR5ZCWdTNED8sm2OIQyzv/see16QhCQw7/waRehgL",
        "/j9
J5FDFWmQj9Rd+zGw6OhLEmRFy8NmtFV2MoCDVJIZafDinjafoWlrEwQbLultGnEW7vxPbCK+",
        "valW
+HAAYTs+QMY9AgMBAAECggEAA6GPQr0KbY//YW4JXlQB6H+0PHfF+chStj85SabCt5vHjZJ",
        "KmFXq
xSnFjR36DhUUV5p/Zjpf/wRY68IgXPmHlECBkYB1p/FbnYJgidJPue0SyY8PpNY4BMIK9Z",
        "78mi1A
Kv+farzeawIQlQIhh3D/mxdBDsDoyodegb4PdHwJ/S0YvGzsfma9eiiP0o2wQS1teaWE9",
        "zYkyfXd
tTKp/OH119fytdFdvazYR77VwsIrHS9ZJ0airXebnnY+dqMO5HnPavg/8jrrJ5zZy+em",
        "q4gTMwZE
FPGABZ7ADuGeXQIQX2XLeDw3WqCU8XGmPEj8/pDqWiIzV48rCtA09zRS/DbUWQKBgQD",
        "s/Lkp0QA/
4cJ9BSFmhTMWecANflWjfI6ejI6/7v3QiXGvx1CHbeAhzDewJcs+6hCWVey9hfBtGV",
        "wU/McfuLIK
/i8dR4aJqwE4Jksih8n7dmV/M2BtQ1cqcavTkZEdutXlxpNitX8CK71WTOT7OrDoz",
        "zw2Sokj8CSS
yJFKLyPmFQKBgQDTcZKmk0c2rvPDQAQy+XM3WDhKUksDflEhFRqckfDCI6dkoZ1h",
        "2NGRfVjN37l8
l0mZTGBYzSfdUh3noMk7EeEzWd5d30DoCmoRzvUJr4sBjrWTfRABcRNPaIjYFpN",
        "qJFNR130wK/wD
nU1RpwgTkMWzQpWiR1oIpKFEyMfz5MZRiQKBgFD0B4BcT5yCzwAL55vwtkHgNx",
        "Wk6TYej01jsEOq
LPO2b6pfCIgqpVyGOSOn1WTZae8gzOz0uutZtVXJ/287lT4iFBAJZdDTJGh81",
        "D+oaPvINuWbtD2+
uiDakZqE6DBiqTyDd8dJPmiMbnHzdGjJZLMyT1wwW+Z12th1QQQ5VCb9AoGB",
        "AJsXuFD0wIyMwYJb
B3l4XZmf3RIu0JUMZ2fTugRUS/uq+VKn9O/bgMSt46CG1OBde/+09QrN2Mr",
        "PO941osTwNXZcGe5T
HqHVWb4cRsJG/7gxvGAloMLd9SMO8ylFTfXSFUd3v3zBFoZ0ME2PLi5jx4",
        "/YbDdvDMxALYZtm7T6
/ri5AoGBAOMUDr+mKPEPwgDnHjcWrOFwjQOiDEoJs/Ho/NZQJRbJwAemo",
        "gth6huU7rhlKpgyhCiT
NxFkQEYsNuXLP2t3dgZHzOMbcGyZ8C82Xa2NHrBHHLdEwCbgBpOMmqEq",
        "aKWwzRCj6919Kz3LjOjr
sNKg9MDYnS847JT+lnvPBormSOSC",
    );

    fn decode(text: &str) -> Vec<u8> {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD
            .decode(text.replace('\n', ""))
            .expect("base64")
    }

    fn test_cert() -> rustls::pki_types::CertificateDer<'static> {
        rustls::pki_types::CertificateDer::from(decode(TEST_CERT))
    }

    fn block_on<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(future)
    }

    fn client(proxy: ProxyEnv) -> Client {
        let roots = root_store(vec![test_cert()]).expect("roots");
        Client::with_roots_and_proxy(roots, proxy, "download hint".to_string()).expect("client")
    }

    fn plain_client() -> Client {
        let roots = root_store(vec![test_cert()]).expect("roots");
        Client::with_roots_and_proxy(roots, ProxyEnv::default(), "download hint".to_string())
            .expect("client")
    }

    #[test]
    fn one_unreadable_system_root_does_not_disable_the_client() {
        let garbage = rustls::pki_types::CertificateDer::from(vec![0u8, 1, 2, 3]);
        assert!(root_store(vec![garbage.clone()]).is_err());
        assert!(root_store(vec![garbage, test_cert()]).is_ok());
    }

    #[test]
    fn the_proxy_selection_follows_buns_rules() {
        let url = |text: &str| Url::parse(text).expect("url");
        let proxy = ProxyEnv::from_pairs(&[
            ("HTTPS_PROXY", "http://proxy.local:8080"),
            (
                "NO_PROXY",
                "example.com, .internal.test, secure.test:8443, 127.0.0.1",
            ),
        ]);
        assert_eq!(
            proxy
                .proxy_for(&url("https://registry.npmjs.org/x"))
                .expect("proxy")
                .map(|u| u.to_string()),
            Some("http://proxy.local:8080/".to_string())
        );
        assert!(
            proxy
                .proxy_for(&url("https://example.com/x"))
                .expect("proxy")
                .is_none()
        );
        assert!(
            proxy
                .proxy_for(&url("https://a.internal.test/x"))
                .expect("proxy")
                .is_none()
        );
        assert!(
            proxy
                .proxy_for(&url("https://secure.test:8443/x"))
                .expect("proxy")
                .is_none()
        );
        // A NO_PROXY entry with 443 matches https://host/ whose port is not in the URL.
        let by_port = ProxyEnv::from_pairs(&[
            ("HTTPS_PROXY", "http://proxy.local:8080"),
            ("NO_PROXY", "example.com:443"),
        ]);
        assert!(
            by_port
                .proxy_for(&url("https://example.com/x"))
                .expect("proxy")
                .is_none()
        );
        // Bun has no HTTP_PROXY fallback for https; ALL_PROXY covers both.
        let http_only = ProxyEnv::from_pairs(&[("HTTP_PROXY", "http://p:3128")]);
        assert!(
            http_only
                .proxy_for(&url("https://host.test/x"))
                .expect("proxy")
                .is_none()
        );
        assert!(
            http_only
                .proxy_for(&url("http://host.test/x"))
                .expect("proxy")
                .is_some()
        );
        let all = ProxyEnv::from_pairs(&[("ALL_PROXY", "http://all:8080")]);
        assert!(
            all.proxy_for(&url("https://host.test/x"))
                .expect("proxy")
                .is_some()
        );
        assert!(
            all.proxy_for(&url("http://host.test/x"))
                .expect("proxy")
                .is_some()
        );
        // A lowercase name wins; an empty lowercase value falls back to the uppercase one.
        let both = ProxyEnv::from_pairs(&[
            ("https_proxy", "http://lower:1"),
            ("HTTPS_PROXY", "http://upper:2"),
        ]);
        assert_eq!(
            both.proxy_for(&url("https://host.test/x"))
                .expect("proxy")
                .map(|u| u.to_string()),
            Some("http://lower:1/".to_string())
        );
        let empty_lower =
            ProxyEnv::from_pairs(&[("https_proxy", ""), ("HTTPS_PROXY", "http://upper:2")]);
        assert_eq!(
            empty_lower
                .proxy_for(&url("https://host.test/x"))
                .expect("proxy")
                .map(|u| u.to_string()),
            Some("http://upper:2/".to_string())
        );
        let wildcard = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "http://p:1"), ("NO_PROXY", "*")]);
        assert!(
            wildcard
                .proxy_for(&url("https://anything.test/x"))
                .expect("proxy")
                .is_none()
        );
        // A value naming another kind of proxy is ignored, as Bun ignores socks5://.
        let socks = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "socks5://p:1080")]);
        assert!(
            socks
                .proxy_for(&url("https://host.test/x"))
                .expect("proxy")
                .is_none()
        );
    }

    #[test]
    fn an_unusable_proxy_variable_is_an_error() {
        let broken = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "not a url")]);
        let error = broken
            .proxy_for(&Url::parse("https://host.test/x").expect("url"))
            .expect_err("invalid");
        assert!(
            error.to_string().contains("HTTPS_PROXY is not a valid URL"),
            "{error}"
        );
        let secure = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "https://proxy.test:3128")]);
        let error = secure
            .proxy_for(&Url::parse("https://host.test/x").expect("url"))
            .expect_err("https proxy");
        assert!(
            error
                .to_string()
                .contains("https:// proxy is not supported"),
            "{error}"
        );
    }

    #[test]
    fn ipv6_hosts_and_no_proxy_entries_are_bracketed_and_matched() {
        let url = Url::parse("https://[::1]/file").expect("url");
        for entry in ["::1", "[::1]", "[::1]:443"] {
            let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "http://p:1"), ("NO_PROXY", entry)]);
            assert!(
                proxy.proxy_for(&url).expect("proxy").is_none(),
                "NO_PROXY={entry}"
            );
        }
        let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "http://p:1")]);
        assert!(proxy.proxy_for(&url).expect("proxy").is_some());
        let parts = host_parts(&url).expect("parts");
        assert_eq!(parts.bare, "::1");
        assert_eq!(parts.authority, "[::1]");
    }

    #[test]
    fn a_schemeless_proxy_is_an_http_proxy_as_bun_reads_it() {
        let url = Url::parse("https://host.test/x").expect("url");
        for raw in ["proxy.corp:3128", "bob:s3cret@proxy.corp:3128"] {
            let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", raw)]);
            let selected = proxy
                .proxy_for(&url)
                .expect("proxy")
                .expect("through the proxy");
            assert_eq!(selected.scheme(), "http");
            assert_eq!(selected.host_str(), Some("proxy.corp"));
            assert_eq!(selected.port(), Some(3128));
        }
        // Credentials in a schemeless value stay out of logs.
        let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", "bob:s3cret@proxy.corp:3128")]);
        let logged = format!("{proxy:?}");
        assert!(!logged.contains("s3cret"), "{logged}");
    }

    #[test]
    fn only_the_socks_schemes_are_skipped_and_other_unknown_schemes_refuse() {
        let url = Url::parse("https://host.test/x").expect("url");
        for scheme in ["socks4", "socks4a", "socks5", "socks5h"] {
            let value = format!("{scheme}://proxy.test:1080");
            let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", &value)]);
            assert!(
                proxy.proxy_for(&url).expect("skipped").is_none(),
                "{scheme}"
            );
        }
        for value in ["ftp://proxy.test:21", "wss://proxy.test:443"] {
            let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", value)]);
            let error = proxy.proxy_for(&url).expect_err("unsupported");
            assert!(
                error.to_string().contains("unsupported scheme"),
                "{value}: {error}"
            );
        }
    }

    #[test]
    fn a_malformed_proxy_url_never_reveals_its_password() {
        let secret = "http://bob:s3cret@[bad";
        let proxy = ProxyEnv::from_pairs(&[("HTTPS_PROXY", secret)]);
        let error = proxy
            .proxy_for(&Url::parse("https://host.test/x").expect("url"))
            .expect_err("invalid");
        let message = error.to_string();
        assert!(
            message.contains("HTTPS_PROXY is not a valid URL"),
            "{message}"
        );
        assert!(!message.contains("s3cret"), "{message}");
        let logged = format!("{proxy:?}");
        assert!(!logged.contains("s3cret"), "{logged}");
        // The value's tail is still shown for diagnosis, without the credentials.
        assert!(logged.contains("[bad"), "{logged}");
    }

    #[test]
    fn proxy_credentials_are_percent_decoded_into_basic_authorization() {
        assert_eq!(percent_decode("%+1"), "%+1");
        assert_eq!(percent_decode("a%40b"), "a@b");
        let proxy = Url::parse("http://u%40x:p%3Aword@corp.test:3128").expect("url");
        assert_eq!(
            proxy_authorization(&proxy).as_deref(),
            Some("Basic dUB4OnA6d29yZA==")
        );
        let anonymous = Url::parse("http://corp.test:3128").expect("url");
        assert!(proxy_authorization(&anonymous).is_none());
        let redacted = format!(
            "{:?}",
            ProxyEnv::from_pairs(&[("HTTPS_PROXY", "http://u:p@corp.test:3128")])
        );
        assert!(!redacted.contains(":p@"), "{redacted}");
    }

    /// A TLS server on 127.0.0.1 that answers one request with `response`.
    fn tls_server(response: Vec<u8>) -> (u16, JoinHandle<()>) {
        let cert = test_cert();
        let key = rustls::pki_types::PrivateKeyDer::Pkcs8(
            rustls::pki_types::PrivatePkcs8KeyDer::from(decode(TEST_KEY)),
        );
        let provider = rustls::crypto::aws_lc_rs::default_provider();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(provider))
            .with_safe_default_protocol_versions()
            .expect("versions")
            .with_no_client_auth()
            .with_single_cert(vec![cert], key)
            .expect("cert");
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut tls) = acceptor.accept(socket).await else {
                    return;
                };
                let mut request = [0u8; 4096];
                let _ = tls.read(&mut request).await;
                let _ = tls.write_all(&response).await;
                let _ = tls.shutdown().await;
            });
        });
        (port, handle)
    }

    /// A CONNECT proxy in front of `target_port` that counts tunnels.
    fn proxy(target_port: u16) -> (String, Arc<std::sync::atomic::AtomicUsize>, JoinHandle<()>) {
        proxy_with_auth(target_port, None)
    }

    /// A CONNECT proxy that requires `required` as `Proxy-Authorization`, when given.
    fn proxy_with_auth(
        target_port: u16,
        required: Option<String>,
    ) -> (String, Arc<std::sync::atomic::AtomicUsize>, JoinHandle<()>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let handle = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                let Ok((mut client, _)) = listener.accept().await else {
                    return;
                };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while client.read(&mut byte).await.unwrap_or(0) == 1 {
                    head.push(byte[0]);
                    if head.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                seen.fetch_add(1, Ordering::SeqCst);
                let request = String::from_utf8_lossy(&head);
                if !request.starts_with("CONNECT ") {
                    let _ = client
                        .write_all(b"HTTP/1.1 405 Method Not Allowed\r\ncontent-length: 0\r\n\r\n")
                        .await;
                    return;
                }
                if let Some(required) = required {
                    let sent = request
                        .lines()
                        .find_map(|line| {
                            line.split_once(':').filter(|(name, _)| {
                                name.eq_ignore_ascii_case("proxy-authorization")
                            })
                        })
                        .map(|(_, value)| value.trim().to_string());
                    if sent.as_deref() != Some(required.as_str()) {
                        let _ = client
                            .write_all(
                                b"HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n",
                            )
                            .await;
                        return;
                    }
                }
                let Ok(mut target) = TcpStream::connect(("127.0.0.1", target_port)).await else {
                    return;
                };
                let _ = client
                    .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                    .await;
                let _ = copy_bidirectional(&mut client, &mut target).await;
            });
        });
        (format!("http://127.0.0.1:{port}"), count, handle)
    }

    /// A plain server that writes `bytes` verbatim and closes.
    fn raw_server(bytes: Vec<u8>) -> (u16, JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let handle = thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("runtime");
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).expect("listener");
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request).await;
                let _ = socket.write_all(&bytes).await;
                let _ = socket.shutdown().await;
            });
        });
        (port, handle)
    }

    fn ok_response(body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }

    #[test]
    fn an_https_request_tunnels_through_the_environment_proxy() {
        let (target, target_handle) = tls_server(ok_response(b"through the tunnel"));
        let (proxy_url, count, proxy_handle) = proxy(target);
        let proxy_env = ProxyEnv::from_pairs(&[("HTTPS_PROXY", &proxy_url)]);
        let body = block_on(client(proxy_env).get(
            &format!("https://127.0.0.1:{target}/file"),
            1024,
            "fixture",
        ))
        .expect("download");
        assert_eq!(body, b"through the tunnel");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
        proxy_handle.join().expect("proxy");
        target_handle.join().expect("target");
    }

    #[test]
    fn no_proxy_connects_directly() {
        let (target, target_handle) = tls_server(ok_response(b"direct"));
        let (proxy_url, count, proxy_handle) = proxy(target);
        let proxy_env =
            ProxyEnv::from_pairs(&[("HTTPS_PROXY", &proxy_url), ("NO_PROXY", "127.0.0.1")]);
        let body = block_on(client(proxy_env).get(
            &format!("https://127.0.0.1:{target}/file"),
            1024,
            "fixture",
        ))
        .expect("download");
        assert_eq!(body, b"direct");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 0);
        target_handle.join().expect("target");
        drop(proxy_handle);
    }

    #[test]
    fn a_redirect_that_downgrades_https_to_http_is_refused() {
        let (http_port, http_handle) = raw_server(ok_response(b"insecure"));
        let redirect = format!(
            "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:{http_port}/file\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
        );
        let (target, target_handle) = tls_server(redirect.into_bytes());
        let error = block_on(plain_client().get(
            &format!("https://127.0.0.1:{target}/file"),
            1024,
            "fixture",
        ))
        .expect_err("downgrade");
        assert!(error.to_string().contains("downgrades"), "{error}");
        target_handle.join().expect("target");
        drop(http_handle);
    }

    #[test]
    fn many_small_chunks_are_not_counted_as_headers() {
        let mut response =
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n".to_vec();
        for _ in 0..12_000 {
            response.extend_from_slice(b"1;padding=aaaaaaaaaa\r\nx\r\n");
        }
        response.extend_from_slice(b"0\r\n\r\n");
        let (port, handle) = raw_server(response);
        let body = block_on(plain_client().get(
            &format!("http://127.0.0.1:{port}/chunks"),
            64 * 1024,
            "fixture",
        ))
        .expect("chunked");
        assert_eq!(body.len(), 12_000);
        handle.join().expect("server");
    }

    #[test]
    fn a_header_line_without_a_newline_fails_fast() {
        let mut response = b"HTTP/1.1 200 OK\r\nx-long: ".to_vec();
        response.extend(std::iter::repeat_n(b'a', 1024 * 1024));
        let (port, handle) = raw_server(response);
        let outcome = block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(2),
                plain_client().get(&format!("http://127.0.0.1:{port}/slow"), 1024, "fixture"),
            )
            .await
        });
        let error = outcome.expect("did not hang").expect_err("too long");
        assert!(
            error.to_string().contains("header line is too long"),
            "{error}"
        );
        drop(handle);
    }

    #[test]
    fn a_chunk_size_that_would_overflow_is_refused_without_allocating() {
        for size in ["ffffffffffffffff", "8000000000000000", "7fffffffffffffff"] {
            let mut response =
                b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
                    .to_vec();
            response.extend_from_slice(size.as_bytes());
            response.extend_from_slice(b"\r\n");
            let (port, handle) = raw_server(response);
            let error = block_on(plain_client().get(
                &format!("http://127.0.0.1:{port}/chunk"),
                64 * 1024,
                "fixture",
            ))
            .expect_err("overflow");
            assert!(error.to_string().contains("too large"), "{size}: {error}");
            drop(handle);
        }
    }

    #[test]
    fn proxy_credentials_reach_connect_after_percent_decoding() {
        let (target, target_handle) = tls_server(ok_response(b"authorized"));
        let (proxy_url, count, proxy_handle) =
            proxy_with_auth(target, Some("Basic dUB4OnA6d29yZA==".to_string()));
        let secure = proxy_url.replacen("http://", "http://u%40x:p%3Aword@", 1);
        let proxy_env = ProxyEnv::from_pairs(&[("HTTPS_PROXY", &secure)]);
        let body = block_on(client(proxy_env).get(
            &format!("https://127.0.0.1:{target}/file"),
            1024,
            "fixture",
        ))
        .expect("authorized");
        assert_eq!(body, b"authorized");
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
        proxy_handle.join().expect("proxy");
        target_handle.join().expect("target");
    }

    #[test]
    fn a_redirect_to_another_scheme_is_refused() {
        let redirect = "HTTP/1.1 302 Found\r\nlocation: ws://127.0.0.1:1/x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
        let (target, target_handle) = tls_server(redirect.as_bytes().to_vec());
        let error = block_on(plain_client().get(
            &format!("https://127.0.0.1:{target}/file"),
            1024,
            "fixture",
        ))
        .expect_err("scheme");
        assert!(error.to_string().contains("only http and https"), "{error}");
        target_handle.join().expect("target");
    }

    #[test]
    fn differing_duplicate_content_lengths_are_refused() {
        let (port, handle) = raw_server(
            b"HTTP/1.1 200 OK\r\ncontent-length: 1\r\ncontent-length: 2\r\nconnection: close\r\n\r\nx"
                .to_vec(),
        );
        let error = block_on(plain_client().get(
            &format!("http://127.0.0.1:{port}/length"),
            1024,
            "fixture",
        ))
        .expect_err("conflicting");
        assert!(
            error.to_string().contains("conflicting content-length"),
            "{error}"
        );
        drop(handle);
    }

    #[test]
    fn transfer_codings_other_than_chunked_are_refused() {
        for coding in ["gzip", "gzip, chunked", "chunked, gzip"] {
            let (port, handle) = raw_server(
                format!(
                    "HTTP/1.1 200 OK\r\ntransfer-encoding: {coding}\r\nconnection: close\r\n\r\n0\r\n\r\n"
                )
                .into_bytes(),
            );
            let error = block_on(plain_client().get(
                &format!("http://127.0.0.1:{port}/coding"),
                1024,
                "fixture",
            ))
            .expect_err("coding");
            assert!(
                error.to_string().contains("unsupported transfer coding"),
                "{coding}: {error}"
            );
            drop(handle);
        }
    }

    #[test]
    fn a_chunk_size_with_a_sign_is_refused() {
        let (port, handle) = raw_server(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n+1\r\nx\r\n"
                .to_vec(),
        );
        let error =
            block_on(plain_client().get(&format!("http://127.0.0.1:{port}/plus"), 1024, "fixture"))
                .expect_err("signed");
        assert!(error.to_string().contains("bad chunk"), "{error}");
        drop(handle);
    }

    #[test]
    fn a_chunk_that_does_not_end_in_crlf_is_refused() {
        let (port, handle) = raw_server(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n1\r\nxXX"
                .to_vec(),
        );
        let error =
            block_on(plain_client().get(&format!("http://127.0.0.1:{port}/crlf"), 1024, "fixture"))
                .expect_err("crlf");
        assert!(error.to_string().contains("did not end in CRLF"), "{error}");
        drop(handle);
    }

    #[test]
    #[ignore = "network: verifies the pinned download hosts' TLS"]
    fn the_pinned_hosts_answer_over_tls() {
        let client = block_on(Client::new()).expect("client");
        for url in [
            "https://registry.npmjs.org/ws/-/ws-8.22.0.tgz",
            "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
        ] {
            let error = block_on(client.get(url, 1, "probe")).expect_err("too large");
            assert!(error.to_string().contains("too large"), "{url}: {error}");
        }
    }
}
