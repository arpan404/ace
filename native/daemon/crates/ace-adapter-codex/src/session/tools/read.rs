// SPDX-License-Identifier: Apache-2.0
//! `readCodexToolFacts`: two requests, a catalog pager and a 2.5-second
//! deadline, as a sans-IO machine.

use ace_json::{Map, Value};

use super::super::frames::{Calls, Effect};
use super::cache::{Cached, Catalog, CodexCatalogCache};
use super::{CatalogSource, CodexToolFacts, codex_needs_catalog};

/// How long a thread start waits for these facts (`toolFactsDeadlineMs`).
pub const TOOL_FACTS_DEADLINE_MS: f64 = 2_500.0;
/// Enough for any catalog Codex ships or fetches (`maxPages`).
const MAX_PAGES: u64 = 10;
/// One request's default deadline (`request` in `session.ts`).
const REQUEST_MS: f64 = 30_000.0;

/// One `model/list` pager (`readCatalog`): at most ten pages of slugs.
#[derive(Debug)]
struct Pager {
    /// The call the pager waits for.
    call: u64,
    pages: u64,
    slugs: Catalog,
    done: Option<Option<Catalog>>,
    /// The cache key this load owns; `None` when another read owns the key.
    key: Option<String>,
}

impl Pager {
    /// `readCatalog`'s first page: `{ includeHidden: true, limit: 100, cursor }`.
    fn start(calls: &mut Calls, key: Option<String>) -> (Pager, Vec<Effect>) {
        let call = calls.take();
        let pager = Pager {
            call,
            pages: 0,
            slugs: Vec::new(),
            done: None,
            key,
        };
        let effect = Effect::Request {
            call,
            method: "model/list".to_owned(),
            params: pager.params(None),
            timeout_ms: Some(REQUEST_MS),
        };
        (pager, vec![effect])
    }

    fn params(&self, cursor: Option<&str>) -> Value {
        let mut params = Map::new();
        params.insert("includeHidden", Value::Bool(true));
        params.insert("limit", Value::from(100));
        params.insert("cursor", cursor.map(Value::from).unwrap_or(Value::Null));
        Value::Object(params)
    }

    /// One page (`ModelPage.parse`): every entry's `model` then `id`, then the
    /// next cursor, bounded by ten pages. Anything that does not parse ends
    /// the read as unknown.
    fn page(&mut self, calls: &mut Calls, result: Option<&Value>) -> Vec<Effect> {
        self.pages += 1;
        let Some(body) = result.and_then(Value::as_object) else {
            self.done = Some(None);
            return Vec::new();
        };
        let Some(data) = body.get("data").and_then(Value::as_array) else {
            self.done = Some(None);
            return Vec::new();
        };
        let mut page: Vec<String> = Vec::with_capacity(data.len() * 2);
        for entry in data {
            let Some(entry) = entry.as_object() else {
                self.done = Some(None);
                return Vec::new();
            };
            let (Some(model), Some(id)) = (
                entry.get("model").and_then(Value::as_str),
                entry.get("id").and_then(Value::as_str),
            ) else {
                self.done = Some(None);
                return Vec::new();
            };
            if model.len() > 512 || id.len() > 512 {
                self.done = Some(None);
                return Vec::new();
            }
            page.push(model.to_owned());
            page.push(id.to_owned());
        }
        let cursor = match body.get("nextCursor") {
            Some(Value::String(cursor)) if !cursor.as_str().is_empty() => {
                Some(cursor.as_str().to_owned())
            }
            _ => None,
        };
        self.slugs.extend(page);
        match cursor {
            None => {
                self.done = Some(Some(std::mem::take(&mut self.slugs)));
                Vec::new()
            }
            Some(cursor) if cursor.len() > 4096 || self.pages >= MAX_PAGES => {
                self.done = Some(None);
                Vec::new()
            }
            Some(cursor) => {
                self.call = calls.take();
                vec![Effect::Request {
                    call: self.call,
                    method: "model/list".to_owned(),
                    params: self.params(Some(&cursor)),
                    timeout_ms: Some(REQUEST_MS),
                }]
            }
        }
    }
}

