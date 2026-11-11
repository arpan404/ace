//! `AceTools`: Spade as an MCP client of the daemon's loopback `/mcp` endpoint
//! (docs/ace-integration.md, "Spade uses ace's tools through the daemon").
//!
//! Every request carries `X-Ace-Notifications: stream`. Without it the daemon serves a
//! 2025-11-25 client statelessly, with no session and no list-change stream. Spade sends no
//! `X-Ace-Tools` or `X-Ace-Client`, which gets the full listing with its hints. One session is
//! kept and opened again when it is lost. The daemon keeps at most four per bearer and the
//! bearer is new on every Spade start, so nothing here outlives the process.
//!
//! The tool list is cached for one session. It is fetched again when the daemon says the list
//! changed, and when the session it was fetched on is gone (checked with a `ping`). The SDK
//! never replays a request on a new session: a call is never sent twice. A listing is read-only,
//! so a listing that hits a dead session is retried once on a fresh one.

mod errors;
mod http;
pub mod map;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{
    ClientCapabilities, ClientConfig, ClientRequest, CustomRequest, Implementation,
    PaginatedRequestParams, PingRequest, ProtocolVersion,
};
use rmcp::service::{NotificationContext, PeerRequestOptions, RunningService};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ClientHandler, Peer, RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, watch};

pub use crate::config::ToolsConfig;
pub use errors::ToolsError;
use http::{RawAnswers, RawKeeping};
pub use map::{AceTool, AceToolResult, Part, Risk};

/// A listing longer than this many pages is treated as a server fault, not followed forever.
const MOST_PAGES: usize = 64;
/// Asks the daemon for a session with a list-change stream (`packages/mcp-server/src/http.ts`).
const NOTIFICATIONS_HEADER: &str = "x-ace-notifications";

pub struct AceTools {
    config: ToolsConfig,
    session: Mutex<Option<Live>>,
    /// The listing and the session it was fetched on.
    tools: Mutex<Option<(u64, Vec<AceTool>)>>,
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
    epochs: AtomicU64,
    answers: RawAnswers,
}

struct Live {
    service: RunningService<RoleClient, Listener>,
    epoch: u64,
}

impl AceTools {
    /// Nothing is sent until the first `tools` or `call`.
    pub fn new(config: ToolsConfig) -> Self {
        Self {
            config,
            session: Mutex::new(None),
            tools: Mutex::new(None),
            stale: Arc::new(AtomicBool::new(true)),
            changes: Arc::new(watch::channel(0).0),
            epochs: AtomicU64::new(0),
            answers: RawAnswers::default(),
        }
    }

    /// Counts the daemon's tool list changes. The value changes each time the daemon says its
    /// list changed; the next `tools` call fetches it again.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Every tool the daemon offers this credential, all pages. Served from cache only while
    /// the session it came from is alive and the daemon hasn't announced a change.
    pub async fn tools(&self) -> Result<Vec<AceTool>, ToolsError> {
        let mut cached = self.tools.lock().await;
        let result = match self.list_on_live_session(cached.as_ref()).await {
            Err(ToolsError::Unavailable(_) | ToolsError::NotRun(_)) => {
                self.list_on_live_session(None).await
            }
            other => other,
        };
        let (epoch, tools) = result?;
        *cached = Some((epoch, tools.clone()));
        Ok(tools)
    }

