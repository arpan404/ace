//! Spade's `web_fetch`: fetches one page and returns its readable text, a window at a time.
//!
//! Pages are untrusted. Only http and https are fetched. Spade resolves the host itself, refuses
//! any address the [`Policy`] does not allow (loopback, private, link-local, CGNAT, multicast and
//! their IPv6 forms by default) or that belongs to this machine's own networks, and connects
//! only to the addresses it checked, so DNS cannot swap them between the check and the
//! connection. Every redirect is checked the same way, at most [`MOST_REDIRECTS`] of them, and
//! no more than [`MOST_BYTES`] are read ([`MOST_PDF_BYTES`] of a PDF, read through
//! `spade-docs` when [`Fetcher::with_documents`] gave it a reader).
//!
//! # Known limits
//!
//! - This machine's networks are its interface prefixes and the on-link routes of the main
//!   routing table. On Linux, routes in other tables (policy routing) are not read, as that needs
//!   rtnetlink. Gateway-less routes wider than /16 (IPv4) or /32 (IPv6) are not treated as
//!   local either, so that a VPN's split default routes do not refuse every address. Both only
//!   matter with policy routing or unusually wide public on-link prefixes.
//! - Reading the routing table runs `netstat` or `netsh` outside Linux. It is killed after two
//!   seconds, which then refuses the fetch, but that wait is not cut short by the fetch's own
//!   deadline.
//! - Elements with `hidden="until-found"` are dropped like other hidden elements, and text a
//!   malformed page puts inside `<head>` is not read.

pub mod decode;
pub mod extract;
mod html;
mod local;
pub mod page;
pub mod policy;
mod resolve;
pub mod routes;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, LOCATION};
use reqwest::{Response, Url};

pub use local::{LocalNetworks, Network, SystemNetworks};
pub use page::{DEFAULT_PAGE_CHARS, Page};
pub use policy::Policy;
pub use resolve::{Lookup, Resolve, SystemResolver};

/// Whether a log event's `target` comes from the HTML parser's crates (html5ever, markup5ever,
/// tendril, or any of their modules), whose debug and trace logs carry the text of the pages
/// they read. Whoever installs a subscriber must drop these events in a filter of its own that
/// no RUST_LOG directive can override, such as a `filter_fn` layer beside the env filter: a
/// directive like `html5ever::tokenizer=trace` outranks any blanket `html5ever=off`.
#[must_use]
pub fn is_parser_log(target: &str) -> bool {
    ["html5ever", "markup5ever", "tendril"].iter().any(|krate| {
        target
            .strip_prefix(krate)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with("::"))
    })
}

/// The most redirects one fetch follows.
pub const MOST_REDIRECTS: usize = 5;
/// The most bytes of a body Spade reads.
pub const MOST_BYTES: usize = 5 * 1024 * 1024;
/// The most bytes of a PDF Spade reads.
pub const MOST_PDF_BYTES: usize = 20 * 1024 * 1024;

/// One window of a fetched page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    /// The address after redirects.
    pub url: String,
    pub title: Option<String>,
    /// The media type, such as `text/html`, without parameters.
    pub content_type: String,
    /// The readable text in the window asked for.
    pub text: String,
    /// Characters in the whole readable text.
    pub total_chars: usize,
    /// Where the next window starts, when more remains.
    pub next_offset: Option<usize>,
    /// Whether the page was too large or too deeply built to read whole, so the text stops
    /// early.
    pub truncated: bool,
}

/// What went wrong, in one short line. Never carries the page body.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FetchError {
    #[error("not a valid web address: {0}")]
    BadUrl(String),
    #[error("only http and https pages can be fetched, not {0}")]
    Scheme(String),
    #[error("{0} is a local or private address, which Spade does not fetch")]
    Refused(String),
    #[error("could not read this machine's network addresses, so nothing was fetched")]
    LocalNetworks,
    #[error("could not find the host {0}")]
    UnknownHost(String),
    #[error("could not reach {host}: {reason}")]
    Network { host: String, reason: String },
    #[error("the page redirected more than {MOST_REDIRECTS} times")]
    TooManyRedirects,
    #[error("the page redirected without a valid address")]
    BadRedirect,
    #[error("the server answered {0}")]
    Status(u16),
    #[error("the page has no content type")]
    NoContentType,
    #[error("{0} content cannot be read yet; HTML, text, JSON and XML can")]
    Unsupported(String),
    #[error("the page is larger than {} MB", MOST_BYTES / (1024 * 1024))]
    TooLarge,
    #[error("the PDF is larger than {} MB", MOST_PDF_BYTES / (1024 * 1024))]
    PdfTooLarge,
    #[error("the PDF could not be read: {0}")]
    Document(String),
    #[error("the page did not load within {0} seconds")]
    TimedOut(u64),
    #[error("the HTTP client could not be built: {0}")]
    Setup(String),
    #[error("the page could not be read")]
    Unreadable,
}