/// Codex's config as these facts read it (`ConfigRead`'s relevant members).
#[derive(Debug, Clone, Default, PartialEq)]
struct Config {
    model: Option<String>,
    provider: Option<String>,
    model_catalog_json: Option<String>,
    providers: Vec<(String, Option<String>)>,
    features: Option<Value>,
}

impl Config {
    /// `ConfigRead.parse`: a `config` object, with its bounded string members.
    fn parse(result: &Value) -> Option<Config> {
        let config = result.as_object()?.get("config")?.as_object()?;
        let bounded = |key: &str, max: usize| -> Option<Option<String>> {
            match config.get(key) {
                None | Some(Value::Null) => Some(None),
                Some(Value::String(text)) if text.as_str().len() <= max => {
                    Some(Some(text.as_str().to_owned()))
                }
                Some(_) => None,
            }
        };
        let model = bounded("model", 512)?;
        let provider = bounded("model_provider", 256)?;
        let model_catalog_json = bounded("model_catalog_json", 4096)?;
        let mut providers = Vec::new();
        match config.get("model_providers") {
            None | Some(Value::Null) => {}
            Some(Value::Object(map)) => {
                for (name, value) in map {
                    let url = match value
                        .as_object()
                        .and_then(|entry| entry.get("model_catalog_url"))
                    {
                        None | Some(Value::Null) => None,
                        Some(Value::String(text)) if text.as_str().len() <= 4096 => {
                            Some(text.as_str().to_owned())
                        }
                        _ => return None,
                    };
                    providers.push((name.as_str().to_owned(), url));
                }
            }
            Some(_) => return None,
        }
        let features = match config.get("features") {
            None | Some(Value::Null) => None,
            Some(Value::Object(map)) => Some(Value::Object(map.clone())),
            Some(_) => return None,
        };
        Some(Config {
            model,
            provider,
            model_catalog_json,
            providers,
            features,
        })
    }

    /// `providerCatalogUrl`: the active provider's `model_catalog_url`.
    fn provider_url(&self) -> Option<String> {
        let provider = self.provider.as_deref().unwrap_or("openai");
        self.providers
            .iter()
            .find(|(name, _)| name == provider)
            .and_then(|(_, url)| url.clone())
    }

    /// `catalogSource`: a configured catalog file, else the provider's URL,
    /// else Codex's own.
    fn source(&self) -> CatalogSource {
        if self.model_catalog_json.is_some() {
            return CatalogSource::File;
        }
        if self.provider_url().is_some() {
            return CatalogSource::Provider;
        }
        CatalogSource::Codex
    }

    /// `catalogKey`: `JSON.stringify([provider ?? "openai", file ?? null, url ?? null])`.
    fn key(&self) -> String {
        let provider = self.provider.as_deref().unwrap_or("openai");
        let key = Value::Array(ace_json::Array::from(vec![
            Value::from(provider),
            self.model_catalog_json
                .clone()
                .map(Value::from)
                .unwrap_or(Value::Null),
            self.provider_url().map(Value::from).unwrap_or(Value::Null),
        ]));
        ace_json::to_string(&key)
    }

    /// `configFacts`: the model the thread asks for, else Codex's configured
    /// one, which is JavaScript's `||` and so skips an empty string.
    fn facts(&self, model: Option<&str>) -> CodexToolFacts {
        CodexToolFacts {
            model: non_empty(model).or_else(|| non_empty(self.model.as_deref())),
            provider: self.provider.clone(),
            catalog_source: Some(self.source()),
            catalog: None,
            features: self.features.clone(),
        }
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_owned)
}

/// What the read produced, once.
#[derive(Debug, Clone, PartialEq)]
pub enum ToolFactsOutcome {
    Facts(CodexToolFacts),
    /// `signal.throwIfAborted()`: the caller fails the open instead of guessing.
    Aborted,
}

