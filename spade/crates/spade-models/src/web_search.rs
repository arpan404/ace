//! The endpoint's own web search (docs/design.md, Web search): Anthropic Messages' server web
//! search tool and OpenAI Responses' web search tool, for models marked `web-search`. One plain
//! HTTP call on the chat client (no redirects followed with a key). Answers are read leniently:
//! whatever results and citations can be found are kept, unknown blocks are skipped.

use std::time::Duration;

use serde_json::{Value, json};

use crate::catalog::{Capability, Endpoint, Model};
use crate::client::Models;
use crate::error::ModelError;
use crate::format::Format;
use crate::listing::one_line;
use crate::prompt::Usage;

/// How long one search may take.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(60);
/// The most an answer may be, in bytes.
const MOST_ANSWER: usize = 4 * 1024 * 1024;
/// Words the model may write about what it found.
const MAX_TOKENS: u32 = 1024;
/// The most characters kept of one snippet.
const SNIPPET_CHARS: usize = 400;

/// One page the search found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// What the endpoint's search found: the pages, the model's short answer citing them, what the
/// call cost in tokens, and how many searches the endpoint billed.
#[derive(Debug, Clone, PartialEq)]
pub struct WebFound {
    pub hits: Vec<WebHit>,
    pub answer: String,
    pub usage: Usage,
    pub searches: u32,
}

impl Models {
    /// Whether `reference` can search the web on its own endpoint.
    pub fn searches_natively(&self, reference: &str) -> bool {
        self.resolve(reference)
            .is_some_and(|(endpoint, model)| native(&endpoint, &model))
    }

    /// Searches the web for `query` with `reference`'s own endpoint, keeping up to `count` pages.
    pub async fn web_search(
        &self,
        reference: &str,
        query: &str,
        count: usize,
    ) -> Result<WebFound, ModelError> {
        let (endpoint, model) = self
            .resolve(reference)
            .ok_or_else(|| ModelError::UnknownModel(reference.to_owned()))?;
        let fail = |message: String, key: Option<&str>| {
            let mut secrets: Vec<&str> = endpoint.headers.iter().map(|(_, v)| v.as_str()).collect();
            secrets.extend(key);
            ModelError::Provider {
                model: reference.to_owned(),
                message: one_line(&message, &secrets),
            }
        };
        if !native(&endpoint, &model) {
            return Err(fail(
                "this model has no web search of its own".to_owned(),
                None,
            ));
        }
        let key = if endpoint.needs_key {
            Some(
                self.key_for(&endpoint)
                    .await
                    .ok_or_else(|| ModelError::MissingKey {
                        endpoint: endpoint.id.clone(),
                        var: endpoint.key_env.clone(),
                    })?,
            )
        } else {
            None
        };
        let ask = format!(
            "Search the web for: {query}\n\nThen answer in a few sentences, citing the pages you \
             used."
        );
        let (path, body) = match endpoint.format {
            Format::Anthropic => (
                "messages",
                json!({ "model": model.id, "max_tokens": MAX_TOKENS,
                        "messages": [{ "role": "user", "content": ask }],
                        "tools": [{ "type": "web_search_20250305", "name": "web_search",
                                    "max_uses": 1 }] }),
            ),
            _ => (
                "responses",
                json!({ "model": model.id, "max_output_tokens": MAX_TOKENS, "input": ask,
                        "tools": [{ "type": "web_search" }] }),
            ),
        };
        let mut request = self
            .http()
            .post(format!("{}{path}", endpoint.base_url))
            .timeout(SEARCH_TIMEOUT)
            .json(&body);
        request = match (endpoint.format, key.as_deref()) {
            (Format::Anthropic, Some(key)) => request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01"),
            (Format::Anthropic, None) => request.header("anthropic-version", "2023-06-01"),
            (_, Some(key)) => request.bearer_auth(key),
            (_, None) => request,
        };
        for (name, value) in &endpoint.headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let response = request
            .send()
            .await
            .map_err(|e| fail(e.to_string(), key.as_deref()))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|e| fail(e.to_string(), key.as_deref()))?;
        if bytes.len() > MOST_ANSWER {
            return Err(fail(
                "the search answer is too large".to_owned(),
                key.as_deref(),
            ));
        }
        let answer: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        if !status.is_success() {
            let why = answer["error"]["message"]
                .as_str()
                .map_or_else(|| status.to_string(), |m| format!("{status}: {m}"));
            return Err(fail(why, key.as_deref()));
        }
        let mut found = match endpoint.format {
            Format::Anthropic => read_messages(&answer),
            _ => read_responses(&answer),
        };
        found.hits.truncate(count.max(1));
        Ok(found)
    }
}