pub struct Fetcher {
    policy: Policy,
    timeout: Duration,
    resolver: Arc<dyn Resolve>,
    local: Arc<dyn LocalNetworks>,
    /// Reads PDFs; without one they are refused like other binary types.
    documents: Option<spade_docs::Extractor>,
}

/// A body read in full, with where it came from.
struct Body {
    url: Url,
    media_type: String,
    reading: page::Reading,
    /// The `charset` the response declared.
    charset: Option<String>,
    bytes: Vec<u8>,
}

impl Fetcher {
    /// A fetcher using the system resolver and this machine's interface list. A whole fetch,
    /// redirects included, gives up after `timeout`.
    #[must_use]
    pub fn new(policy: Policy, timeout: Duration) -> Self {
        Self {
            policy,
            timeout,
            resolver: Arc::new(SystemResolver),
            local: Arc::new(SystemNetworks),
            documents: None,
        }
    }

    /// Reads PDFs with `reader` (ADR 0134).
    #[must_use]
    pub fn with_documents(mut self, reader: spade_docs::Extractor) -> Self {
        self.documents = Some(reader);
        self
    }

    /// Looks hosts up with `resolver` instead of the system's.
    #[must_use]
    pub fn with_resolver(mut self, resolver: Arc<dyn Resolve>) -> Self {
        self.resolver = resolver;
        self
    }

    /// Reads this machine's networks from `local` instead of the operating system.
    #[must_use]
    pub fn with_local_networks(mut self, local: Arc<dyn LocalNetworks>) -> Self {
        self.local = local;
        self
    }

    /// Fetches `url` and returns the window `page` of its readable text.
    pub async fn fetch(&self, url: &str, page: Page) -> Result<Fetched, FetchError> {
        let mut body = tokio::time::timeout(self.timeout, self.body(url))
            .await
            .map_err(|_| FetchError::TimedOut(self.timeout.as_secs().max(1)))??;
        if body.reading == page::Reading::Pdf {
            return self.pdf(&mut body, page).await;
        }
        // Reading is bounded but CPU-bound, so it runs off the async threads.
        tokio::task::spawn_blocking(move || readable(body, page))
            .await
            .map_err(|_| FetchError::Unreadable)
    }

    /// A PDF's text, read by the document reader in its own process, a window at a time.
    async fn pdf(&self, body: &mut Body, page: Page) -> Result<Fetched, FetchError> {
        let reader = match &self.documents {
            Some(reader) if body.bytes.starts_with(b"%PDF-") => reader,
            _ => return Err(FetchError::Unsupported(body.media_type.clone())),
        };
        let name = body
            .url
            .path_segments()
            .and_then(|mut parts| parts.next_back())
            .filter(|name| !name.is_empty())
            .unwrap_or("page.pdf")
            .to_owned();
        let bytes = std::mem::take(&mut body.bytes);
        let read = reader
            .read(bytes, &name)
            .await
            .map_err(|error| FetchError::Document(error.to_string()))?;
        let window = page::window(&read.text, page);
        Ok(Fetched {
            url: body.url.to_string(),
            title: Some(name),
            content_type: "application/pdf".to_owned(),
            text: window.text,
            total_chars: window.total_chars,
            next_offset: window.next_offset,
            truncated: read.cut,
        })
    }

    async fn body(&self, url: &str) -> Result<Body, FetchError> {
        let mut url = Url::parse(url.trim()).map_err(|e| FetchError::BadUrl(e.to_string()))?;
        // Read once per fetch; failing to read them refuses the fetch rather than guessing.
        // It may run a command, so it runs off the async threads.
        let local = Arc::clone(&self.local);
        let networks = tokio::task::spawn_blocking(move || local.networks())
            .await
            .map_err(|_| FetchError::LocalNetworks)?
            .map_err(|_| FetchError::LocalNetworks)?;
        let mut redirects = 0;
        loop {
            let response = self.get(&url, &networks).await?;
            let status = response.status();
            if status.is_redirection() {
                if redirects == MOST_REDIRECTS {
                    return Err(FetchError::TooManyRedirects);
                }
                redirects += 1;
                url = response
                    .headers()
                    .get(LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|to| url.join(to).ok())
                    .ok_or(FetchError::BadRedirect)?;
                continue;
            }
            if !status.is_success() {
                return Err(FetchError::Status(status.as_u16()));
            }
            return read(url, response).await;
        }
    }

    /// One GET of `url`, connecting only to addresses the policy allows.
    async fn get(&self, url: &Url, networks: &[Network]) -> Result<Response, FetchError> {
        let host = self.checked_host(url, networks).await?;
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(self.timeout)
            .user_agent("spade-fetch")
            // Any lookup not pinned below fails, so nothing reaches the system resolver.
            .dns_resolver(resolve::Nowhere);
        let label = url.host_str().unwrap_or_default().to_owned();
        if let CheckedHost::Domain(domain, addrs) = &host {
            builder = builder.resolve_to_addrs(domain, addrs);
        }
        let client = builder
            .build()
            .map_err(|e| FetchError::Setup(e.to_string()))?;
        client
            .get(url.clone())
            .header(
                ACCEPT,
                "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.9,application/pdf;q=0.8,*/*;q=0.1",
            )
            .send()
            .await
            .map_err(|e| network(&label, &e))
    }