/// Where `readCodexToolFacts` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Config,
    Catalog,
    Done,
}

/// `readCodexToolFacts` as a machine: one `config/read`, then one catalog read
/// raced against the deadline. It never blocks and never reads a clock; the
/// deadline is the shell's timer.
#[derive(Debug)]
pub struct ToolFactsRead {
    model: Option<String>,
    wake: u64,
    deadline_key: String,
    stage: Stage,
    timed_out: bool,
    aborted: bool,
    config_call: u64,
    config_arrived: bool,
    config: Option<Config>,
    /// The catalog read started beside the config, before its key was known.
    early: Option<Pager>,
    /// The load this read owns.
    main: Option<Pager>,
    /// The key another read is loading for this read.
    waiting_for: Option<String>,
    facts: CodexToolFacts,
    outcome: Option<ToolFactsOutcome>,
}

impl ToolFactsRead {
    /// `readCodexToolFacts`: the config read starts, and the catalog beside it
    /// on a host that has none yet and a model was asked for.
    pub fn start(
        cwd: &str,
        model: Option<&str>,
        catalog_cache: &mut CodexCatalogCache,
        calls: &mut Calls,
        wake: u64,
    ) -> (ToolFactsRead, Vec<Effect>) {
        let deadline_key = format!("tool-facts:{wake}");
        let config_call = calls.take();
        let mut read = ToolFactsRead {
            model: non_empty(model),
            wake,
            deadline_key: deadline_key.clone(),
            stage: Stage::Config,
            timed_out: false,
            aborted: false,
            config_call,
            config_arrived: false,
            config: None,
            early: None,
            main: None,
            waiting_for: None,
            facts: CodexToolFacts::default(),
            outcome: None,
        };
        let mut effects = vec![Effect::ArmTimer {
            key: deadline_key,
            ms: TOOL_FACTS_DEADLINE_MS,
        }];
        // The catalog does not depend on the thread: on a host that has none
        // yet, it is read beside the config.
        if read.model.is_some() && catalog_cache.size() == 0 {
            let (pager, started) = Pager::start(calls, None);
            read.early = Some(pager);
            effects.extend(started);
        }
        effects.push(Effect::Request {
            call: config_call,
            method: "config/read".to_owned(),
            params: config_params(cwd),
            timeout_ms: Some(REQUEST_MS),
        });
        (read, effects)
    }

    pub fn outcome(&self) -> Option<&ToolFactsOutcome> {
        self.outcome.as_ref()
    }

    /// `signal.throwIfAborted()`: nothing is guessed after a cancellation.
    pub fn abort(&mut self) {
        self.aborted = true;
    }

    /// One call's reply, or its failure.
    pub fn settled(
        &mut self,
        calls: &mut Calls,
        catalog_cache: &mut CodexCatalogCache,
        call: u64,
        result: Option<&Value>,
    ) -> Vec<Effect> {
        if call == self.config_call && !self.config_arrived {
            self.config_arrived = true;
            self.config = result.and_then(Config::parse);
            return self.advance(calls, catalog_cache);
        }
        let mut effects = Vec::new();
        for pager in [&mut self.early, &mut self.main].into_iter().flatten() {
            if pager.call == call && pager.done.is_none() {
                effects.extend(pager.page(calls, result));
            }
        }
        let done = self
            .main
            .as_ref()
            .filter(|pager| pager.done.is_some())
            .and_then(|pager| pager.done.clone());
        if let (Some(done), Some(main)) = (done, self.main.as_mut())
            && let Some(key) = main.key.take()
        {
            // The load lands in the cache whether or not this read still waits
            // on it: a deadline never leaves the entry loading.
            catalog_cache.settle(&key, done);
        }
        if self.stage == Stage::Catalog && self.main.as_ref().is_some_and(|p| p.done.is_some()) {
            self.facts.catalog = self.main.take().and_then(|pager| pager.done.flatten());
            effects.extend(self.finish(ToolFactsOutcome::Facts(self.facts.clone())));
        }
        effects
    }

