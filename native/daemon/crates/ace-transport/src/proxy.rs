// SPDX-License-Identifier: Apache-2.0
//! The proxy hop: every ordinary HTTP request the listener accepts goes to the
//! daemon's own HTTP server on a fresh connection to 127.0.0.1, with the hop's
//! fields added and both bodies streamed. An upgrade candidate that arrives on
//! a keep-alive connection takes the same decision path through hyper
//! (`UpgradeHandler::upgrade_hyper`); one that arrives first on a connection
//! never reaches this service (see `driver`).
//!
//! One exchange has one deadline, from the service call to the last byte of the
//! answer, and its upstream connection is aborted the moment the answer ends,
//! the client goes away or the deadline fires.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{Instant, Sleep};
use tokio_util::sync::CancellationToken;

use crate::driver::{UpgradeHandler, UpgradeIo, UpgradeReply};
use crate::error::TransportError;
use crate::head::{self, RequestHead};
use crate::hop::{self, HopSecret};
use crate::peer::Peer;

/// How long one exchange may take, from the service call to the last byte of
/// the answer: Node's `requestTimeout` bounds receiving the whole request with
/// the same 300 s, and the same deadline covers the response this hop streams
/// back. Nothing answers a status when it fires (T1a.2 answers 400 and 431
/// only), so the connection is reset.
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
    /// The client stopped sending before its upload ended.
    #[error("client went away before its request body ended")]
    ClientGone,
    /// The upgrade handler closed the connection with no answer.
    #[error("the upgrade handler closed the connection")]
    Dropped,
}

/// The body both answers and forwarded responses carry.
type HopBody = UnsyncBoxBody<Bytes, ProxyError>;

/// One connection's upload side: whether its current request body has ended,
/// and the token the socket watch cancels when the client goes away first.
#[derive(Clone)]
pub struct UploadWatch {
    ended: Arc<AtomicBool>,
    gone: CancellationToken,
}

impl Default for UploadWatch {
    fn default() -> Self {
        Self::new()
    }
}

impl UploadWatch {
    pub fn new() -> Self {
        Self {
            ended: Arc::new(AtomicBool::new(false)),
            gone: CancellationToken::new(),
        }
    }

    /// The token the socket watch cancels.
    pub fn client_gone(&self) -> CancellationToken {
        self.gone.clone()
    }

    /// Whether the request body being sent has reached its end. The socket
    /// watch uses it to tell a half-close after a complete request from a
    /// client that went away mid-upload.
    pub fn has_ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    /// A new request's body starts unended.
    fn restart(&self) {
        self.ended.store(false, Ordering::SeqCst);
    }

    fn end(&self) {
        self.ended.store(true, Ordering::SeqCst);
    }

    /// The client sent nothing more before its upload ended, or reset the
    /// connection.
    pub fn cancel(&self) {
        self.gone.cancel();
    }
}

/// One request's progress: how many are in flight (upgrades included), how many
/// responses have finished, and a generation that changes with every start and
/// finish so the idle timer restarts with each request.
#[derive(Debug)]
pub struct RequestActivity {
    in_flight: AtomicUsize,
    completed: AtomicUsize,
    changes: AtomicUsize,
    notify: Notify,
}

impl Default for RequestActivity {
    fn default() -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            completed: AtomicUsize::new(0),
            changes: AtomicUsize::new(0),
            notify: Notify::new(),
        }
    }
}

impl RequestActivity {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn start(self: &Arc<Self>) -> InFlight {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        self.changes.fetch_add(1, Ordering::SeqCst);
        InFlight {
            activity: Arc::clone(self),
            armed: true,
        }
    }

