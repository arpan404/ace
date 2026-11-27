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
use crate::discovery::process::{ProcessCommand, ProcessRunner, completed};
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
    let payload = read_opencode_payload(&mut now, aborted, &mut read, pause)?;
    normalize_opencode_v2(&payload, instance, None).map_err(read_failure)
}

/// The raw catalog a cold read settles on, before it is normalised.
#[allow(clippy::result_large_err)]
fn read_opencode_payload(
    now: &mut dyn FnMut() -> u64,
    aborted: &dyn Fn() -> bool,
    read: &mut dyn FnMut() -> Result<Value, DiscoveryFailure>,
    pause: &mut dyn FnMut(u64),
) -> Result<Value, DiscoveryFailure> {
    read_until_models(now, aborted, read, pause).map_err(|stop| match stop {
        ColdReadStop::Read(error) => error,
        ColdReadStop::Aborted => failure(FailureCode::Timeout, "Model discovery timed out."),
    })
}

/// The discovery port over the HTTP client: OpenCode's v2 catalog for one instance.
pub struct HttpOpenCodeDiscovery {
    http: Arc<dyn HttpGet>,
    clock: Arc<dyn Clock>,
    /// The sleep between reads; the daemon's timer, a test's immediate return.
    pause: Arc<dyn Fn(u64) + Send + Sync>,
    /// The CLI fallback: `opencode models` when the HTTP catalog lists nothing.
    process: Option<Arc<dyn ProcessRunner>>,
}

impl HttpOpenCodeDiscovery {
    pub fn new(
        http: Arc<dyn HttpGet>,
        clock: Arc<dyn Clock>,
        pause: Arc<dyn Fn(u64) + Send + Sync>,
    ) -> Self {
        Self {
            http,
            clock,
            pause,
            process: None,
        }
    }

    pub fn with_process(mut self, process: Arc<dyn ProcessRunner>) -> Self {
        self.process = Some(process);
        self
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
        let process = self.process.clone();
        Box::pin(async move {
            let instance = request.instance;
            // A v2 server answers for a Location: its directory rides on the query.
            let url = format!(
                "{}{CATALOG_PATH}?location[directory]={}",
                base_url(&instance),
                percent_encode(&instance.cwd)
            );
            let aborted = {
                let signal = signal.clone();
                move || signal.is_aborted()
            };
            // The CLI's own connection status decides which providers the account may
            // serve. Without a process runner the catalog is taken as it comes.
            let mut connected = Vec::new();
            if let Some(process) = process.clone() {
                diagnostic(crate::catalog::DiscoveryDiagnostics {
                    stage: Some("connections".to_owned()),
                    ..Default::default()
                });
                let command = ProcessCommand::for_instance(
                    &instance,
                    ["auth", "list", "--standalone", "--format", "json"]
                        .map(str::to_owned)
                        .to_vec(),
                );
                let output = process.run(&command, &aborted)?;
                let listing = completed(output)?;
                connected = crate::discovery::opencode_report::parse_connections(&listing)
                    .map_err(|message| failure(FailureCode::DiscoveryFailed, message))?;
                diagnostic(crate::catalog::DiscoveryDiagnostics {
                    sources: Some(connected.iter().map(|(_, source)| source.clone()).collect()),
                    ..Default::default()
                });
            }
            diagnostic(crate::catalog::DiscoveryDiagnostics {
                stage: Some("metadata".to_owned()),
                ..Default::default()
            });
            let mut now = || clock.now().max(0.0) as u64;
            #[allow(clippy::result_large_err)]
            let mut read = || -> Result<Value, DiscoveryFailure> {
                let reply: HttpReply = http.get(
                    &HttpRequest {
                        url: url.clone(),
                        headers: Vec::new(),
                    },
                    &aborted,
                )?;
                if !(200..300).contains(&reply.status) {
                    return Err(status_failure(reply.status));
                }
                serde_json::from_str::<Value>(&reply.body).map_err(|_| DiscoveryFailure {
                    parse_failure: true,
                    ..DiscoveryFailure::default()
                })
            };
            let mut pause_fn = move |millis| pause(millis);
            let payload = read_opencode_payload(&mut now, &aborted, &mut read, &mut pause_fn)?;
            if process.is_none() {
                let models =
                    normalize_opencode_v2(&payload, &instance, None).map_err(read_failure)?;
                if signal.is_aborted() {
                    return Err(failure(FailureCode::Timeout, "Model discovery timed out."));
                }
                return Ok(DiscoveryOutcome {
                    models,
                    sources: None,
                    permission_modes: None,
                });
            }
            let mut report =
                crate::discovery::opencode_report::build_report(&payload, &instance, &connected)
                    .map_err(failure_for)?;
            if let Some(process) = process.clone() {
                // A server that lists no rows still has a CLI that knows them, and a server
                // that lists only ids is supplemented from the same listing.
                diagnostic(crate::catalog::DiscoveryDiagnostics {
                    stage: Some("model-ids".to_owned()),
                    ..Default::default()
                });
                let args = if instance.isolated_service {
                    vec!["models".to_owned(), "--standalone".to_owned()]
                } else {
                    vec!["models".to_owned()]
                };
                let command = ProcessCommand::for_instance(&instance, args);
                let listing = process.run(&command, &aborted).and_then(completed);
                #[allow(clippy::result_large_err)]
                match listing.and_then(|listing| {
                    parse_opencode_listing(&listing, &instance)
                        .map_err(|message| failure(FailureCode::ParseFailure, message))
                }) {
                    Ok(listed) => {
                        crate::discovery::opencode_report::supplement(
                            &mut report,
                            listed,
                            &connected,
                            &instance,
                        )?;
                    }
                    Err(error) => {
                        // The catalog's own answer stands; only its missing ids fall back.
                        let missing = report.missing_metadata.clone();
                        crate::discovery::opencode_report::supplement_failed(
                            &mut report,
                            &error,
                            missing,
                        );
                    }
                }
                diagnostic(crate::catalog::DiscoveryDiagnostics {
                    source_failures: report
                        .source_failures
                        .iter()
                        .map(|(source, reason)| crate::catalog::SourceFailure {
                            source: source.clone(),
                            reason: reason.clone(),
                            stage: Some("model-ids".to_owned()),
                        })
                        .collect(),
                    ..Default::default()
                });
            }
            if signal.is_aborted() {
                return Err(failure(FailureCode::Timeout, "Model discovery timed out."));
            }
            Ok(DiscoveryOutcome {
                models: report.models,
                sources: Some(report.sources),
                permission_modes: None,
            })
        })
    }
}

