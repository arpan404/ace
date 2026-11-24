// SPDX-License-Identifier: Apache-2.0
//! The proxy hop: every ordinary HTTP request the listener accepts goes to the
//! daemon's own HTTP server on a fresh connection to 127.0.0.1, with the hop's
//! fields added and both bodies streamed. An upgrade candidate that arrives on
//! a keep-alive connection takes the same decision path through hyper
//! (`UpgradeHandler::upgrade_hyper`); one that arrives first on a connection
//! never reaches this service (see `driver`).
//!
//! One exchange has one deadline, from the service call to the last byte of the
//! answer. The connection's task enforces it (`ExchangeDeadline`), so it fires
//! even when nothing is polling the response body, and the upstream connection
//! is aborted the moment the answer ends, the client goes away or the deadline
//! fires.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::Bytes;
use http::header::{HeaderName, HeaderValue};
use http::{HeaderMap, Method, Request, Response, Uri};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::client::conn::http1;
use hyper::service::Service;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;
use tokio::sync::{Notify, watch};
use tokio::task::JoinHandle;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::driver::{Grace, UpgradeHandler, UpgradeIo, UpgradeReply};
use crate::error::TransportError;
use crate::head::{self, RequestHead};
use crate::hop::{self, HopSecret};
use crate::peer::Peer;
use crate::prefixed::WriteTimeout;
use crate::stats::Stats;

/// The loopback listener's exchange deadline, from the service call to the last
/// byte of the answer: Node's `requestTimeout` bounds receiving the whole request
/// with the same 300 s, and the same deadline covers the response this hop
/// streams back. Nothing answers a status when it fires (T1a.2 answers 400 and
/// 431 only), so the client connection is closed. `ConnectionLimits::exchange`
/// carries it, and a remote listener passes `None` for Node's
/// `requestTimeout: 0` (T1b.1a).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// The one address the transport binds and connects on: 127.0.0.1, never the
/// rest of the loopback range.
pub(crate) fn is_localhost(addr: std::net::SocketAddr) -> bool {
    addr.ip() == std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)
}

/// What the listener forwards to.
#[derive(Clone)]
pub struct ProxyTarget {
    /// The daemon's own HTTP server. 127.0.0.1 only.
    pub addr: std::net::SocketAddr,
    /// The secret every forwarded request carries.
    pub secret: Arc<HopSecret>,
}

impl ProxyTarget {
    pub fn new(addr: std::net::SocketAddr, secret: Arc<HopSecret>) -> Result<Self, TransportError> {
        if !is_localhost(addr) {
            return Err(TransportError::NotLoopback { addr });
        }
        Ok(Self { addr, secret })
    }
}

