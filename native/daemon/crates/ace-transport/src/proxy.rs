// SPDX-License-Identifier: Apache-2.0
//! The proxy hop: every ordinary HTTP request the listener accepts goes to the
//! daemon's own HTTP server on a fresh connection to 127.0.0.1, with the hop's
//! fields added and both bodies streamed. An upgrade candidate that arrives on
//! a keep-alive connection takes the same decision path through hyper
//! (`UpgradeHandler::upgrade_hyper`); one that arrives first on a connection
//! never reaches this service (see `driver`).

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
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
use tokio_util::sync::CancellationToken;

use crate::driver::{UpgradeHandler, UpgradeIo, UpgradeReply};
use crate::error::TransportError;
use crate::head::{self, RequestHead};
use crate::hop::{self, HopSecret};
use crate::peer::Peer;

/// How long a request may take from the service call to the internal server's
/// response head. Node's `requestTimeout` bounds receiving the whole request
/// with the same 300 s; nothing here answers a status for it, so the connection
/// is reset (T1a.2 answers 400 and 431 only).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

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
        if !addr.ip().is_loopback() {
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
    Connect(#[source] std::io::Error),
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
    /// The request did not finish in time; no status is answered for it.
    #[error("request did not finish in time")]
    Timeout,
    /// The upgrade handler closed the connection with no answer.
    #[error("the upgrade handler closed the connection")]
    Dropped,
}

/// The body both answers and forwarded responses carry.
type HopBody = UnsyncBoxBody<Bytes, ProxyError>;

/// One request's progress: how many are in flight and how many responses have
/// finished, so the driver knows when a keep-alive connection is idle.
#[derive(Debug)]
pub struct RequestActivity {
    in_flight: AtomicUsize,
    completed: AtomicUsize,
    notify: Notify,
}

impl Default for RequestActivity {
    fn default() -> Self {
        Self {
            in_flight: AtomicUsize::new(0),
            completed: AtomicUsize::new(0),
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
        self.notify.notify_waiters();
    }

    /// Whether any response has finished on this connection yet. A fresh
    /// connection's header read is the header timeout's business, not the
    /// keep-alive one's.
    pub fn completed_any(&self) -> bool {
        self.completed.load(Ordering::SeqCst) > 0
    }

    /// Resolve once no request has been in flight for `idle`, which is Node's
    /// `keepAliveTimeout` for a connection waiting on its next request.
    pub async fn wait_idle(&self, idle: Duration) {
        loop {
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
            if self.in_flight.load(Ordering::SeqCst) == 0 {
                return;
            }
        }
    }
}

/// A request counted as in flight until its response body is finished with.
struct InFlight {
    activity: Arc<RequestActivity>,
    armed: bool,
}

impl InFlight {
    fn into_body<B>(mut self, body: B) -> ActivityBody<B> {
        self.armed = false;
        ActivityBody {
            inner: body,
            activity: Arc::clone(&self.activity),
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

/// A response body that reports its request finished when hyper is done with
/// it, whether it streamed to the end or the client went away.
pub struct ActivityBody<B> {
    inner: B,
    activity: Arc<RequestActivity>,
}

impl<B: Body + Unpin> Body for ActivityBody<B> {
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        Pin::new(&mut self.get_mut().inner).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl<B> Drop for ActivityBody<B> {
    fn drop(&mut self) {
        self.activity.finish(true);
    }
}

/// The service hyper's server runs for ordinary requests and for upgrade
/// candidates on a keep-alive connection.
pub struct ProxyService {
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    peer: Peer,
    shutdown: CancellationToken,
    activity: Arc<RequestActivity>,
}

impl ProxyService {
    pub fn new(
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
        peer: Peer,
        shutdown: CancellationToken,
        activity: Arc<RequestActivity>,
    ) -> Self {
        Self {
            target,
            upgrades,
            peer,
            shutdown,
            activity,
        }
    }
}

impl Service<Request<Incoming>> for ProxyService {
    type Response = Response<HopBody>;
    type Error = ProxyError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, req: Request<Incoming>) -> Self::Future {
        let target = self.target.clone();
        let upgrades = Arc::clone(&self.upgrades);
        let peer = self.peer;
        let shutdown = self.shutdown.clone();
        let activity = Arc::clone(&self.activity);
        Box::pin(async move { handle(target, upgrades, peer, shutdown, activity, req).await })
    }
}

async fn handle(
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    peer: Peer,
    shutdown: CancellationToken,
    activity: Arc<RequestActivity>,
    req: Request<Incoming>,
) -> Result<Response<HopBody>, ProxyError> {
    let head = request_head(&req);
    if head::is_upgrade_candidate(&head) {
        return upgrade(upgrades, peer, shutdown, req, head).await;
    }
    forward(&target, activity, peer, head, req).await
}

async fn upgrade(
    upgrades: Arc<dyn UpgradeHandler>,
    peer: Peer,
    shutdown: CancellationToken,
    req: Request<Incoming>,
    head: RequestHead,
) -> Result<Response<HopBody>, ProxyError> {
    match upgrades.upgrade_hyper(head, peer, shutdown).await {
        // hyper ends the connection with no response when the service fails.
        UpgradeReply::Drop => Err(ProxyError::Dropped),
        UpgradeReply::Refuse(refusal) => Ok(answered(refusal)),
        UpgradeReply::Switch(answer, reservation) => {
            // The `101` is written by hyper after this returns; only then can
            // the upgrade resolve. Nothing bounds it but the stream's write
            // timeout.
            let switching = hyper::upgrade::on(req);
            tokio::spawn(async move {
                let stream: Option<Box<dyn UpgradeIo>> = match switching.await {
                    Ok(upgraded) => Some(Box::new(TokioIo::new(upgraded))),
                    Err(_) => None,
                };
                upgrades.switched(reservation, stream);
            });
            Ok(answered(answer))
        }
    }
}

async fn forward(
    target: &ProxyTarget,
    activity: Arc<RequestActivity>,
    peer: Peer,
    head: RequestHead,
    req: Request<Incoming>,
) -> Result<Response<HopBody>, ProxyError> {
    let in_flight = activity.start();

    let upstream = TcpStream::connect(target.addr)
        .await
        .map_err(ProxyError::Connect)?;
    let (mut sender, connection) = http1::handshake(TokioIo::new(upstream))
        .await
        .map_err(ProxyError::Handshake)?;
    // The connection outlives this call so the response can stream; a client
    // that goes away drops the body, which closes the upstream connection.
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let request = build_request(&head, &target.secret, &peer, req.into_body())?;
    let response = tokio::time::timeout(REQUEST_TIMEOUT, sender.send_request(request))
        .await
        .map_err(|_| ProxyError::Timeout)?
        .map_err(ProxyError::Request)?;

    let (mut parts, body) = response.into_parts();
    parts.headers = header_map(hop::response_headers(&header_pairs(&parts.headers)));
    Ok(Response::from_parts(
        parts,
        in_flight
            .into_body(body)
            .map_err(ProxyError::Body)
            .boxed_unsync(),
    ))
}

fn request_head(req: &Request<Incoming>) -> RequestHead {
    RequestHead {
        method: req.method().as_str().to_owned(),
        target: req.uri().to_string(),
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

fn answered(answer: Response<Full<Bytes>>) -> Response<HopBody> {
    answer.map(|body| body.map_err(|never| match never {}).boxed_unsync())
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
