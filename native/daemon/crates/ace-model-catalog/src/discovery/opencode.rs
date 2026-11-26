// SPDX-License-Identifier: Apache-2.0
//! OpenCode's location-scoped v2 catalog over the HTTP port.
//!
//! On OpenCode 2.4.2 a cold Location answers the first `GET /api/model` with an empty
//! list and fills it 1–3 s later, so the read repeats every 50 ms, at most 40 times or
//! 5 s on the injected clock (`open-code.ts`, `CATALOG_POLL_MS`/`CATALOG_READS`/
//! `CATALOG_BUDGET_MS`). Efforts come from `variants[].id` in the server's order; the
//! row normalization itself lives in `ace-models`.

use std::sync::Arc;

use ace_models::instance::ModelInstance;
use ace_models::opencode::{
    CATALOG_BUDGET_MS, CATALOG_READS, ColdReadStop, OpenCodeError, normalize_opencode_v2,
    read_until_models,
};
use serde_json::Value;

use crate::catalog::{
    CatalogDiscover, Clock, DiagnosticSink, DiscoverResult, DiscoveryOutcome, DiscoveryRequest,
};
use crate::discovery::http::{HttpGet, HttpReply, HttpRequest};
use crate::failures::{DiscoveryFailure, FailureCode};
use crate::signals::Signal;

/// The path a v2 server answers its catalog on.
pub const CATALOG_PATH: &str = "/api/model";

/// A failure a non-2xx status stands for, keeping only the status as data.
pub fn status_failure(status: u16) -> DiscoveryFailure {
    DiscoveryFailure {
        status: Some(f64::from(status)),
        ..DiscoveryFailure::default()
    }
}

fn failure(code: FailureCode, message: &str) -> DiscoveryFailure {
    DiscoveryFailure {
        code: Some(code.as_str().to_owned()),
        message: Some(message.to_owned()),
        ..DiscoveryFailure::default()
    }
}

fn read_failure(error: OpenCodeError) -> DiscoveryFailure {
    match error {
        OpenCodeError::LocationMismatch => failure(
            FailureCode::DiscoveryFailed,
            "OpenCode answered for another directory",
        ),
        OpenCodeError::MalformedCatalog => failure(
            FailureCode::ParseFailure,
            "OpenCode model catalog is malformed",
        ),
        OpenCodeError::TooManyConnectedModels => {
            failure(FailureCode::ParseFailure, "Too many connected models")
        }
        OpenCodeError::Row(error) => failure(FailureCode::ParseFailure, error.0),
    }
}

/// Waits out the cold catalog through the injected clock and pause.
///
/// `pause` is the caller's sleep: it may return at once, and `aborted` is checked after
/// it, as the TypeScript's `signal.throwIfAborted()` is.
#[allow(clippy::result_large_err)]
pub fn read_opencode_catalog(
    http: &dyn HttpGet,
    url: &str,
    instance: &ModelInstance,
    clock: &dyn Clock,
    pause: &mut dyn FnMut(u64),
    aborted: &dyn Fn() -> bool,
) -> Result<Vec<ace_protocol::generated::CatalogModel>, DiscoveryFailure> {
    let mut now = || clock.now().max(0.0) as u64;
    #[allow(clippy::result_large_err)]
    let mut read = || -> Result<Value, DiscoveryFailure> {
        let reply: HttpReply = http.get(
            &HttpRequest {
                url: url.to_owned(),
                headers: Vec::new(),
            },
            aborted,
        )?;
        if !(200..300).contains(&reply.status) {
            return Err(status_failure(reply.status));
        }
        serde_json::from_str::<Value>(&reply.body).map_err(|_| DiscoveryFailure {
            parse_failure: true,
            ..DiscoveryFailure::default()
        })
    };
    let payload =
        read_until_models(&mut now, aborted, &mut read, pause).map_err(|stop| match stop {
            ColdReadStop::Read(error) => error,
            ColdReadStop::Aborted => failure(FailureCode::Timeout, "Model discovery timed out."),
        })?;
    normalize_opencode_v2(&payload, instance, None).map_err(read_failure)
}

/// The discovery port over the HTTP client: OpenCode's v2 catalog for one instance.
pub struct HttpOpenCodeDiscovery {
    http: Arc<dyn HttpGet>,
    clock: Arc<dyn Clock>,
    /// The sleep between reads; the daemon's timer, a test's immediate return.
    pause: Arc<dyn Fn(u64) + Send + Sync>,
}

impl HttpOpenCodeDiscovery {
    pub fn new(
        http: Arc<dyn HttpGet>,
        clock: Arc<dyn Clock>,
        pause: Arc<dyn Fn(u64) + Send + Sync>,
    ) -> Self {
        Self { http, clock, pause }
    }
}

