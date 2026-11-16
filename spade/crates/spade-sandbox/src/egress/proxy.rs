//! The local egress proxy (ADR 0167 decision 3). One loopback listener; each sandboxed run gets
//! a [`Ticket`] whose token it presents as the proxy's Basic credential, which names its bot, run
//! and policy. `CONNECT host:port` is tunnelled and absolute-form HTTP requests are forwarded,
//! when the policy allows the host and the address it resolves to isn't private (unless the
//! person named a local host). TLS passes through untouched: the proxy never sees or adds an
//! `Authorization` header. Every connection is logged.

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::hosts::{NetworkPolicy, Verdict, private};
use super::log::{EgressLog, Entry};

/// The most a request's head may be.
const MOST_HEAD: usize = 16 * 1024;
/// How long a client has to send its request's head, and a host to accept a connection.
const WAIT: Duration = Duration::from_secs(30);

/// Resolves a host's addresses; injected so tests can name their own.
pub trait Resolve: Send + Sync {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>>;
}

/// The system's resolver.
pub struct SystemResolver;

impl Resolve for SystemResolver {
    fn resolve<'a>(
        &'a self,
        host: &'a str,
        port: u16,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Vec<SocketAddr>>> + Send + 'a>> {
        Box::pin(async move { Ok(tokio::net::lookup_host((host, port)).await?.collect()) })
    }
}

/// The time now, in Unix milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// What a run did through the proxy.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub connections: u64,
    pub refused: u64,
    pub sent: u64,
    pub received: u64,
}

#[derive(Default)]
struct Counters {
    connections: AtomicU64,
    refused: AtomicU64,
    sent: AtomicU64,
    received: AtomicU64,
}

struct Session {
    bot: String,
    run: String,
    policy: NetworkPolicy,
    usage: Counters,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    log: Arc<EgressLog>,
    resolver: Arc<dyn Resolve>,
    clock: Clock,
    tokens: Arc<dyn Fn() -> String + Send + Sync>,
}

impl Inner {
    fn session(&self, token: &str) -> Option<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(token)
            .cloned()
    }
}

/// The running proxy; it stops listening when dropped.
pub struct Proxy {
    port: u16,
    inner: Arc<Inner>,
    accept: tokio::task::AbortHandle,
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.accept.abort();
    }
}

impl Proxy {
    /// Listens on `127.0.0.1` at a free port. `tokens` makes each run's secret.
    pub async fn start(
        log: Arc<EgressLog>,
        resolver: Arc<dyn Resolve>,
        clock: Clock,
        tokens: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let inner = Arc::new(Inner {
            sessions: Mutex::new(HashMap::new()),
            log,
            resolver,
            clock,
            tokens,
        });
        let serving = inner.clone();
        let accept = tokio::spawn(async move {
            loop {
                let Ok((client, _)) = listener.accept().await else {
                    continue;
                };
                tokio::spawn(serve(serving.clone(), client));
            }
        })
        .abort_handle();
        Ok(Self {
            port,
            inner,
            accept,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// A ticket for one run of `bot`'s, held to `policy`. The run's access ends with the ticket.
    pub fn open(&self, bot: &str, run: &str, policy: NetworkPolicy) -> Ticket {
        let token = (self.inner.tokens)();
        let session = Arc::new(Session {
            bot: bot.to_owned(),
            run: run.to_owned(),
            policy,
            usage: Counters::default(),
        });
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(token.clone(), session.clone());
        Ticket {
            inner: self.inner.clone(),
            token,
            session,
            port: self.port,
        }
    }
}

/// One run's access to the proxy, ended when dropped.
pub struct Ticket {
    inner: Arc<Inner>,
    token: String,
    session: Arc<Session>,
    port: u16,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        self.inner
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.token);
    }
}

impl Ticket {
    /// The proxy's address with this run's credential, as `HTTP_PROXY` names it.
    pub fn url(&self) -> String {
        format!("http://spade:{}@127.0.0.1:{}", self.token, self.port)
    }

