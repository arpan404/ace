//! The local egress proxy (ADR 0167 decision 3). One loopback listener; each sandboxed run gets
//! a [`Ticket`] whose token it presents as the proxy's Basic credential, which names its bot, run
//! and policy. `CONNECT host:port` is tunnelled and absolute-form HTTP requests are forwarded,
//! when the policy allows the host and the address it resolves to isn't private (unless the
//! person named a local host). TLS passes through untouched: the proxy never sees or adds an
//! `Authorization` header.
//!
//! Bounded ([`Limits`]): connections are admitted before any task is spawned for them, a client
//! has a deadline for its request's head, a run has a cap of open tunnels, and a tunnel with no
//! traffic either way is closed. Dropping a run's ticket cancels its session: tunnels it has open
//! close, and connections still being made are abandoned. Every connection is logged when it is
//! admitted, its bytes counted as they move and written at bounded intervals while it runs, and
//! its end.

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, watch};

use super::head::{Target, forward_head, parse_head, target};
use super::hosts::{NetworkPolicy, Verdict, private};
use super::log::{EgressLog, Entry};

/// The most a request's head may be.
const MOST_HEAD: usize = 16 * 1024;

/// The proxy's bounds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    /// Connections open at once, across every run; past it a new one is closed unread.
    pub connections: usize,
    /// Tunnels (and forwarded requests) one run may have open at once; past it `429`.
    pub per_session: usize,
    /// How long a client has to send its request's head.
    pub head: Duration,
    /// How long a host has to resolve and accept the connection.
    pub connect: Duration,
    /// How long a tunnel may go with no bytes either way before it is closed.
    pub idle: Duration,
    /// How often an open tunnel's bytes so far are written to the log.
    pub progress: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            connections: 512,
            per_session: 64,
            head: Duration::from_secs(10),
            connect: Duration::from_secs(30),
            idle: Duration::from_secs(300),
            progress: Duration::from_secs(30),
        }
    }
}

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

/// What a run did through the proxy, bytes counted as they move.
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
    /// Tunnels open now.
    open: AtomicUsize,
    /// Set when the ticket is dropped: everything of the session ends.
    cancel: watch::Sender<bool>,
}

impl Session {
    async fn cancelled(&self) {
        let mut cancelled = self.cancel.subscribe();
        let _ = cancelled.wait_for(|c| *c).await;
    }
}