impl CatalogDiscover for HttpOpenCodeDiscovery {
    fn discover(
        &self,
        request: DiscoveryRequest,
        signal: Signal,
        diagnostic: DiagnosticSink,
    ) -> futures::future::LocalBoxFuture<'static, DiscoverResult> {
        let http = self.http.clone();
        let clock = self.clock.clone();
        let pause = self.pause.clone();
        Box::pin(async move {
            diagnostic(crate::catalog::DiscoveryDiagnostics {
                stage: Some("metadata".to_owned()),
                ..Default::default()
            });
            let instance = request.instance;
            let url = format!("{}{CATALOG_PATH}", base_url(&instance));
            let aborted = {
                let signal = signal.clone();
                move || signal.is_aborted()
            };
            let mut pause_fn = move |millis| pause(millis);
            let models =
                read_opencode_catalog(&*http, &url, &instance, &*clock, &mut pause_fn, &aborted)?;
            if signal.is_aborted() {
                return Err(failure(FailureCode::Timeout, "Model discovery timed out."));
            }
            Ok(DiscoveryOutcome {
                models,
                sources: None,
                permission_modes: None,
            })
        })
    }
}

/// The server an instance talks to: its configured base URL, else OpenCode's default.
fn base_url(instance: &ModelInstance) -> String {
    instance
        .env
        .iter()
        .find(|(name, _)| name == "OPENCODE_SERVER_URL")
        .map(|(_, value)| value.trim_end_matches('/').to_owned())
        .unwrap_or_else(|| "http://127.0.0.1:4096".to_owned())
}

/// The read limits as data, so a caller can state them without the parser.
pub const READ_LIMITS: (u64, usize, u64) = (
    ace_models::opencode::CATALOG_POLL_MS,
    CATALOG_READS,
    CATALOG_BUDGET_MS,
);

#[cfg(test)]
mod tests {
    //! Ports `packages/adapter-opencode/src/catalog-cold.process.test.ts` ("discovery
    //! reads a cold 2.4.2 catalog again until its variants arrive") and the OpenCode
    //! cases of `catalog-source.process.test.ts` that a reply alone decides: the cold
    //! re-read's every-50-ms / 40-read / 5-second bounds, efforts in `variants[].id`
    //! order, and a non-2xx status or a malformed body classified safely.

    use std::collections::VecDeque;
    use std::sync::Mutex;

    use ace_protocol::generated::ProviderKind;
    use serde_json::json;

    use super::*;
    use crate::catalog::DiscoveryDiagnostics;
    use crate::failures::{ErrorContext, discovery_error, discovery_failure_code};

    struct TestClock(Mutex<u64>);

    impl Clock for TestClock {
        fn now(&self) -> f64 {
            *self.0.lock().unwrap_or_else(|error| error.into_inner()) as f64
        }
    }