/// The model searches on its own endpoint: it says so, and its format has a search tool.
fn native(endpoint: &Endpoint, model: &Model) -> bool {
    model.can(Capability::WebSearch)
        && matches!(endpoint.format, Format::Anthropic | Format::OpenAiResponses)
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().trim().to_owned()
}

fn tokens(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|n| u32::try_from(n).ok())
}

fn snippet(text: &str) -> String {
    let words = text.split_whitespace().collect::<Vec<_>>().join(" ");
    words.chars().take(SNIPPET_CHARS).collect()
}

/// Adds a page once, by address; a later citation fills a snippet still empty.
fn add(hits: &mut Vec<WebHit>, url: &str, title: &str, cited: &str) {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    match hits.iter_mut().find(|hit| hit.url == url) {
        Some(hit) => {
            if hit.snippet.is_empty() {
                hit.snippet = snippet(cited);
            }
            if hit.title.is_empty() {
                hit.title = title.trim().to_owned();
            }
        }
        None => hits.push(WebHit {
            title: title.trim().to_owned(),
            url: url.to_owned(),
            snippet: snippet(cited),
        }),
    }
}

/// An Anthropic Messages answer: `web_search_tool_result` blocks list the pages, `text` blocks
/// answer with `web_search_result_location` citations.
pub(crate) fn read_messages(answer: &Value) -> WebFound {
    let mut hits = Vec::new();
    let mut words = Vec::new();
    for block in answer["content"].as_array().into_iter().flatten() {
        match block["type"].as_str() {
            Some("web_search_tool_result") => {
                for result in block["content"].as_array().into_iter().flatten() {
                    add(
                        &mut hits,
                        &text(&result["url"]),
                        &text(&result["title"]),
                        "",
                    );
                }
            }
            Some("text") => {
                words.push(text(&block["text"]));
                for cited in block["citations"].as_array().into_iter().flatten() {
                    add(
                        &mut hits,
                        &text(&cited["url"]),
                        &text(&cited["title"]),
                        &text(&cited["cited_text"]),
                    );
                }
            }
            _ => {}
        }
    }
    let usage = &answer["usage"];
    WebFound {
        hits,
        answer: words.concat().trim().to_owned(),
        usage: Usage {
            input_tokens: tokens(&usage["input_tokens"]),
            output_tokens: tokens(&usage["output_tokens"]),
            cache_read_tokens: tokens(&usage["cache_read_input_tokens"]),
            cache_write_tokens: tokens(&usage["cache_creation_input_tokens"]),
        },
        searches: tokens(&usage["server_tool_use"]["web_search_requests"]).unwrap_or(0),
    }
}