    /// The variables that send a run's traffic through the proxy.
    pub fn env(&self) -> Vec<(String, String)> {
        let url = self.url();
        let mut vars: Vec<(String, String)> = [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ]
        .iter()
        .map(|name| ((*name).to_owned(), url.clone()))
        .collect();
        // Nothing skips the proxy: this machine is reached through it too, when allowed.
        vars.push(("NO_PROXY".to_owned(), String::new()));
        vars.push(("no_proxy".to_owned(), String::new()));
        // Node's own fetch honours the variables only when told to.
        vars.push(("NODE_USE_ENV_PROXY".to_owned(), "1".to_owned()));
        vars
    }

    pub fn usage(&self) -> Usage {
        let c = &self.session.usage;
        Usage {
            connections: c.connections.load(Ordering::Relaxed),
            refused: c.refused.load(Ordering::Relaxed),
            sent: c.sent.load(Ordering::Relaxed),
            received: c.received.load(Ordering::Relaxed),
        }
    }
}

/// A request's head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub method: String,
    pub target: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
}

impl Head {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// The token of `Proxy-Authorization: Basic base64(user:token)`.
    pub fn token(&self) -> Option<String> {
        let value = self.header("proxy-authorization")?.trim();
        let (scheme, encoded) = value.split_once(' ')?;
        if !scheme.eq_ignore_ascii_case("basic") {
            return None;
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .ok()?;
        let text = String::from_utf8(decoded).ok()?;
        text.split_once(':').map(|(_, token)| token.to_owned())
    }
}

/// Parses a request's head (everything before the blank line).
pub fn parse_head(raw: &[u8]) -> Option<Head> {
    let text = std::str::from_utf8(raw).ok()?;
    let mut lines = text.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let (method, target, version) = (first.next()?, first.next()?, first.next()?);
    if first.next().is_some() || !version.starts_with("HTTP/1.") {
        return None;
    }
    let mut headers = Vec::new();
    for line in lines.filter(|l| !l.is_empty()) {
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_owned(), value.trim().to_owned()));
    }
    Some(Head {
        method: method.to_owned(),
        target: target.to_owned(),
        version: version.to_owned(),
        headers,
    })
}

/// Where a request goes: host, port, and for plain HTTP the path to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    /// `None` for `CONNECT`.
    pub path: Option<String>,
}

pub fn target(head: &Head) -> Option<Target> {
    if head.method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = split_host_port(&head.target)?;
        return Some(Target {
            host,
            port: port?,
            path: None,
        });
    }
    let rest = head.target.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        return None;
    }
    let (host, port) = split_host_port(authority)?;
    Some(Target {
        host,
        port: port.unwrap_or(80),
        path: Some(path.to_owned()),
    })
}

fn split_host_port(authority: &str) -> Option<(String, Option<u16>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after.strip_prefix(':') {
            Some(port) => Some(port.parse().ok()?),
            None if after.is_empty() => None,
            None => return None,
        };
        return Some((host.to_owned(), port));
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => Some((host.to_owned(), Some(port.parse().ok()?))),
        None => Some((authority.to_owned(), None)),
    }
    .filter(|(host, _)| !host.is_empty())
}

/// Reads up to the end of the head; answers the head and whatever came after it.
async fn read_head(client: &mut TcpStream) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        let read = client.read(&mut chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(end) = buffer.windows(4).position(|w| w == b"\r\n\r\n") {
            let rest = buffer.split_off(end + 4);
            buffer.truncate(end);
            return Some((buffer, rest));
        }
        if buffer.len() > MOST_HEAD {
            return None;
        }
    }
}