    async fn checked_host(
        &self,
        url: &Url,
        networks: &[Network],
    ) -> Result<CheckedHost, FetchError> {
        let scheme = url.scheme();
        if !matches!(scheme, "http" | "https") {
            return Err(FetchError::Scheme(scheme.to_owned()));
        }
        let port = url.port_or_known_default().unwrap_or(80);
        let refuse = |ip: IpAddr| -> Result<(), FetchError> {
            if self.allows(ip, networks) {
                Ok(())
            } else {
                Err(FetchError::Refused(
                    url.host_str().unwrap_or_default().to_owned(),
                ))
            }
        };
        match url.host() {
            Some(url::Host::Ipv4(ip)) => refuse(IpAddr::V4(ip)).map(|()| CheckedHost::Literal),
            Some(url::Host::Ipv6(ip)) => refuse(IpAddr::V6(ip)).map(|()| CheckedHost::Literal),
            Some(url::Host::Domain(domain)) => {
                let unknown = || FetchError::UnknownHost(domain.to_owned());
                let addrs = self
                    .resolver
                    .lookup(domain, port)
                    .await
                    .map_err(|_| unknown())?;
                if addrs.is_empty() {
                    return Err(unknown());
                }
                for addr in &addrs {
                    refuse(addr.ip())?;
                }
                Ok(CheckedHost::Domain(domain.to_owned(), addrs))
            }
            None => Err(FetchError::BadUrl("it has no host".to_owned())),
        }
    }
}

impl Fetcher {
    /// The policy's rule, and no address on this machine or its links (loopback aside, when the
    /// policy allows it).
    ///
    /// An IPv6 address that carries an IPv4 one (mapped, NAT64, 6to4) is checked as both.
    fn allows(&self, ip: IpAddr, networks: &[Network]) -> bool {
        if !self.policy.allows(ip) {
            return false;
        }
        let outer = ip.to_canonical();
        let inner = match outer {
            IpAddr::V6(v6) => policy::embedded_v4(v6).map(IpAddr::V4),
            IpAddr::V4(_) => None,
        };
        let forms = || std::iter::once(outer).chain(inner);
        if self.policy.allow_loopback && forms().any(|a| a.is_loopback()) {
            return true;
        }
        !networks.iter().any(|n| forms().any(|a| n.contains(a)))
    }
}

enum CheckedHost {
    /// The URL names an IP address, already checked.
    Literal,
    /// A name and the checked addresses to connect to.
    Domain(String, Vec<SocketAddr>),
}

/// The window `page` of the readable text of `body`.
fn readable(body: Body, page: Page) -> Fetched {
    let html = body.reading == page::Reading::Html;
    let source = decode::decode(&body.bytes, body.charset.as_deref(), html);
    let (title, text, truncated) = match body.reading {
        page::Reading::Html => {
            let readable = extract::html(&source, &body.url);
            (readable.title, readable.text, readable.truncated)
        }
        page::Reading::Text | page::Reading::Pdf => (None, source.trim().to_owned(), false),
    };
    let window = page::window(&text, page);
    Fetched {
        url: body.url.to_string(),
        title,
        content_type: body.media_type,
        text: window.text,
        total_chars: window.total_chars,
        next_offset: window.next_offset,
        truncated,
    }
}

/// Reads the body of a successful response, refusing types Spade cannot read and stopping at
/// [`MOST_BYTES`].
async fn read(url: Url, mut response: Response) -> Result<Body, FetchError> {
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let media_type = Some(page::media_type(&content_type))
        .filter(|t| !t.is_empty())
        .ok_or(FetchError::NoContentType)?;
    let charset = decode::header_charset(&content_type);
    let reading =
        page::reading(&media_type).ok_or_else(|| FetchError::Unsupported(media_type.clone()))?;
    let declared = response
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let (most, too_large) = if reading == page::Reading::Pdf {
        (MOST_PDF_BYTES, FetchError::PdfTooLarge)
    } else {
        (MOST_BYTES, FetchError::TooLarge)
    };
    if declared.is_some_and(|n| n > most as u64) {
        return Err(too_large);
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| network(&host, &e))? {
        if bytes.len() + chunk.len() > most {
            return Err(too_large);
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(Body {
        url,
        media_type,
        reading,
        charset,
        bytes,
    })
}

fn network(host: &str, error: &reqwest::Error) -> FetchError {
    let reason = if error.is_timeout() {
        "timed out"
    } else if error.is_connect() {
        "the connection failed"
    } else if error.is_body() || error.is_decode() {
        "the download broke off"
    } else {
        "the request failed"
    };
    FetchError::Network {
        host: host.to_owned(),
        reason: reason.to_owned(),
    }
}
