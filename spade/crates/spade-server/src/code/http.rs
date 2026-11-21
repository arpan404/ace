//! How a component's `spade:package/http` request is carried (ADR 0203 §2), once Spade decided it
//! may go: by Spade, through the bot's egress proxy with a ticket of the bot's own, so the person's
//! network settings and the egress log hold it as they hold the bot's commands; or, in a
//! scenario (`spade --bot-test`), by the scenario's `http:<host>` fakes, offline.

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::security::Security;

/// One request, as the component asked it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub url: String,
    /// The host [`spade_core::package::code::run::http_host`] read from `url`.
    pub host: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// Its answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

pub type Sent = Pin<Box<dyn Future<Output = Result<Response, String>> + Send>>;

/// Carries a request for bot `bot`.
pub trait Http: Send + Sync {
    fn send(&self, bot: &str, request: Request) -> Sent;
}

/// The longest answer a component reads: the rest is refused.
pub const MOST_BODY: usize = 8 * 1024 * 1024;
/// One request's own bound, like a connector call's.
pub const REQUEST_TIME: Duration = Duration::from_secs(60);

/// Through the bot's egress proxy.
pub struct Proxied {
    pub security: Arc<Security>,
}

impl Http for Proxied {
    fn send(&self, bot: &str, request: Request) -> Sent {
        let ticket = self.security.code_ticket(bot);
        Box::pin(async move {
            let ticket = ticket?;
            let proxy = reqwest::Proxy::all(ticket.url()).map_err(|e| e.to_string())?;
            let client = reqwest::Client::builder()
                .proxy(proxy)
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(REQUEST_TIME)
                .build()
                .map_err(|e| format!("the request couldn't be made: {e}"))?;
            let method =
                reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
                    .map_err(|_| format!("{} isn't an http method", request.method))?;
            let mut built = client.request(method, &request.url).body(request.body);
            for (name, value) in &request.headers {
                built = built.header(name, value);
            }
            let mut answer = built.send().await.map_err(|e| {
                if e.is_timeout() {
                    "the request took longer than 60 s".to_owned()
                } else {
                    format!("the request failed: {e}")
                }
            })?;
            let status = answer.status().as_u16();
            let headers = answer
                .headers()
                .iter()
                .filter_map(|(k, v)| Some((k.to_string(), v.to_str().ok()?.to_owned())))
                .collect();
            let mut body = Vec::new();
            while let Some(chunk) = answer
                .chunk()
                .await
                .map_err(|e| format!("the answer failed: {e}"))?
            {
                if body.len() + chunk.len() > MOST_BODY {
                    return Err("the answer is larger than 8 MiB".to_owned());
                }
                body.extend_from_slice(&chunk);
            }
            drop(ticket);
            Ok(Response {
                status,
                headers,
                body,
            })
        })
    }
}

/// A scenario's `http:<host>` answers, each host's in order, the last one again once they run
/// out; a host with none answers that the scenario gave it none.
#[derive(Default)]
pub struct Fakes {
    answers: Mutex<BTreeMap<String, VecDeque<String>>>,
}

impl Fakes {
    /// From a scenario's fake results by tool name: those named `http:<host>`.
    pub fn new(tools: impl IntoIterator<Item = (String, Vec<String>)>) -> Self {
        let answers = tools
            .into_iter()
            .filter_map(|(name, answers)| {
                let host = name.strip_prefix("http:")?.trim().to_ascii_lowercase();
                Some((host, answers.into_iter().collect()))
            })
            .collect();
        Self {
            answers: Mutex::new(answers),
        }
    }
}

impl Http for Fakes {
    fn send(&self, _bot: &str, request: Request) -> Sent {
        let mut answers = self.answers.lock().unwrap_or_else(|p| p.into_inner());
        let answer = match answers.get_mut(&request.host) {
            Some(queue) if queue.len() > 1 => queue.pop_front(),
            Some(queue) => queue.front().cloned(),
            None => None,
        };
        let host = request.host;
        Box::pin(async move {
            let body = answer.ok_or_else(|| {
                format!("the scenario gives no answer for http:{host}; add one under tools")
            })?;
            Ok(Response {
                status: 200,
                headers: Vec::new(),
                body: body.into_bytes(),
            })
        })
    }
}