async fn answer(client: &mut TcpStream, status: &str, extra: &str, body: &str) {
    let text = format!(
        "HTTP/1.1 {status}\r\n{extra}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(text.as_bytes()).await;
    let _ = client.shutdown().await;
}

async fn serve(inner: Arc<Inner>, mut client: TcpStream) {
    let Ok(Some((raw, rest))) = tokio::time::timeout(WAIT, read_head(&mut client)).await else {
        return;
    };
    let Some(head) = parse_head(&raw) else {
        answer(&mut client, "400 Bad Request", "", "").await;
        return;
    };
    let Some(session) = head.token().and_then(|token| inner.session(&token)) else {
        answer(
            &mut client,
            "407 Proxy Authentication Required",
            "Proxy-Authenticate: Basic realm=\"spade\"\r\n",
            "",
        )
        .await;
        return;
    };
    let Some(target) = target(&head) else {
        answer(
            &mut client,
            "400 Bad Request",
            "",
            "Spade's proxy takes CONNECT and http:// requests.\n",
        )
        .await;
        return;
    };
    let mut entry = Entry {
        at: (inner.clock)(),
        bot: session.bot.clone(),
        run: session.run.clone(),
        host: target.host.to_ascii_lowercase(),
        port: target.port,
        method: head.method.to_ascii_uppercase(),
        allowed: false,
        reason: None,
        sent: 0,
        received: 0,
    };
    let upstream = match reach(&inner, &session.policy, &target).await {
        Ok(upstream) => upstream,
        Err(Refusal::Policy(reason)) => {
            session.usage.refused.fetch_add(1, Ordering::Relaxed);
            let body = format!("Spade's network policy for this bot refused it: {reason}.\n");
            entry.reason = Some(reason);
            inner.log.append(&entry);
            answer(&mut client, "403 Forbidden", "", &body).await;
            return;
        }
        Err(Refusal::Failed(reason)) => {
            entry.allowed = true;
            entry.reason = Some(reason.clone());
            inner.log.append(&entry);
            answer(&mut client, "502 Bad Gateway", "", &format!("{reason}\n")).await;
            return;
        }
    };
    entry.allowed = true;
    session.usage.connections.fetch_add(1, Ordering::Relaxed);
    let mut upstream = upstream;
    let mut sent = 0u64;
    let opened = match &target.path {
        None => client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .await
            .is_ok(),
        Some(path) => {
            let forwarded = forward_head(&head, path);
            sent += (forwarded.len() + rest.len()) as u64;
            upstream.write_all(&forwarded).await.is_ok() && upstream.write_all(&rest).await.is_ok()
        }
    };
    if target.path.is_none() && !rest.is_empty() {
        sent += rest.len() as u64;
        let _ = upstream.write_all(&rest).await;
    }
    let mut received = 0u64;
    if opened {
        let (up, down) = relay(&mut client, &mut upstream).await;
        sent += up;
        received += down;
    }
    session.usage.sent.fetch_add(sent, Ordering::Relaxed);
    session
        .usage
        .received
        .fetch_add(received, Ordering::Relaxed);
    entry.sent = sent;
    entry.received = received;
    inner.log.append(&entry);
}

/// Copies both ways until both sides are done; answers the bytes each way, counted as they go
/// so a side that resets instead of closing still has what it moved logged.
async fn relay(client: &mut TcpStream, upstream: &mut TcpStream) -> (u64, u64) {
    let (mut client_read, mut client_write) = client.split();
    let (mut upstream_read, mut upstream_write) = upstream.split();
    let up = pipe(&mut client_read, &mut upstream_write);
    let down = pipe(&mut upstream_read, &mut client_write);
    tokio::join!(up, down)
}

async fn pipe(
    from: &mut (impl tokio::io::AsyncRead + Unpin),
    to: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> u64 {
    let mut buffer = vec![0u8; 16 * 1024];
    let mut moved = 0u64;
    loop {
        match from.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if to.write_all(&buffer[..read]).await.is_err() {
                    break;
                }
                moved += read as u64;
            }
        }
    }
    let _ = to.shutdown().await;
    moved
}

enum Refusal {
    Policy(String),
    Failed(String),
}