    fn finish(&self, completed: bool) {
        if completed {
            self.completed.fetch_add(1, Ordering::SeqCst);
        }
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.changes.fetch_add(1, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    /// Whether any response has finished on this connection yet. A fresh
    /// connection's header read is the header timeout's business, not the
    /// keep-alive one's.
    pub fn completed_any(&self) -> bool {
        self.completed.load(Ordering::SeqCst) > 0
    }

    /// Resolve once no request has been in flight for `idle`, which is Node's
    /// `keepAliveTimeout` for a connection waiting on its next request. A
    /// request that starts or ends during the wait restarts it.
    pub async fn wait_idle(&self, idle: Duration) {
        loop {
            let changes = self.changes.load(Ordering::SeqCst);
            let notified = self.notify.notified();
            tokio::pin!(notified);
            // Arm the listener before reading the counter, so a request that
            // finishes between the two is not missed.
            notified.as_mut().enable();
            if self.in_flight.load(Ordering::SeqCst) > 0 {
                notified.await;
                continue;
            }
            tokio::time::sleep(idle).await;
            if self.in_flight.load(Ordering::SeqCst) == 0
                && self.changes.load(Ordering::SeqCst) == changes
            {
                return;
            }
        }
    }
}

/// A request counted as in flight until its answer is handed to hyper.
struct InFlight {
    activity: Arc<RequestActivity>,
    armed: bool,
}

impl InFlight {
    fn track<B: Body<Data = Bytes>>(
        mut self,
        inner: B,
        error: fn(B::Error) -> ProxyError,
        deadline: Option<Pin<Box<Sleep>>>,
        upstream: Option<Upstream>,
        counts_as_answer: bool,
    ) -> TrackedBody<B> {
        self.armed = false;
        TrackedBody {
            inner,
            error,
            activity: Arc::clone(&self.activity),
            deadline,
            upstream,
            counts_as_answer,
            finished: false,
        }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        if self.armed {
            self.activity.finish(false);
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
/// it, bounds the whole exchange with the request's deadline, and aborts the
/// upstream connection when the answer ends or the client goes away (hyper
/// drops the body when the connection dies).
pub struct TrackedBody<B: Body<Data = Bytes>> {
    inner: B,
    error: fn(B::Error) -> ProxyError,
    activity: Arc<RequestActivity>,
    deadline: Option<Pin<Box<Sleep>>>,
    upstream: Option<Upstream>,
    counts_as_answer: bool,
    finished: bool,
}

impl<B: Body<Data = Bytes>> TrackedBody<B> {
    fn finish(&mut self, completed: bool) {
        if self.finished {
            return;
        }
        self.finished = true;
        self.upstream = None;
        self.activity.finish(completed && self.counts_as_answer);
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
        if let Some(deadline) = this.deadline.as_mut()
            && deadline.as_mut().poll(cx).is_ready()
        {
            this.finish(false);
            return Poll::Ready(Some(Err(ProxyError::Timeout)));
        }
        match Pin::new(&mut this.inner).poll_frame(cx) {
            Poll::Ready(Some(Ok(frame))) => Poll::Ready(Some(Ok(frame))),
            Poll::Ready(Some(Err(error))) => {
                this.finish(false);
                let map = this.error;
                Poll::Ready(Some(Err(map(error))))
            }
            Poll::Ready(None) => {
                this.finish(true);
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
        self.finish(false);
    }
}

/// The client's request body, noting when it reaches its end for the socket
/// watch.
pub struct UploadBody {
    inner: Incoming,
    watch: UploadWatch,
}

impl UploadBody {
    /// A body that is already empty is never polled, so it notes its end here.
    fn new(inner: Incoming, watch: UploadWatch) -> Self {
        if inner.is_end_stream() {
            watch.end();
        }
        Self { inner, watch }
    }
}

impl Body for UploadBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_frame(cx);
        if matches!(polled, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            this.watch.end();
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

/// Everything one exchange needs, cloned per request.
#[derive(Clone)]
struct Exchange {
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    peer: Peer,
    shutdown: CancellationToken,
    activity: Arc<RequestActivity>,
    upload: UploadWatch,
    /// The first request head's target, exactly as the driver read it. hyper's
    /// `Uri` fills "/" into a pathless absolute form, so only the head the
    /// driver parsed can be forwarded byte for byte.
    first_target: Arc<Mutex<Option<String>>>,
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
        peer: Peer,
        shutdown: CancellationToken,
        activity: Arc<RequestActivity>,
        upload: UploadWatch,
        first_target: Option<String>,
    ) -> Self {
        Self {
            exchange: Exchange {
                target,
                upgrades,
                peer,
                shutdown,
                activity,
                upload,
                first_target: Arc::new(Mutex::new(first_target)),
            },
        }
    }
}

impl Service<Request<Incoming>> for ProxyService {
    type Response = Response<HopBody>;
    type Error = ProxyError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, req: Request<Incoming>) -> Self::Future {
        let exchange = self.exchange.clone();
        Box::pin(async move { handle(exchange, req).await })
    }
}

async fn handle(
    exchange: Exchange,
    mut req: Request<Incoming>,
) -> Result<Response<HopBody>, ProxyError> {
    exchange.upload.restart();
    let in_flight = exchange.activity.start();
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
        .upgrade_hyper(head, exchange.peer, exchange.shutdown.clone())
        .await;
    match reply {
        // hyper ends the connection with no response when the service fails.
        UpgradeReply::Drop => Err(ProxyError::Dropped),
        UpgradeReply::Refuse(refusal) => Ok(answered(refusal, in_flight)),
        UpgradeReply::Switch(answer, reservation) => {
            // The `101` is written by hyper after this returns; only then can
            // the upgrade resolve. Nothing bounds it but the stream's write
            // timeout.
            let switching = hyper::upgrade::on(req);
            let upgrades = Arc::clone(&exchange.upgrades);
            tokio::spawn(async move {
                let stream: Option<Box<dyn UpgradeIo>> = match switching.await {
                    Ok(upgraded) => Some(Box::new(TokioIo::new(upgraded))),
                    Err(_) => None,
                };
                upgrades.switched(reservation, stream);
            });
            Ok(answered(answer, in_flight))
        }
    }
}

async fn forward(
    exchange: Exchange,
    in_flight: InFlight,
    head: RequestHead,
    req: Request<Incoming>,
) -> Result<Response<HopBody>, ProxyError> {
    // One deadline for the whole exchange, the upload and the answer alike.
    let deadline = Instant::now() + REQUEST_TIMEOUT;

    let connected = tokio::time::timeout_at(deadline, TcpStream::connect(exchange.target.addr))
        .await
        .map_err(|_| ProxyError::Timeout)?
        .map_err(ProxyError::Connect)?;
    let (mut sender, connection) =
        tokio::time::timeout_at(deadline, http1::handshake(TokioIo::new(connected)))
            .await
            .map_err(|_| ProxyError::Timeout)?
            .map_err(ProxyError::Handshake)?;
    // Aborted through the guard on every path that ends the exchange early.
    let upstream = Upstream(tokio::spawn(async move {
        let _ = connection.await;
    }));

    let request = build_request(
        &head,
        &exchange.target.secret,
        &exchange.peer,
        UploadBody::new(req.into_body(), exchange.upload.clone()),
    )?;
    let sending = tokio::time::timeout_at(deadline, sender.send_request(request));
    let client_gone = exchange.upload.client_gone();
    let response = tokio::select! {
        _ = client_gone.cancelled() => {
            // Dropping the upstream guard aborts it: the upload can never end.
            return Err(ProxyError::ClientGone);
        }
        sent = sending => sent
            .map_err(|_| ProxyError::Timeout)?
            .map_err(ProxyError::Request)?,
    };

    let (mut parts, body) = response.into_parts();
    parts.headers = header_map(hop::response_headers(&header_pairs(&parts.headers)));
    let answer = in_flight.track(
        body,
        ProxyError::Body,
        Some(Box::pin(tokio::time::sleep_until(deadline))),
        Some(upstream),
        true,
    );
    Ok(Response::from_parts(parts, answer.boxed_unsync()))
}

fn request_head(exchange: &Exchange, req: &Request<Incoming>) -> RequestHead {
    let first = exchange
        .first_target
        .lock()
        .ok()
        .and_then(|mut target| target.take());
    RequestHead {
        method: req.method().as_str().to_owned(),
        target: first.unwrap_or_else(|| req.uri().to_string()),
        headers: header_pairs(req.headers()),
    }
}

fn build_request(
    head: &RequestHead,
    secret: &HopSecret,
    peer: &Peer,
    body: UploadBody,
) -> Result<Request<UploadBody>, ProxyError> {
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
            .track(body, |never| match never {}, None, None, false)
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