    /// The discovery deadline passed: every read still in flight is unknown.
    pub fn deadline(
        &mut self,
        calls: &mut Calls,
        catalog_cache: &mut CodexCatalogCache,
    ) -> Vec<Effect> {
        if self.stage == Stage::Done {
            return Vec::new();
        }
        self.timed_out = true;
        if self.stage == Stage::Config {
            return self.advance(calls, catalog_cache);
        }
        if let Some(key) = self.waiting_for.take() {
            catalog_cache.abandon(&key, self.wake);
        }
        self.facts.catalog = None;
        self.finish(ToolFactsOutcome::Facts(self.facts.clone()))
    }

    /// A read waiting on another session's load was woken with its value.
    pub fn catalog_ready(&mut self, catalog: Option<Catalog>) -> Vec<Effect> {
        if self.stage != Stage::Catalog || self.waiting_for.is_none() {
            return Vec::new();
        }
        self.waiting_for = None;
        self.facts.catalog = catalog;
        self.finish(ToolFactsOutcome::Facts(self.facts.clone()))
    }

    /// `configFacts` and the catalog decision, once the config read landed (or
    /// its deadline passed).
    fn advance(&mut self, calls: &mut Calls, catalog_cache: &mut CodexCatalogCache) -> Vec<Effect> {
        if self.stage != Stage::Config {
            return Vec::new();
        }
        if !self.config_arrived && !self.timed_out {
            return Vec::new();
        }
        self.facts = match &self.config {
            Some(config) => config.facts(self.model.as_deref()),
            None => CodexToolFacts {
                model: self.model.clone(),
                ..CodexToolFacts::default()
            },
        };
        if self.aborted {
            return self.finish(ToolFactsOutcome::Aborted);
        }
        if !codex_needs_catalog(&self.facts) {
            return self.finish(ToolFactsOutcome::Facts(self.facts.clone()));
        }
        let key = match &self.config {
            Some(config) => config.key(),
            // `config ? … : null`: the key of an unread config.
            None => "[\"openai\",null,null]".to_owned(),
        };
        self.stage = Stage::Catalog;
        if let Some(mut pager) = self.early.take() {
            pager.key = Some(key.clone());
            match catalog_cache.put(&key, self.wake) {
                Cached::Ready(catalog) => {
                    self.facts.catalog = catalog;
                    return self.finish(ToolFactsOutcome::Facts(self.facts.clone()));
                }
                Cached::Waiting => {
                    // Another read owns the key; this load still lands, but its
                    // value is theirs to keep.
                    pager.key = None;
                    self.early = Some(pager);
                    self.waiting_for = Some(key);
                    return Vec::new();
                }
                Cached::Start => {
                    self.main = Some(pager);
                    return Vec::new();
                }
            }
        }
        match catalog_cache.read(&key, self.wake) {
            Cached::Ready(catalog) => {
                self.facts.catalog = catalog;
                self.finish(ToolFactsOutcome::Facts(self.facts.clone()))
            }
            Cached::Waiting => {
                self.waiting_for = Some(key);
                Vec::new()
            }
            Cached::Start => {
                let (pager, started) = Pager::start(calls, Some(key));
                self.main = Some(pager);
                started
            }
        }
    }

    fn finish(&mut self, outcome: ToolFactsOutcome) -> Vec<Effect> {
        if self.stage == Stage::Done {
            return Vec::new();
        }
        self.stage = Stage::Done;
        self.outcome = Some(outcome);
        vec![Effect::CancelTimer {
            key: self.deadline_key.clone(),
        }]
    }
}

/// `config/read`'s params.
fn config_params(cwd: &str) -> Value {
    let mut params = Map::new();
    params.insert("cwd", Value::from(cwd));
    params.insert("includeLayers", Value::Bool(false));
    Value::Object(params)
}