/// The failure a report builder's error carries onward unchanged.
fn failure_for(error: DiscoveryFailure) -> DiscoveryFailure {
    error
}

/// A query value with only the characters a directory path needs left literal.
fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

/// The CLI's `opencode models` listing: a `provider/model` heading, then its JSON object.
pub fn parse_opencode_listing(
    output: &str,
    instance: &ModelInstance,
) -> Result<Vec<ace_protocol::generated::CatalogModel>, &'static str> {
    let mut rows = Vec::new();
    let mut heading: Option<String> = None;
    let mut json = String::new();
    let mut bytes = 0;
    for line in output.lines() {
        bytes += line.len() + 1;
        if bytes > 4 * 1024 * 1024 {
            return Err("Model metadata output exceeded limit");
        }
        let trimmed = line.trim();
        if heading.is_none() {
            if trimmed.is_empty() {
                continue;
            }
            let valid = !trimmed.contains(char::is_whitespace)
                && trimmed
                    .split_once('/')
                    .is_some_and(|(provider, model)| !provider.is_empty() && !model.is_empty());
            if !valid {
                return Err("Malformed model heading");
            }
            heading = Some(trimmed.to_owned());
            continue;
        }
        if !json.is_empty()
            && !trimmed.is_empty()
            && !trimmed.starts_with(['{', '}', '"', ']', '['])
            && trimmed.contains('/')
        {
            // A heading with no object after it (the id-only listing).
            let current = heading.take().unwrap_or_default();
            push_listing_row(&mut rows, instance, &current, &json)?;
            json.clear();
            heading = Some(trimmed.to_owned());
            continue;
        }
        if json.is_empty() && trimmed.contains('/') && !trimmed.starts_with('{') {
            let current = heading.take().unwrap_or_default();
            push_listing_row(&mut rows, instance, &current, "")?;
            heading = Some(trimmed.to_owned());
            continue;
        }
        json.push_str(line);
        json.push('\n');
        if line != "}"
            && !(json.lines().count() == 1 && trimmed.starts_with('{') && trimmed.ends_with('}'))
        {
            continue;
        }
        let current = heading.take().unwrap_or_default();
        push_listing_row(&mut rows, instance, &current, &json)?;
        json.clear();
        if rows.len() > 512 {
            return Err("Too many models");
        }
    }
    if let Some(current) = heading.take() {
        push_listing_row(&mut rows, instance, &current, &json)?;
    }
    if rows.len() > 512 {
        return Err("Too many models");
    }
    Ok(rows)
}

