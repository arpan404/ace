// SPDX-License-Identifier: Apache-2.0
//! Codex's config as the tool facts read it, and the catalog pager over
//! `model/list` (`tool-facts.ts:22`-`:150`).

use ace_json::{Map, Value};

use crate::session::frames::{Calls, Effect};

use super::cache::Catalog;
use super::{CatalogSource, CodexToolFacts};

/// Enough for any catalog Codex ships or fetches (`maxPages`).
const MAX_PAGES: u64 = 10;
/// One request's default deadline (`request` in `session.ts`).
const REQUEST_MS: f64 = 30_000.0;

/// One `model/list` pager (`readCatalog`): at most ten pages of slugs.
#[derive(Debug)]
pub(crate) struct Pager {
    /// The call the pager waits for.
    pub(crate) call: u64,
    pages: u64,
    slugs: Catalog,
    pub(crate) done: Option<Option<Catalog>>,
    /// The cache key this load owns; `None` when another read owns the key.
    pub(crate) key: Option<String>,
}

impl Pager {
    /// `readCatalog`'s first page: `{ includeHidden: true, limit: 100, cursor }`.
    pub(crate) fn start(calls: &mut Calls, key: Option<String>) -> (Pager, Vec<Effect>) {
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

    pub(crate) fn params(&self, cursor: Option<&str>) -> Value {
        let mut params = Map::new();
        params.insert("includeHidden", Value::Bool(true));
        params.insert("limit", Value::from(100));
        params.insert("cursor", cursor.map(Value::from).unwrap_or(Value::Null));
        Value::Object(params)
    }

    /// One page (`ModelPage.parse`): every entry's `model` then `id`, then the
    /// next cursor, bounded by ten pages. Anything that does not parse ends
    /// the read as unknown.
    pub(crate) fn page(&mut self, calls: &mut Calls, result: Option<&Value>) -> Vec<Effect> {
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
pub(crate) struct Config {
    model: Option<String>,
    provider: Option<String>,
    model_catalog_json: Option<String>,
    providers: Vec<(String, Option<String>)>,
    features: Option<Value>,
}

impl Config {
    /// `ConfigRead.parse`: a `config` object, with its bounded string members.
    pub(crate) fn parse(result: &Value) -> Option<Config> {
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
    pub(crate) fn provider_url(&self) -> Option<String> {
        let provider = self.provider.as_deref().unwrap_or("openai");
        self.providers
            .iter()
            .find(|(name, _)| name == provider)
            .and_then(|(_, url)| url.clone())
    }

    /// `catalogSource`: a configured catalog file, else the provider's URL,
    /// else Codex's own.
    pub(crate) fn source(&self) -> CatalogSource {
        if self.model_catalog_json.is_some() {
            return CatalogSource::File;
        }
        if self.provider_url().is_some() {
            return CatalogSource::Provider;
        }
        CatalogSource::Codex
    }

    /// `catalogKey`: `JSON.stringify([provider ?? "openai", file ?? null, url ?? null])`.
    pub(crate) fn key(&self) -> String {
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
    pub(crate) fn facts(&self, model: Option<&str>) -> CodexToolFacts {
        CodexToolFacts {
            model: non_empty(model).or_else(|| non_empty(self.model.as_deref())),
            provider: self.provider.clone(),
            catalog_source: Some(self.source()),
            catalog: None,
            features: self.features.clone(),
        }
    }
}

pub(crate) fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|text| !text.is_empty()).map(str::to_owned)
}