    struct ScriptedHttp {
        replies: Mutex<VecDeque<HttpReply>>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl ScriptedHttp {
        fn new(replies: Vec<HttpReply>) -> Self {
            Self {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn requests(&self) -> usize {
            self.requests
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .len()
        }
    }

    impl HttpGet for ScriptedHttp {
        fn get(
            &self,
            request: &HttpRequest,
            _aborted: &dyn Fn() -> bool,
        ) -> Result<HttpReply, DiscoveryFailure> {
            self.requests
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(request.clone());
            self.replies
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .pop_front()
                .ok_or_else(|| DiscoveryFailure::new("no scripted reply"))
        }
    }

    fn empty() -> String {
        json!({ "location": { "directory": "/one" }, "data": [] }).to_string()
    }

    fn full() -> String {
        json!({
            "location": { "directory": "/one" },
            "data": [{
                "id": "opencode/deepseek-v4.1-flash",
                "modelID": "deepseek-v4.1-flash",
                "providerID": "opencode",
                "name": "DeepSeek V4.1 Flash",
                "enabled": true,
                "status": "active",
                "limit": { "context": 1_000_000, "output": 32_000 },
                "capabilities": { "input": ["text"] },
                "variants": [
                    { "id": "high", "name": "High" },
                    { "id": "low", "name": "Low" },
                    { "id": "max", "name": "Max" }
                ]
            }]
        })
        .to_string()
    }

    fn instance() -> ModelInstance {
        ModelInstance::cli("opencode", ProviderKind::Opencode, "", "/one")
    }

    #[allow(clippy::result_large_err)]
    fn read(
        http: &ScriptedHttp,
        clock: &TestClock,
        pause: &mut dyn FnMut(u64),
    ) -> Result<Vec<ace_protocol::generated::CatalogModel>, DiscoveryFailure> {
        read_opencode_catalog(
            http,
            "http://127.0.0.1:4096/api/model",
            &instance(),
            clock,
            pause,
            &|| false,
        )
    }

    #[test]
    fn a_cold_catalog_is_read_again_until_its_variants_arrive() {
        let http = ScriptedHttp::new(vec![
            HttpReply {
                status: 200,
                body: empty(),
            },
            HttpReply {
                status: 200,
                body: empty(),
            },
            HttpReply {
                status: 200,
                body: full(),
            },
        ]);
        let clock = TestClock(Mutex::new(1_000));
        let mut pauses = 0;
        let models = read(&http, &clock, &mut |millis| {
            assert_eq!(millis, 50);
            pauses += 1;
        })
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(http.requests(), 3);
        assert_eq!(pauses, 2);
        assert_eq!(models.len(), 1);
        let efforts: Vec<&str> = models[0]
            .efforts
            .iter()
            .map(|effort| effort.id.0.as_str())
            .collect();
        assert_eq!(efforts, ["high", "low", "max"], "the server's own order");
    }

    #[test]
    fn a_catalog_that_stays_cold_is_read_at_most_forty_times() {
        let replies: Vec<HttpReply> = (0..40)
            .map(|_| HttpReply {
                status: 200,
                body: empty(),
            })
            .collect();
        let http = ScriptedHttp::new(replies);
        let clock = TestClock(Mutex::new(0));
        let models = read(&http, &clock, &mut |millis| {
            *clock.0.lock().unwrap_or_else(|error| error.into_inner()) += millis;
        })
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert!(models.is_empty());
        assert_eq!(http.requests(), 40);
    }

    #[test]
    fn a_slow_clock_ends_the_cold_read_at_five_seconds() {
        let replies: Vec<HttpReply> = (0..40)
            .map(|_| HttpReply {
                status: 200,
                body: empty(),
            })
            .collect();
        let http = ScriptedHttp::new(replies);
        let clock = TestClock(Mutex::new(0));
        let models = read(&http, &clock, &mut |_| {
            *clock.0.lock().unwrap_or_else(|error| error.into_inner()) += 500;
        })
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert!(models.is_empty());
        // One read at 0 ms, then 500 ms apart until the 5 s budget.
        assert!(http.requests() <= 12, "{} reads", http.requests());
        assert!(http.requests() >= 10);
    }

    #[test]
    fn a_non_two_hundred_status_or_a_malformed_body_is_a_fixed_failure() {
        for (reply, expected) in [
            (
                HttpReply {
                    status: 401,
                    body: String::new(),
                },
                FailureCode::AuthExpired,
            ),
            (
                HttpReply {
                    status: 403,
                    body: String::new(),
                },
                FailureCode::AuthExpired,
            ),
            (
                HttpReply {
                    status: 429,
                    body: String::new(),
                },
                FailureCode::RateLimited,
            ),
            (
                HttpReply {
                    status: 503,
                    body: String::new(),
                },
                FailureCode::Unreachable,
            ),
            (
                HttpReply {
                    status: 200,
                    body: "not json".to_owned(),
                },
                FailureCode::ParseFailure,
            ),
        ] {
            let http = ScriptedHttp::new(vec![reply]);
            let clock = TestClock(Mutex::new(0));
            let failure = read(&http, &clock, &mut |_| {})
                .err()
                .unwrap_or_else(|| panic!("{expected} expected"));
            assert_eq!(
                discovery_failure_code(Some(&failure), FailureCode::DiscoveryFailed),
                expected
            );
            let detail = discovery_error(
                Some(&failure),
                FailureCode::DiscoveryFailed,
                &ErrorContext {
                    provider: Some("opencode"),
                    source: None,
                    backend: None,
                },
            );
            assert!(!detail.hint.is_empty());
        }
    }

    #[test]
    fn an_aborted_read_is_a_timeout_never_a_catalog() {
        let http = ScriptedHttp::new(vec![HttpReply {
            status: 200,
            body: empty(),
        }]);
        let clock = TestClock(Mutex::new(0));
        let failure = read_opencode_catalog(
            &http,
            "http://127.0.0.1:4096/api/model",
            &instance(),
            &clock,
            &mut |_| {},
            &|| true,
        )
        .err()
        .unwrap_or_else(|| panic!("abort expected"));
        assert_eq!(
            discovery_failure_code(Some(&failure), FailureCode::DiscoveryFailed),
            FailureCode::Timeout
        );
    }

    #[test]
    fn the_http_discovery_reports_a_cold_catalog_through_the_ports() {
        let http = std::sync::Arc::new(ScriptedHttp::new(vec![
            HttpReply {
                status: 200,
                body: empty(),
            },
            HttpReply {
                status: 200,
                body: full(),
            },
        ]));
        let clock = std::sync::Arc::new(TestClock(Mutex::new(0)));
        let discovery =
            HttpOpenCodeDiscovery::new(http.clone(), clock, std::sync::Arc::new(|_| {}));
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            std::sync::Arc::new(|metadata: DiscoveryDiagnostics| {
                let _ = metadata;
            }),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(outcome.models.len(), 1);
        let requests = http
            .requests
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert_eq!(requests[0].url, "http://127.0.0.1:4096/api/model");
    }
}