fn push_listing_row(
    rows: &mut Vec<ace_protocol::generated::CatalogModel>,
    instance: &ModelInstance,
    heading: &str,
    json: &str,
) -> Result<(), &'static str> {
    let (provider, model_id) = heading.split_once('/').ok_or("Malformed model heading")?;
    if json.trim().is_empty() {
        let mut model = ace_models::row::base(instance, heading, model_id, &Value::Null);
        model.native_provider_id = serde_json::from_value(Value::String(provider.to_owned())).ok();
        rows.push(model);
        return Ok(());
    }
    let native: Value = serde_json::from_str(json).map_err(|_| "Malformed model metadata")?;
    let native_provider = native
        .get("providerID")
        .and_then(Value::as_str)
        .unwrap_or(provider);
    let native_id = native.get("id").and_then(Value::as_str).unwrap_or(model_id);
    if format!("{native_provider}/{native_id}") != heading {
        return Err("Model heading mismatch");
    }
    let name = native
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or(model_id);
    let mut model = ace_models::row::base(instance, heading, name, &native);
    model.native_provider_id =
        serde_json::from_value(Value::String(native_provider.to_owned())).ok();
    if let Some(context) = native
        .get("limit")
        .and_then(|limit| limit.get("context"))
        .and_then(Value::as_u64)
    {
        model.context_window = serde_json::from_value(Value::from(context)).ok();
    }
    if let Some(input) = native
        .get("capabilities")
        .and_then(|c| c.get("input"))
        .and_then(Value::as_object)
    {
        let modalities: Vec<Value> = input
            .iter()
            .filter(|(_, enabled)| enabled.as_bool() == Some(true))
            .map(|(id, _)| Value::String(id.clone()))
            .collect();
        model.input_modalities =
            serde_json::from_value(Value::Array(modalities)).unwrap_or_else(|_| Vec::new().into());
    }
    let variants: Vec<ace_models::effort::EffortValue<'_>> = native
        .get("variants")
        .and_then(Value::as_object)
        .map(|variants| {
            variants
                .keys()
                .map(|id| ace_models::effort::EffortValue::id(id))
                .collect()
        })
        .unwrap_or_default();
    model.efforts = ace_models::effort::model_efforts(variants).into();
    let status = native.get("status").and_then(Value::as_str).unwrap_or("");
    model.deprecated = (status == "deprecated" || status == "legacy").into();
    model.legacy = Some(ace_models::metadata::legacy_metadata(&native).into());
    if ace_models::metadata::chat_metadata(&native) {
        rows.push(model);
    }
    Ok(())
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

    struct FakeProcess {
        calls: Mutex<usize>,
    }

    /// The CLI's two discovery commands: its connection status, then its model ids.
    const CONNECTIONS: &str = r#"[{"id":"opencode","connections":[{"type":"oauth"}]},{"id":"ollama","local":true,"connections":[]}]"#;

    impl crate::discovery::process::ProcessRunner for FakeProcess {
        fn run(
            &self,
            command: &crate::discovery::process::ProcessCommand,
            _aborted: &dyn Fn() -> bool,
        ) -> Result<crate::discovery::process::ProcessOutput, DiscoveryFailure> {
            if command.args.first().map(String::as_str) == Some("auth") {
                return Ok(crate::discovery::process::ProcessOutput {
                    status: Some(0),
                    stdout: CONNECTIONS.to_owned(),
                    stderr: String::new(),
                });
            }
            assert_eq!(command.args, ["models"]);
            *self.calls.lock().unwrap_or_else(|error| error.into_inner()) += 1;
            Ok(crate::discovery::process::ProcessOutput {
                    status: Some(0),
                    stdout: "opencode/deepseek-v4.1-flash\n{\n  \"id\": \"deepseek-v4.1-flash\",\n  \"providerID\": \"opencode\",\n  \"name\": \"DeepSeek V4.1 Flash\",\n  \"status\": \"active\",\n  \"variants\": { \"high\": {}, \"low\": {} },\n  \"capabilities\": { \"input\": { \"text\": true } }\n}\nollama/qwen3\n".to_owned(),
                    stderr: String::new(),
                })
        }
    }

    #[test]
    fn an_empty_http_catalog_falls_back_to_the_cli_listing() {
        let replies: Vec<HttpReply> = (0..40)
            .map(|_| HttpReply {
                status: 200,
                body: empty(),
            })
            .collect();
        let http = Arc::new(ScriptedHttp::new(replies));
        let clock = Arc::new(TestClock(Mutex::new(0)));
        let process = Arc::new(FakeProcess {
            calls: Mutex::new(0),
        });
        let discovery = HttpOpenCodeDiscovery::new(http, clock.clone(), Arc::new(|_| {}))
            .with_process(process.clone());
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            *process
                .calls
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            1
        );
        assert_eq!(outcome.models.len(), 2);
        assert_eq!(outcome.models[0].id.0, "opencode/deepseek-v4.1-flash");
        assert_eq!(outcome.models[0].efforts.len(), 2);
        assert!(outcome.models[1].id.0.starts_with("ollama/"));
    }

    #[test]
    fn the_cli_supplements_a_non_empty_catalog_and_reads_an_id_only_listing() {
        let http = Arc::new(ScriptedHttp::new(vec![
            HttpReply {
                status: 200,
                body: empty(),
            },
            HttpReply {
                status: 200,
                body: full(),
            },
        ]));
        let clock = Arc::new(TestClock(Mutex::new(0)));
        let process = Arc::new(FakeProcess {
            calls: Mutex::new(0),
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, clock, Arc::new(|_| {})).with_process(process);
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        // The HTTP model comes first; the CLI's id-only `ollama/qwen3` line is appended.
        assert_eq!(outcome.models.len(), 2);
        assert_eq!(outcome.models[0].id.0, "opencode/deepseek-v4.1-flash");
        assert!(outcome.models[1].id.0.starts_with("ollama/"));
    }

    #[test]
    fn an_isolated_account_runs_the_cli_with_standalone() {
        let replies: Vec<HttpReply> = (0..40)
            .map(|_| HttpReply {
                status: 200,
                body: empty(),
            })
            .collect();
        let http = Arc::new(ScriptedHttp::new(replies));
        let clock = Arc::new(TestClock(Mutex::new(0)));
        struct Recording {
            args: Mutex<Vec<String>>,
        }
        impl crate::discovery::process::ProcessRunner for Recording {
            fn run(
                &self,
                command: &crate::discovery::process::ProcessCommand,
                _aborted: &dyn Fn() -> bool,
            ) -> Result<crate::discovery::process::ProcessOutput, DiscoveryFailure> {
                if command.args.first().map(String::as_str) == Some("auth") {
                    return Ok(crate::discovery::process::ProcessOutput {
                        status: Some(0),
                        stdout: CONNECTIONS.to_owned(),
                        stderr: String::new(),
                    });
                }
                *self.args.lock().unwrap_or_else(|error| error.into_inner()) = command.args.clone();
                Ok(crate::discovery::process::ProcessOutput {
                    status: Some(0),
                    stdout: "ollama/qwen3\n".to_owned(),
                    stderr: String::new(),
                })
            }
        }
        let recording = Arc::new(Recording {
            args: Mutex::new(Vec::new()),
        });
        let mut isolated = instance();
        isolated.isolated_service = true;
        let discovery = HttpOpenCodeDiscovery::new(http, clock, Arc::new(|_| {}))
            .with_process(recording.clone());
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest { instance: isolated },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            *recording
                .args
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
            ["models", "--standalone"]
        );
        assert_eq!(outcome.models.len(), 1);
    }

    /// A provider entry with metadata, as a v2 server writes it.
    fn catalog_entry(provider: &str, model: &str, enabled: bool) -> Value {
        json!({
            "id": format!("{provider}/{model}"),
            "modelID": model,
            "providerID": provider,
            "name": model,
            "enabled": enabled,
            "status": "active",
            "limit": { "context": 200_000, "output": 32_000 },
            "capabilities": { "input": ["text"] },
            "variants": [],
            "cost": [{ "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } }]
        })
    }

    fn catalog_with(entries: Vec<Value>) -> String {
        json!({ "location": { "directory": "/one" }, "data": entries }).to_string()
    }

    /// A process runner that answers `auth list` with `connections` and `models` with `listing`.
    struct ScriptedProcess {
        connections: &'static str,
        listing: Vec<crate::discovery::process::ProcessOutput>,
    }

    impl crate::discovery::process::ProcessRunner for ScriptedProcess {
        fn run(
            &self,
            command: &crate::discovery::process::ProcessCommand,
            _aborted: &dyn Fn() -> bool,
        ) -> Result<crate::discovery::process::ProcessOutput, DiscoveryFailure> {
            if command.args.first().map(String::as_str) == Some("auth") {
                return Ok(crate::discovery::process::ProcessOutput {
                    status: Some(0),
                    stdout: self.connections.to_owned(),
                    stderr: String::new(),
                });
            }
            let mut outputs = self.listing.iter();
            Ok(outputs
                .next()
                .cloned()
                .unwrap_or(crate::discovery::process::ProcessOutput {
                    status: Some(0),
                    stdout: String::new(),
                    stderr: String::new(),
                }))
        }
    }

    /// One HTTP answer chain: the catalog, then empties if it is read again.
    fn catalog_http(entries: Vec<Value>) -> Arc<ScriptedHttp> {
        let mut replies = vec![HttpReply {
            status: 200,
            body: catalog_with(entries),
        }];
        replies.push(HttpReply {
            status: 200,
            body: catalog_with(vec![]),
        });
        Arc::new(ScriptedHttp::new(replies))
    }

    #[test]
    fn an_unconnected_paid_upstream_never_reaches_the_picker() {
        let http = catalog_http(vec![
            catalog_entry("opencode", "deepseek-v4.1-flash", true),
            // Paid, and this account never connected it.
            catalog_entry("anthropic", "claude-opus-5", true),
            // Local endpoints need no connection.
            catalog_entry("ollama", "qwen3", true),
        ]);
        let process = Arc::new(ScriptedProcess {
            connections: r#"[{"id":"opencode","connections":[{"type":"oauth"}]}]"#,
            listing: Vec::new(),
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, Arc::new(TestClock(Mutex::new(0))), Arc::new(|_| {}))
                .with_process(process);
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        let ids: Vec<&str> = outcome.models.iter().map(|row| row.id.0.as_str()).collect();
        assert_eq!(ids, ["opencode/deepseek-v4.1-flash", "ollama/qwen3"]);
        assert!(
            outcome
                .sources
                .as_ref()
                .is_some_and(|sources| sources.iter().all(|s| s.source.id.0 != "anthropic")),
            "the unconnected provider has no source"
        );
    }

    #[test]
    fn a_free_choice_joins_even_with_no_connection() {
        let http = catalog_http(vec![
            catalog_entry("opencode", "hy4-flash-free", true),
            catalog_entry("openai", "gpt-6", true),
        ]);
        let process = Arc::new(ScriptedProcess {
            connections: "[]",
            listing: Vec::new(),
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, Arc::new(TestClock(Mutex::new(0))), Arc::new(|_| {}))
                .with_process(process);
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            outcome
                .models
                .iter()
                .map(|row| row.id.0.as_str())
                .collect::<Vec<_>>(),
            ["opencode/hy4-flash-free"]
        );
        assert!(outcome.models[0].free.is_some(), "a free choice is marked");
    }

    #[test]
    fn a_process_backed_reply_for_another_directory_is_refused() {
        let mut replies = vec![HttpReply {
            status: 200,
            body: json!({
                "location": { "directory": "/elsewhere" },
                "data": [catalog_entry("opencode", "deepseek-v4.1-flash", true)],
            })
            .to_string(),
        }];
        replies.push(HttpReply {
            status: 200,
            body: catalog_with(vec![]),
        });
        let http = Arc::new(ScriptedHttp::new(replies));
        let process = Arc::new(ScriptedProcess {
            connections: r#"[{"id":"opencode","connections":[{"type":"oauth"}]}]"#,
            listing: Vec::new(),
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, Arc::new(TestClock(Mutex::new(0))), Arc::new(|_| {}))
                .with_process(process);
        let failure = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .err()
        .unwrap_or_else(|| panic!("a reply for another directory is refused"));
        assert_eq!(
            failure.message.as_deref(),
            Some("OpenCode answered for another directory")
        );
    }

    #[test]
    fn an_http_row_without_metadata_is_free_only_when_every_tier_is_zero() {
        let mut priced = catalog_entry("opencode", "hy4-flash-free", true);
        priced["cost"] =
            json!([{ "input": 0.4, "output": 1.2, "cache": { "read": 0, "write": 0 } }]);
        let zero = catalog_entry("opencode", "partner-model", true);
        let http = catalog_http(vec![priced, zero]);
        let process = Arc::new(ScriptedProcess {
            connections: "[]",
            listing: Vec::new(),
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, Arc::new(TestClock(Mutex::new(0))), Arc::new(|_| {}))
                .with_process(process);
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            outcome
                .models
                .iter()
                .map(|row| row.id.0.as_str())
                .collect::<Vec<_>>(),
            ["opencode/partner-model"],
            "the catalog's own pricing decides, never the id"
        );
        assert!(
            outcome.models[0].free.is_some(),
            "the zero-priced row is free"
        );
    }

    #[test]
    fn a_cli_listed_free_choice_needs_no_metadata() {
        let replies: Vec<HttpReply> = (0..40)
            .map(|_| HttpReply {
                status: 200,
                body: catalog_with(vec![]),
            })
            .collect();
        let http = Arc::new(ScriptedHttp::new(replies));
        let process = Arc::new(ScriptedProcess {
            connections: "[]",
            listing: vec![crate::discovery::process::ProcessOutput {
                status: Some(0),
                stdout: "opencode/big-pickle\nopencode/paid-model\n".to_owned(),
                stderr: String::new(),
            }],
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, Arc::new(TestClock(Mutex::new(0))), Arc::new(|_| {}))
                .with_process(process);
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            outcome
                .models
                .iter()
                .map(|row| row.id.0.as_str())
                .collect::<Vec<_>>(),
            ["opencode/big-pickle"],
            "the CLI's id names a free choice; a paid one needs a connection"
        );
        assert!(outcome.models[0].free.is_some(), "the listed row is free");
    }

    #[test]
    fn a_failed_cli_supplement_keeps_the_healthy_catalog_and_marks_sources_stale() {
        let http = catalog_http(vec![
            catalog_entry("opencode", "deepseek-v4.1-flash", true),
            // Listed, but no enabled chat model: the CLI was to fill its ids in.
            catalog_entry("ollama", "qwen3", false),
        ]);
        let process = Arc::new(ScriptedProcess {
            connections: r#"[{"id":"opencode","connections":[{"type":"oauth"}]},{"id":"ollama","local":true,"connections":[]}]"#,
            listing: vec![crate::discovery::process::ProcessOutput {
                status: Some(1),
                stdout: String::new(),
                stderr: "listing failed".to_owned(),
            }],
        });
        let discovery =
            HttpOpenCodeDiscovery::new(http, Arc::new(TestClock(Mutex::new(0))), Arc::new(|_| {}))
                .with_process(process);
        let outcome = futures::executor::block_on(discovery.discover(
            DiscoveryRequest {
                instance: instance(),
            },
            Signal::new(),
            Arc::new(|_metadata: DiscoveryDiagnostics| {}),
        ))
        .unwrap_or_else(|error| panic!("{error:?}"));
        assert_eq!(
            outcome
                .models
                .iter()
                .map(|row| row.id.0.as_str())
                .collect::<Vec<_>>(),
            ["opencode/deepseek-v4.1-flash"],
            "the catalog's healthy rows survive the listing failure"
        );
        let sources = outcome.sources.unwrap_or_default();
        let ollama = sources
            .iter()
            .find(|status| status.source.id.0 == "ollama")
            .unwrap_or_else(|| panic!("the unfilled source is reported"));
        assert_eq!(ollama.status, crate::sources::SourceState::Stale);
        assert!(ollama.error.is_some(), "the source names its failure");
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
        assert!(
            requests[0]
                .url
                .starts_with("http://127.0.0.1:4096/api/model?location[directory]=")
        );
    }
}