/// An OpenAI Responses answer: each `web_search_call` item is one search (its `action.sources`
/// list pages when the endpoint sends them), and `output_text` parts carry `url_citation`
/// annotations over spans of the answer.
pub(crate) fn read_responses(answer: &Value) -> WebFound {
    let mut hits = Vec::new();
    let mut words = Vec::new();
    let mut searches = 0;
    for item in answer["output"].as_array().into_iter().flatten() {
        match item["type"].as_str() {
            Some("web_search_call") => {
                searches += 1;
                for source in item["action"]["sources"].as_array().into_iter().flatten() {
                    add(
                        &mut hits,
                        &text(&source["url"]),
                        &text(&source["title"]),
                        "",
                    );
                }
            }
            Some("message") => {
                for part in item["content"].as_array().into_iter().flatten() {
                    if part["type"] != "output_text" {
                        continue;
                    }
                    let said = part["text"].as_str().unwrap_or_default();
                    words.push(said.trim().to_owned());
                    for note in part["annotations"].as_array().into_iter().flatten() {
                        if note["type"] != "url_citation" {
                            continue;
                        }
                        let span = |at: &Value| at.as_u64().and_then(|n| usize::try_from(n).ok());
                        // Indices count characters; anything out of range cites nothing.
                        let cited: String =
                            match (span(&note["start_index"]), span(&note["end_index"])) {
                                (Some(start), Some(end)) if start < end => {
                                    said.chars().skip(start).take(end - start).collect()
                                }
                                _ => String::new(),
                            };
                        add(
                            &mut hits,
                            &text(&note["url"]),
                            &text(&note["title"]),
                            &cited,
                        );
                    }
                }
            }
            _ => {}
        }
    }
    let usage = &answer["usage"];
    WebFound {
        hits,
        answer: words.join("\n\n").trim().to_owned(),
        usage: Usage {
            input_tokens: tokens(&usage["input_tokens"]),
            output_tokens: tokens(&usage["output_tokens"]),
            cache_read_tokens: tokens(&usage["input_tokens_details"]["cached_tokens"]),
            cache_write_tokens: None,
        },
        searches,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_messages_answer_keeps_each_page_once_with_the_text_it_was_cited_for() {
        let answer = json!({
            "content": [
                { "type": "server_tool_use", "id": "s1", "name": "web_search",
                  "input": { "query": "rust 2027" } },
                { "type": "web_search_tool_result", "tool_use_id": "s1", "content": [
                    { "type": "web_search_result", "url": "https://blog.rust-lang.org/2027",
                      "title": "Rust 2027", "encrypted_content": "…", "page_age": "1 day" },
                    { "type": "web_search_result", "url": "javascript:alert(1)", "title": "x" },
                    { "type": "some_future_block" } ] },
                { "type": "text", "text": "Rust 2027 ships in May.",
                  "citations": [{ "type": "web_search_result_location",
                                  "url": "https://blog.rust-lang.org/2027", "title": "Rust 2027",
                                  "cited_text": "The  2027 edition\nships in May." }] },
                { "type": "brand_new_kind", "text": "ignored" }
            ],
            "usage": { "input_tokens": 900, "output_tokens": 40,
                       "server_tool_use": { "web_search_requests": 1 } }
        });
        let found = read_messages(&answer);
        assert_eq!(
            found.hits,
            vec![WebHit {
                title: "Rust 2027".into(),
                url: "https://blog.rust-lang.org/2027".into(),
                snippet: "The 2027 edition ships in May.".into(),
            }]
        );
        assert_eq!(found.answer, "Rust 2027 ships in May.");
        assert_eq!(found.searches, 1);
        assert_eq!(found.usage.input_tokens, Some(900));
    }

    #[test]
    fn a_responses_answer_counts_each_search_and_cites_the_span_it_annotates() {
        let answer = json!({
            "output": [
                { "type": "web_search_call", "id": "ws1", "status": "completed",
                  "action": { "type": "search", "query": "rust 2027",
                              "sources": [{ "type": "url", "url": "https://example.org/a" }] } },
                { "type": "message", "role": "assistant", "content": [
                    { "type": "output_text", "text": "Ships in May (source).",
                      "annotations": [
                        { "type": "url_citation", "url": "https://example.org/a",
                          "title": "A", "start_index": 0, "end_index": 13 },
                        { "type": "url_citation", "url": "https://example.org/b",
                          "title": "B", "start_index": 90, "end_index": 99 } ] } ] }
            ],
            "usage": { "input_tokens": 500, "output_tokens": 30,
                       "input_tokens_details": { "cached_tokens": 100 } }
        });
        let found = read_responses(&answer);
        assert_eq!(found.searches, 1);
        assert_eq!(found.answer, "Ships in May (source).");
        let shown: Vec<(&str, &str, &str)> = found
            .hits
            .iter()
            .map(|h| (h.url.as_str(), h.title.as_str(), h.snippet.as_str()))
            .collect();
        assert_eq!(
            shown,
            vec![
                ("https://example.org/a", "A", "Ships in May"),
                ("https://example.org/b", "B", "")
            ]
        );
        assert_eq!(found.usage.cache_read_tokens, Some(100));
    }

    #[test]
    fn an_answer_of_another_shape_finds_nothing_rather_than_failing() {
        let found = read_messages(&json!({ "content": "not a list", "usage": null }));
        assert!(found.hits.is_empty() && found.answer.is_empty() && found.searches == 0);
        let found = read_responses(&json!(["odd"]));
        assert!(found.hits.is_empty() && found.searches == 0);
    }
}