/// What a forwarded request or an upgrade on a keep-alive connection failed
/// with. The connection ends without a response, as hyper does for a service
/// error.
#[derive(Debug, thiserror::Error)]
pub enum ProxyError {
    /// The internal server could not be reached.
    #[error("connect to the internal server: {0}")]
    Connect(#[source] io::Error),
    /// The internal server did not speak HTTP/1.1.
    #[error("internal server handshake: {0}")]
    Handshake(#[source] hyper::Error),
    /// The request or its response failed upstream.
    #[error("internal server request: {0}")]
    Request(#[source] hyper::Error),
    /// The response body failed upstream; the client must never read a
    /// truncated body as complete.
    #[error("internal server response body: {0}")]
    Body(#[source] hyper::Error),
    /// The request-target or method hyper refused to frame again.
    #[error("request cannot be forwarded")]
    Target,
    /// The exchange did not finish in time; no status is answered for it.
    #[error("exchange did not finish in time")]
    Timeout,
    /// The upgrade handler closed the connection with no answer.
    #[error("the upgrade handler closed the connection")]
    Dropped,
}

/// The body both answers and forwarded responses carry.
type HopBody = UnsyncBoxBody<Bytes, ProxyError>;

/// The deadline of the exchange a connection is running, armed by the service
/// when a request starts and cleared when the answer ends.
///
/// The service's own `timeout_at` covers connect, upload and the response head,
/// but a response body is only driven when hyper can write it: a blocked client
/// would otherwise outlive the deadline. The connection's task waits on
/// [`ExchangeDeadline::reached`] beside the connection itself and closes it
/// when the deadline passes, which drops the body and aborts the upstream.
#[derive(Debug, Default)]
pub struct ExchangeDeadline {
    armed: watch::Sender<Option<Instant>>,
}

impl ExchangeDeadline {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn arm(&self, at: Instant) {
        self.armed.send_replace(Some(at));
    }

    /// Clear the deadline this exchange armed; a later exchange's stays.
    fn clear(&self, at: Instant) {
        self.armed.send_if_modified(|slot| {
            if *slot == Some(at) {
                *slot = None;
                true
            } else {
                false
            }
        });
    }

    /// Resolve once the armed deadline has passed. Waits while none is armed.
    pub(crate) async fn reached(&self) {
        let mut armed = self.armed.subscribe();
        loop {
            let Some(at) = *armed.borrow_and_update() else {
                if armed.changed().await.is_err() {
                    return;
                }
                continue;
            };
            tokio::select! {
                _ = tokio::time::sleep_until(at) => {
                    if *armed.borrow() == Some(at) {
                        return;
                    }
                }
                changed = armed.changed() => {
                    if changed.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

/// One request's progress: how many are in flight (upgrades included), how many
/// responses have finished, and when the last of either happened, so the idle
/// timer restarts at the moment an answer ends.
#[derive(Debug)]
pub struct RequestActivity {
    in_flight: AtomicUsize,
    changes: AtomicUsize,
    changed_at: Mutex<Instant>,
    notify: Notify,
}

impl Default for RequestActivity {
    fn default() -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            changes: AtomicUsize::new(0),
            changed_at: Mutex::new(Instant::now()),
            notify: Notify::new(),
        }
    }
}

impl RequestActivity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn note_change(&self) {
        self.changes.fetch_add(1, Ordering::SeqCst);
        let mut changed_at = self
            .changed_at
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *changed_at = Instant::now();
        drop(changed_at);
        self.notify.notify_waiters();
    }

    fn arrive(&self) {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        self.note_change();
    }

    fn finish(&self) {
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.note_change();
    }

    /// Resolve once no request has been in flight for `idle`, which is Node's
    /// `keepAliveTimeout` for a connection waiting on its next request. The
    /// window starts when the last request started or ended, so a change during
    /// the wait moves it rather than shortening it.
    pub async fn wait_idle(&self, idle: Duration) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Arm the listener before reading the state, so a change between
            // the two is not missed.
            notified.as_mut().enable();
            if self.in_flight.load(Ordering::SeqCst) > 0 {
                notified.as_mut().await;
                continue;
            }
            let changes = self.changes.load(Ordering::SeqCst);
            let since = *self
                .changed_at
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            tokio::select! {
                _ = tokio::time::sleep_until(since + idle) => {
                    if self.in_flight.load(Ordering::SeqCst) == 0
                        && self.changes.load(Ordering::SeqCst) == changes
                    {
                        return;
                    }
                }
                _ = notified.as_mut() => {}
            }
        }
    }
}

/// A request counted as in flight, and its exchange's deadline armed, until its
/// answer is handed to hyper.
struct InFlight {
    activity: Arc<RequestActivity>,
    deadlines: Arc<ExchangeDeadline>,
    /// When this exchange must be over; None when the listener has no deadline.
    at: Option<Instant>,
    /// Still the guard's: no response body has taken over finishing it.
    armed: bool,
}

impl InFlight {
    fn start(
        activity: &Arc<RequestActivity>,
        deadlines: &Arc<ExchangeDeadline>,
        exchange: Option<Duration>,
    ) -> Self {
        let at = exchange.map(|limit| Instant::now() + limit);
        if let Some(at) = at {
            deadlines.arm(at);
        }
        activity.arrive();
        Self {
            activity: Arc::clone(activity),
            deadlines: Arc::clone(deadlines),
            at,
            armed: true,
        }
    }

    fn deadline(&self) -> Option<Instant> {
        self.at
    }

    fn track<B: Body<Data = Bytes>>(
        mut self,
        inner: B,
        error: fn(B::Error) -> ProxyError,
        upstream: Option<Upstream>,
    ) -> TrackedBody<B> {
        self.armed = false;
        TrackedBody {
            inner,
            error,
            activity: Arc::clone(&self.activity),
            deadlines: Arc::clone(&self.deadlines),
            at: self.at,
            upstream,
            finished: false,
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if self.armed {
            if let Some(at) = self.at {
                self.deadlines.clear(at);
            }
            self.activity.finish();
        }
    }
}

/// The upstream connection's task, aborted when its value is dropped.
struct Upstream(JoinHandle<()>);

impl Drop for Upstream {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// A response body that reports its request finished when hyper is done with
/// it, whether it streamed to the end or the client went away. The exchange's
/// deadline is cleared with it, so the next request's timer is its own.
pub struct TrackedBody<B: Body<Data = Bytes>> {
    inner: B,
    error: fn(B::Error) -> ProxyError,
    activity: Arc<RequestActivity>,
    deadlines: Arc<ExchangeDeadline>,
    at: Option<Instant>,
    upstream: Option<Upstream>,
    finished: bool,
}

impl<B: Body<Data = Bytes>> TrackedBody<B> {
    /// Called on every way an answer ends: the body's end, a trailers frame,
    /// an error, the client going away, or the connection being closed.
    fn finish(&mut self) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.upstream = None;
        if let Some(at) = self.at {
            self.deadlines.clear(at);
        }
        self.activity.finish();
    }
}

impl<B: Body<Data = Bytes> + Unpin> Body for TrackedBody<B> {
    type Data = Bytes;
    type Error = ProxyError;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, ProxyError>>> {
        let this = self.get_mut();
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => {
                // A trailers frame ends a chunked body, and hyper may drop the
                // body without asking for `None` again.
                if frame.is_trailers() {
                    this.finish();
                }
                Poll::Ready(Some(Ok(frame)))
            }
            Poll::Ready(Some(Err(error))) => {
                this.finish();
                let map = this.error;
                Poll::Ready(Some(Err(map(error))))
            }
            Poll::Ready(None) => {
                this.finish();
                Poll::Ready(None)
            }
            Poll::Pending => Poll::Pending,
        }
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl<B: Body<Data = Bytes>> Drop for TrackedBody<B> {
    fn drop(&mut self) {
        self.finish();
    }
}

/// What a connection's close needs: the listener's stop signal and the close
/// deadline's per-connection guard, which the upgrade arms when it writes its
/// `101`.
#[derive(Clone)]
pub struct Stop {
    pub shutdown: CancellationToken,
    pub grace: Grace,
}

/// What one connection gives every exchange it runs.
pub struct ConnectionState {
    pub peer: Peer,
    pub stop: Stop,
    pub activity: Arc<RequestActivity>,
    pub deadlines: Arc<ExchangeDeadline>,
    /// The whole exchange's deadline; None on a listener with no request
    /// timeout (T1b.1a's `ConnectionLimits::exchange`).
    pub exchange: Option<Duration>,
    /// The connection's write bound, armed for a `101` or a refusal and dropped
    /// once the upgrade leaves HTTP (T1b.1a).
    pub write: WriteTimeout,
    /// The bound a `101` or a refusal is written under.
    pub upgrade_write: Duration,
    /// The first request head's target, exactly as the driver read it. hyper's
    /// `Uri` fills "/" into a pathless absolute form, so only the head the
    /// driver parsed can be forwarded byte for byte.
    pub first_target: Option<String>,
    /// This listener's counters (T1b.1b): one per exchange answered.
    pub stats: Arc<Stats>,
}

/// Everything one exchange needs, cloned per request.
#[derive(Clone)]
struct Exchange {
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    peer: Peer,
    stop: Stop,
    activity: Arc<RequestActivity>,
    deadlines: Arc<ExchangeDeadline>,
    /// The first request head's target, exactly as the driver read it. hyper's
    /// `Uri` fills "/" into a pathless absolute form, so only the head the
    /// driver parsed can be forwarded byte for byte.
    first_target: Arc<Mutex<Option<String>>>,
    /// The whole exchange's deadline; None on a listener with no request
    /// timeout (T1b.1a's `ConnectionLimits::exchange`).
    exchange: Option<Duration>,
    /// The connection's write bound (T1b.1a).
    write: WriteTimeout,
    /// The bound a `101` or a refusal is written under.
    upgrade_write: Duration,
    /// This listener's counters (T1b.1b).
    stats: Arc<Stats>,
}

/// The service hyper's server runs for ordinary requests and for upgrade
/// candidates on a keep-alive connection.
pub struct ProxyService {
    exchange: Exchange,
}

impl ProxyService {
    pub fn new(
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
        state: ConnectionState,
    ) -> Self {
        Self {
            exchange: Exchange {
                target,
                upgrades,
                peer: state.peer,
                stop: state.stop,
                activity: state.activity,
                deadlines: state.deadlines,
                first_target: Arc::new(Mutex::new(state.first_target)),
                exchange: state.exchange,
                write: state.write,
                upgrade_write: state.upgrade_write,
                stats: state.stats,
            },
        }
    }
}

impl Service<Request<Incoming>> for ProxyService {
    type Response = Response<HopBody>;
    type Error = ProxyError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, req: Request<Incoming>) -> Self::Future {
        self.exchange.stats.exchange();
        let exchange = self.exchange.clone();
        Box::pin(async move { handle(exchange, req).await })
    }
}

async fn handle(
    exchange: Exchange,
    mut req: Request<Incoming>,
) -> Result<Response<HopBody>, ProxyError> {
    let in_flight = InFlight::start(&exchange.activity, &exchange.deadlines, exchange.exchange);
    let head = request_head(&exchange, &req);
    if head::is_upgrade_candidate(&head) {
        return upgrade(exchange, in_flight, &mut req, head).await;
    }
    forward(exchange, in_flight, head, req).await
}

async fn upgrade(
    exchange: Exchange,
    in_flight: InFlight,
    req: &mut Request<Incoming>,
    head: RequestHead,
) -> Result<Response<HopBody>, ProxyError> {
    let reply = exchange
        .upgrades
        .upgrade_hyper(
            head,
            exchange.peer,
            exchange.stop.shutdown.clone(),
            exchange.stop.grace.clone(),
        )
        .await;
    match reply {
        // hyper ends the connection with no response when the service fails.
        UpgradeReply::Drop => Err(ProxyError::Dropped),
        UpgradeReply::Refuse(refusal) => {
            // The refusal is written by hyper under the connection's write bound,
            // as `ws` bounds its own `abortHandshake`; it closes the connection,
            // so the bound is never left armed for a later request.
            exchange.write.set(Some(exchange.upgrade_write));
            Ok(answered(refusal, in_flight))
        }
        UpgradeReply::Switch(answer, reservation) => {
            // The `101` is written by hyper after this returns; only then can
            // the upgrade resolve. The connection's write bound is armed for it,
            // so a client that never reads cannot hold a close deadline (which
            // the armed upgrade stops from firing) open forever.
            exchange.write.set(Some(exchange.upgrade_write));
            let switching = hyper::upgrade::on(req);
            let upgrades = Arc::clone(&exchange.upgrades);
            let write = exchange.write.clone();
            tokio::spawn(async move {
                let stream: Option<Box<dyn UpgradeIo>> = match switching.await {
                    Ok(upgraded) => {
                        // The socket is a WebSocket now; hyper's HTTP loop never
                        // touches it again and Node bounds no WebSocket write.
                        write.set(None);
                        Some(Box::new(TokioIo::new(upgraded)))
                    }
                    Err(_) => None,
                };
                upgrades.switched(reservation, stream);
            });
            Ok(answered(answer, in_flight))
        }
    }
}

/// Await `future`, failing as [`ProxyError::Timeout`] at `deadline`; with no
/// deadline it is awaited as long as it takes (Node's `requestTimeout: 0`).
async fn before<F: Future>(deadline: Option<Instant>, future: F) -> Result<F::Output, ProxyError> {
    match deadline {
        Some(at) => tokio::time::timeout_at(at, future)
            .await
            .map_err(|_| ProxyError::Timeout),
        None => Ok(future.await),
    }
}

async fn forward(
    exchange: Exchange,
    in_flight: InFlight,
    head: RequestHead,
    req: Request<Incoming>,
) -> Result<Response<HopBody>, ProxyError> {
    // One deadline for the whole exchange, the upload and the answer alike; the
    // connection's task enforces it once the answer starts streaming.
    let deadline = in_flight.deadline();

    let connected = before(deadline, TcpStream::connect(exchange.target.addr))
        .await?
        .map_err(ProxyError::Connect)?;
    let (mut sender, connection) = before(deadline, http1::handshake(TokioIo::new(connected)))
        .await?
        .map_err(ProxyError::Handshake)?;
    // Aborted through the guard on every path that ends the exchange early.
    let upstream = Upstream(tokio::spawn(async move {
        let _ = connection.await;
    }));

    let request = build_request(
        &head,
        &exchange.target.secret,
        &exchange.peer,
        req.into_body(),
    )?;
    let response = before(deadline, sender.send_request(request))
        .await?
        .map_err(ProxyError::Request)?;

    let (mut parts, body) = response.into_parts();
    parts.headers = header_map(hop::response_headers(&header_pairs(&parts.headers)));
    let answer = in_flight.track(body, ProxyError::Body, Some(upstream));
    Ok(Response::from_parts(parts, answer.boxed_unsync()))
}

fn request_head(exchange: &Exchange, req: &Request<Incoming>) -> RequestHead {
    let first = exchange
        .first_target
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .take();
    RequestHead {
        method: req.method().as_str().to_owned(),
        target: first.unwrap_or_else(|| req.uri().to_string()),
        version: req.version(),
        headers: header_pairs(req.headers()),
    }
}

fn build_request(
    head: &RequestHead,
    secret: &HopSecret,
    peer: &Peer,
    body: Incoming,
) -> Result<Request<Incoming>, ProxyError> {
    let method = Method::from_bytes(head.method.as_bytes()).map_err(|_| ProxyError::Target)?;
    let target: Uri = head.target.parse().map_err(|_| ProxyError::Target)?;
    let mut request = Request::new(body);
    *request.method_mut() = method;
    *request.uri_mut() = target;
    *request.headers_mut() = header_map(hop::request_headers(&head.headers, secret, peer));
    Ok(request)
}

fn answered(answer: Response<Full<Bytes>>, in_flight: InFlight) -> Response<HopBody> {
    answer.map(|body| {
        in_flight
            .track(body, |never| match never {}, None)
            .boxed_unsync()
    })
}

fn header_pairs(headers: &HeaderMap) -> Vec<(String, Vec<u8>)> {
    headers
        .iter()
        .map(|(name, value)| (name.as_str().to_owned(), value.as_bytes().to_vec()))
        .collect()
}

fn header_map(pairs: Vec<(String, Vec<u8>)>) -> HeaderMap {
    let mut headers = HeaderMap::with_capacity(pairs.len());
    for (name, value) in pairs {
        // httparse accepted these bytes; http refuses only what it cannot frame
        // again (a control character in a value), which no client sends.
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_bytes(&value),
        ) else {
            continue;
        };
        headers.append(name, value);
    }
    headers
}