/// Connects to `target` when `policy` allows it and its address is public (or the person named
/// the local host).
async fn reach(
    inner: &Inner,
    policy: &NetworkPolicy,
    target: &Target,
) -> Result<TcpStream, Refusal> {
    let local = match policy.verdict(&target.host, target.port) {
        Verdict::Allowed { local } => local,
        Verdict::Refused(reason) => return Err(Refusal::Policy(reason)),
    };
    let addresses = tokio::time::timeout(WAIT, inner.resolver.resolve(&target.host, target.port))
        .await
        .map_err(|_| Refusal::Failed(format!("{} could not be resolved in time", target.host)))?
        .map_err(|error| {
            Refusal::Failed(format!("{} could not be resolved: {error}", target.host))
        })?;
    if addresses.is_empty() {
        return Err(Refusal::Failed(format!("{} has no address", target.host)));
    }
    // A public name that resolves to this machine or the local network is refused (rebinding).
    if !local && addresses.iter().any(|a| private(a.ip())) {
        return Err(Refusal::Policy(format!(
            "{} resolves to a private address",
            target.host
        )));
    }
    let mut last = String::from("no address answered");
    for address in addresses {
        match tokio::time::timeout(WAIT, TcpStream::connect(address)).await {
            Ok(Ok(stream)) => return Ok(stream),
            Ok(Err(error)) => last = error.to_string(),
            Err(_) => last = "timed out".to_owned(),
        }
    }
    Err(Refusal::Failed(format!(
        "{}:{} could not be reached: {last}",
        target.host, target.port
    )))
}

/// The head sent on for a plain HTTP request: origin-form, without the proxy's headers, closed
/// after one exchange.
fn forward_head(head: &Head, path: &str) -> Vec<u8> {
    let mut out = format!("{} {} {}\r\n", head.method, path, head.version);
    for (name, value) in &head.headers {
        let lower = name.to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "proxy-authorization" | "proxy-connection" | "connection" | "keep-alive"
        ) {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    out.push_str("Connection: close\r\n\r\n");
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_connect_head_names_its_host_port_and_the_runs_token() {
        let head = parse_head(
            b"CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\nProxy-Authorization: Basic c3BhZGU6dG9rMQ==",
        )
        .unwrap_or_else(|| std::process::abort());
        assert_eq!(head.token().as_deref(), Some("tok1"));
        assert_eq!(
            target(&head),
            Some(Target {
                host: "github.com".into(),
                port: 443,
                path: None
            })
        );
    }

    #[test]
    fn a_plain_request_is_sent_on_in_origin_form_without_the_proxys_headers() {
        let head = parse_head(
            b"GET http://example.org:8080/a?b=1 HTTP/1.1\r\nHost: example.org\r\nProxy-Authorization: Basic eA==\r\nProxy-Connection: keep-alive",
        )
        .unwrap_or_else(|| std::process::abort());
        let to = target(&head).unwrap_or_else(|| std::process::abort());
        assert_eq!((to.host.as_str(), to.port), ("example.org", 8080));
        let sent = String::from_utf8(forward_head(&head, to.path.as_deref().unwrap_or("/")))
            .unwrap_or_default();
        assert_eq!(
            sent,
            "GET /a?b=1 HTTP/1.1\r\nHost: example.org\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn heads_spade_does_not_forward_are_refused() {
        for raw in [
            &b"GET https://example.org/ HTTP/1.1"[..],
            b"GET http://user@example.org/ HTTP/1.1",
            b"CONNECT example.org HTTP/1.1",
            b"GET / HTTP/1.1",
        ] {
            let head = parse_head(raw);
            assert!(head.as_ref().and_then(target).is_none(), "{raw:?}");
        }
        assert!(parse_head(b"GARBAGE").is_none());
    }

    #[test]
    fn an_ipv6_literal_keeps_its_port() {
        assert_eq!(
            split_host_port("[::1]:3000"),
            Some(("::1".to_owned(), Some(3000)))
        );
        assert_eq!(split_host_port(":80"), None);
    }
}