    /// Calls one tool. `arguments` is a JSON object, or null for none. A call is sent at most
    /// once: `NotRun` means it did not run, `OutcomeUnknown` and `Timeout` that it may have.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<AceToolResult, ToolsError> {
        let mut params = json!({ "name": name });
        match arguments {
            Value::Object(object) => params["arguments"] = Value::Object(object),
            Value::Null => {}
            _ => return Err(ToolsError::InvalidArguments),
        }
        let (peer, epoch) = self.peer().await.map_err(not_run_if_unavailable)?;
        // Sent as a plain request so the answer is read from its raw JSON, whatever it holds.
        let request = ClientRequest::CustomRequest(CustomRequest::new("tools/call", Some(params)));
        let options = PeerRequestOptions::with_timeout(self.config.timeout());
        let handle = tokio::time::timeout(
            self.config.timeout(),
            peer.send_request_with_option(request, options),
        )
        .await
        .map_err(|_| ToolsError::Timeout)?;
        let handle = match handle {
            Ok(handle) => handle,
            Err(error) => {
                let error = self.failed(error, epoch).await;
                return Err(not_run_if_unavailable(error));
            }
        };
        let id = handle.id.clone();
        let answer = handle.await_response().await;
        let raw = self.answers.take(&id);
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                return Err(match self.failed(error, epoch).await {
                    ToolsError::Unavailable(why) => ToolsError::OutcomeUnknown(why),
                    other => other,
                });
            }
        };
        let result = match raw.and_then(|mut message| message.get_mut("result").map(Value::take)) {
            Some(result) => result,
            None => serde_json::to_value(answer).map_err(|error| {
                ToolsError::Protocol(self.config.token().scrub(error.to_string()))
            })?,
        };
        Ok(map::call_result(result))
    }

    /// The cached listing when it belongs to the live session, which still answers a ping;
    /// otherwise a fresh listing. Returns the listing with its session's epoch.
    async fn list_on_live_session(
        &self,
        cached: Option<&(u64, Vec<AceTool>)>,
    ) -> Result<(u64, Vec<AceTool>), ToolsError> {
        let (peer, epoch) = self.peer().await?;
        if let Some((cached_epoch, tools)) = cached
            && *cached_epoch == epoch
            && !self.stale.load(Ordering::Acquire)
        {
            let ping = ClientRequest::PingRequest(PingRequest::default());
            let alive = tokio::time::timeout(self.config.timeout(), peer.send_request(ping))
                .await
                .map_err(|_| ToolsError::Timeout)?;
            match alive {
                Ok(_) => return Ok((epoch, tools.clone())),
                Err(error) => return Err(self.failed(error, epoch).await),
            }
        }
        // Cleared before listing, so a change announced while listing leaves the result stale.
        self.stale.store(false, Ordering::Release);
        let listed = self.list_pages(&peer).await;
        match listed {
            Ok(tools) => Ok((epoch, tools)),
            Err(ListError::Service(error)) => {
                self.stale.store(true, Ordering::Release);
                Err(self.failed(error, epoch).await)
            }
            Err(ListError::Other(error)) => {
                self.stale.store(true, Ordering::Release);
                Err(error)
            }
        }
    }

    async fn list_pages(&self, peer: &Peer<RoleClient>) -> Result<Vec<AceTool>, ListError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MOST_PAGES {
            let params = PaginatedRequestParams::default().with_cursor(cursor.clone());
            let page = tokio::time::timeout(self.config.timeout(), peer.list_tools(Some(params)))
                .await
                .map_err(|_| ListError::Other(ToolsError::Timeout))?
                .map_err(ListError::Service)?;
            tools.extend(page.tools.iter().map(map::tool));
            match page.next_cursor {
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                Some(_) => {
                    return Err(ListError::Other(ToolsError::Protocol(
                        "the tool list repeated a page cursor".into(),
                    )));
                }
                None => return Ok(tools),
            }
        }
        Err(ListError::Other(ToolsError::Protocol(format!(
            "the tool list ran past {MOST_PAGES} pages"
        ))))
    }

    /// Classifies an SDK error. A session that is gone or refused is dropped, so the next
    /// request opens a fresh one.
    async fn failed(&self, error: rmcp::ServiceError, epoch: u64) -> ToolsError {
        let error = errors::from_service(error, self.config.token());
        if matches!(
            error,
            ToolsError::Unavailable(_) | ToolsError::NotRun(_) | ToolsError::Refused
        ) {
            let mut session = self.session.lock().await;
            if session.as_ref().is_some_and(|live| live.epoch == epoch) {
                *session = None;
            }
        }
        error
    }

    async fn peer(&self) -> Result<(Peer<RoleClient>, u64), ToolsError> {
        let mut session = self.session.lock().await;
        if let Some(live) = session.as_ref()
            && !live.service.is_closed()
            && !live.service.is_transport_closed()
        {
            return Ok((live.service.peer().clone(), live.epoch));
        }
        *session = None;
        let service = tokio::time::timeout(self.config.timeout(), self.open())
            .await
            .map_err(|_| ToolsError::Timeout)??;
        let epoch = self.epochs.fetch_add(1, Ordering::Relaxed) + 1;
        let peer = service.peer().clone();
        *session = Some(Live { service, epoch });
        Ok((peer, epoch))
    }

    async fn open(&self) -> Result<RunningService<RoleClient, Listener>, ToolsError> {
        let mut headers = HashMap::new();
        headers.insert(
            HeaderName::from_static(NOTIFICATIONS_HEADER),
            HeaderValue::from_static("stream"),
        );
        let transport = StreamableHttpClientTransport::with_client(
            RawKeeping::new(self.answers.clone()),
            StreamableHttpClientTransportConfig::with_uri(self.config.url().as_str())
                .auth_header(self.config.token().expose())
                .custom_headers(headers)
                // A replay could run a tool twice; Spade reopens the session itself.
                .reinit_on_expired_session(false),
        );
        let listener = Listener {
            stale: self.stale.clone(),
            changes: self.changes.clone(),
        };
        listener
            .serve(transport)
            .await
            .map_err(|error| errors::from_init(error, self.config.token()))
    }
}

enum ListError {
    Service(rmcp::ServiceError),
    Other(ToolsError),
}

/// Before a call is sent, failing to reach the daemon means it did not run.
fn not_run_if_unavailable(error: ToolsError) -> ToolsError {
    match error {
        ToolsError::Unavailable(why) => ToolsError::NotRun(why),
        other => other,
    }
}

/// Receives the daemon's notifications for one session.
struct Listener {
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
}

impl ClientHandler for Listener {
    fn get_info(&self) -> ClientConfig {
        // The newest revision with sessions: with `X-Ace-Notifications: stream` the daemon keeps
        // a bounded notification stream for the session, which carries list changes.
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("spade", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE)
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.stale.store(true, Ordering::Release);
        self.changes.send_modify(|count| *count += 1);
    }
}