/// One of a session's open tunnels, counted while it lives.
struct Slot(Arc<Session>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
    }
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    log: Arc<EgressLog>,
    resolver: Arc<dyn Resolve>,
    clock: Clock,
    tokens: Arc<dyn Fn() -> String + Send + Sync>,
    limits: Limits,
    connections: AtomicU64,
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
    /// Listens on `127.0.0.1` at a free port with the default [`Limits`]. `tokens` makes each
    /// run's secret.
    pub async fn start(
        log: Arc<EgressLog>,
        resolver: Arc<dyn Resolve>,
        clock: Clock,
        tokens: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> std::io::Result<Self> {
        Self::start_with(log, resolver, clock, tokens, Limits::default()).await
    }

    /// [`Proxy::start`] with `limits`.
    pub async fn start_with(
        log: Arc<EgressLog>,
        resolver: Arc<dyn Resolve>,
        clock: Clock,
        tokens: Arc<dyn Fn() -> String + Send + Sync>,
        limits: Limits,
    ) -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        let inner = Arc::new(Inner {
            sessions: Mutex::new(HashMap::new()),
            log,
            resolver,
            clock,
            tokens,
            limits,
            connections: AtomicU64::new(0),
        });
        let serving = inner.clone();
        let admission = Arc::new(Semaphore::new(limits.connections.max(1)));
        let accept = tokio::spawn(async move {
            loop {
                let Ok((client, _)) = listener.accept().await else {
                    continue;
                };
                // Admitted before anything is spawned for it; past the bound it is closed unread.
                match admission.clone().try_acquire_owned() {
                    Ok(permit) => {
                        let serving = serving.clone();
                        tokio::spawn(async move {
                            serve(serving, client).await;
                            drop(permit);
                        });
                    }
                    Err(_) => drop(client),
                }
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
            open: AtomicUsize::new(0),
            cancel: watch::Sender::new(false),
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

/// One run's access to the proxy, ended when dropped: no new request is accepted for it, and
/// its open and pending connections end.
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
        self.session.cancel.send_replace(true);
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
    let Ok(Some((raw, rest))) =
        tokio::time::timeout(inner.limits.head, read_head(&mut client)).await
    else {
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
    // The run's cap of open tunnels, counted before any work for this one.
    if session.open.fetch_add(1, Ordering::SeqCst) >= inner.limits.per_session {
        session.open.fetch_sub(1, Ordering::SeqCst);
        answer(
            &mut client,
            "429 Too Many Requests",
            "",
            "This run has as many connections open as Spade allows.\n",
        )
        .await;
        return;
    }
    let _slot = Slot(session.clone());
    let mut entry = Entry {
        at: (inner.clock)(),
        connection: inner.connections.fetch_add(1, Ordering::Relaxed) + 1,
        phase: String::new(),
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
    // A ticket dropped while the host is being reached abandons it.
    let reached = tokio::select! {
        reached = reach(&inner, &session.policy, &target) => reached,
        () = session.cancelled() => return,
    };
    let mut upstream = match reached {
        Ok(upstream) => upstream,
        Err(Refusal::Policy(reason)) => {
            session.usage.refused.fetch_add(1, Ordering::Relaxed);
            let body = format!("Spade's network policy for this bot refused it: {reason}.\n");
            entry.phase = "refused".to_owned();
            entry.reason = Some(reason);
            inner.log.append(&entry);
            answer(&mut client, "403 Forbidden", "", &body).await;
            return;
        }
        Err(Refusal::Failed(reason)) => {
            entry.allowed = true;
            entry.phase = "failed".to_owned();
            entry.reason = Some(reason.clone());
            inner.log.append(&entry);
            answer(&mut client, "502 Bad Gateway", "", &format!("{reason}\n")).await;
            return;
        }
    };
    entry.allowed = true;
    entry.phase = "opened".to_owned();
    inner.log.append(&entry);
    session.usage.connections.fetch_add(1, Ordering::Relaxed);
    let moved = Moved::default();
    let ahead = match &target.path {
        None => {
            let shown = client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await
                .is_ok();
            shown.then(|| rest.clone())
        }
        Some(path) => Some([forward_head(&head, path), rest.clone()].concat()),
    };
    let opened = match ahead {
        Some(bytes) => {
            let written = upstream.write_all(&bytes).await.is_ok();
            moved.sent.fetch_add(bytes.len() as u64, Ordering::Relaxed);
            session
                .usage
                .sent
                .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            written
        }
        None => false,
    };
    if opened {
        relay(
            &inner,
            &session,
            &mut entry,
            &moved,
            &mut client,
            &mut upstream,
        )
        .await;
    }
    entry.phase = "closed".to_owned();
    entry.at = (inner.clock)();
    entry.sent = moved.sent.load(Ordering::Relaxed);
    entry.received = moved.received.load(Ordering::Relaxed);
    inner.log.append(&entry);
}

/// One connection's bytes each way, and when it last moved any.
#[derive(Default)]
struct Moved {
    sent: AtomicU64,
    received: AtomicU64,
    /// Milliseconds since the relay began.
    last: AtomicU64,
}

/// Copies both ways until both sides are done, the session is cancelled or the tunnel goes idle,
/// counting bytes as they move and logging them at bounded intervals.
async fn relay(
    inner: &Inner,
    session: &Session,
    entry: &mut Entry,
    moved: &Moved,
    client: &mut TcpStream,
    upstream: &mut TcpStream,
) {
    let began = tokio::time::Instant::now();
    let (mut client_read, mut client_write) = client.split();
    let (mut upstream_read, mut upstream_write) = upstream.split();
    let up = pipe(
        &mut client_read,
        &mut upstream_write,
        [&moved.sent, &session.usage.sent],
        &moved.last,
        began,
    );
    let down = pipe(
        &mut upstream_read,
        &mut client_write,
        [&moved.received, &session.usage.received],
        &moved.last,
        began,
    );
    let both = async { tokio::join!(up, down) };
    tokio::pin!(both);
    let limits = inner.limits;
    let tick = limits
        .progress
        .min(limits.idle)
        .min(Duration::from_secs(1))
        .max(Duration::from_millis(10));
    let mut ticker = tokio::time::interval(tick);
    ticker.tick().await;
    let mut logged_at = tokio::time::Instant::now();
    let mut logged = (0, 0);
    loop {
        tokio::select! {
            _ = &mut both => return,
            () = session.cancelled() => return,
            _ = ticker.tick() => {
                let now = tokio::time::Instant::now();
                let moved_at = began + Duration::from_millis(moved.last.load(Ordering::Relaxed));
                if now.duration_since(moved_at) >= limits.idle {
                    return;
                }
                let so_far = (
                    moved.sent.load(Ordering::Relaxed),
                    moved.received.load(Ordering::Relaxed),
                );
                if now.duration_since(logged_at) >= limits.progress && so_far != logged {
                    entry.phase = "progress".to_owned();
                    entry.at = (inner.clock)();
                    (entry.sent, entry.received) = so_far;
                    inner.log.append(entry);
                    (logged_at, logged) = (now, so_far);
                }
            }
        }
    }
}

/// Copies `from` to `to` until either ends, adding each chunk to `counts` and noting when.
async fn pipe(
    from: &mut (impl tokio::io::AsyncRead + Unpin),
    to: &mut (impl tokio::io::AsyncWrite + Unpin),
    counts: [&AtomicU64; 2],
    last: &AtomicU64,
    began: tokio::time::Instant,
) {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        match from.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if to.write_all(&buffer[..read]).await.is_err() {
                    break;
                }
                for count in counts {
                    count.fetch_add(read as u64, Ordering::Relaxed);
                }
                let since = u64::try_from(began.elapsed().as_millis()).unwrap_or(u64::MAX);
                last.store(since, Ordering::Relaxed);
            }
        }
    }
    let _ = to.shutdown().await;
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
    let wait = inner.limits.connect;
    let local = match policy.verdict(&target.host, target.port) {
        Verdict::Allowed { local } => local,
        Verdict::Refused(reason) => return Err(Refusal::Policy(reason)),
    };
    let addresses = tokio::time::timeout(wait, inner.resolver.resolve(&target.host, target.port))
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
        match tokio::time::timeout(wait, TcpStream::connect(address)).await {
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
