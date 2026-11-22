//! `web_search`: ace cloud search first (ADR 0210), then the bot's own endpoint's search where its
//! model has one, else one plain sentence ("Sign in to ace to search the web.", "ace search is
//! resting today." or the refusal's own reason). Results are untrusted: a page can carry
//! instructions written to trick Spade, so the gate tightens after one.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_search::{Found, Search, SearchError};

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::engine::Native;

pub struct WebSearch {
    pub search: Arc<Search>,
    /// The engine, for the calling bot's model and its endpoint's own search.
    pub bots: EngineHandle,
}

#[derive(Deserialize)]
struct Args {
    query: String,
    #[serde(default)]
    count: Option<usize>,
}

impl Tool for WebSearch {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "web_search".to_owned(),
                description:
                    "Search the web for current facts, pages and sources. Returns titles, \
                              addresses and short snippets; read the pages that matter in full \
                              with web_fetch before relying on them. For a question needing many \
                              sources, research (when you have it) writes a cited report."
                        .to_owned(),
                schema: json!({ "type": "object",
                                "properties": { "query": { "type": "string" },
                                                "count": { "type": "integer", "minimum": 1, "maximum": 10 } },
                                "required": ["query"] }),
            },
            risk: Risk::Read,
            untrusted_output: true,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let search = self.search.clone();
        let conversation = key.split_once('.').map_or(key, |(c, _)| c).to_owned();
        let engine = self.bots.get();
        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let count = args.count.unwrap_or(8).clamp(1, spade_search::MOST_RESULTS);
            let unanswered = match search.search(&args.query, count).await {
                Ok(found) => return ToolOutput::ok(found_text(&found)),
                Err(SearchError::EmptyQuery) => {
                    return ToolOutput::error("The search query is empty.");
                }
                Err(error) => error,
            };
            if let SearchError::Failed(why) = &unanswered {
                tracing::debug!(%why, "ace search failed");
            }
            let native = match &engine {
                Some(engine) => {
                    engine
                        .native_search(&conversation, args.query.trim(), count)
                        .await
                }
                None => Native::Unavailable,
            };
            match native {
                Native::Found(found) if found.hits.is_empty() && found.answer.is_empty() => {
                    ToolOutput::ok("No results.")
                }
                Native::Found(found) => ToolOutput::ok(native_text(&found)),
                Native::Failed(why) => {
                    tracing::debug!(%why, "the endpoint's own search failed");
                    ToolOutput::error(unanswered.to_string())
                }
                Native::Unavailable => ToolOutput::error(unanswered.to_string()),
            }
        })
    }
}

/// ace search's results, numbered, each with its source link for the bot to cite.
fn found_text(found: &Found) -> String {
    if found.results.is_empty() {
        return "No results.".to_owned();
    }
    let lines: Vec<String> = found
        .results
        .iter()
        .enumerate()
        .map(|(i, r)| format!("{}. {}\n{}\n{}", i + 1, r.title, r.url, r.snippet))
        .collect();
    lines.join("\n\n")
}

/// The endpoint's answer, then its sources numbered like the backends' results.
fn native_text(found: &spade_models::WebFound) -> String {
    let mut text = found.answer.clone();
    if !found.hits.is_empty() {
        if !text.is_empty() {
            text.push_str("\n\nSources:\n");
        }
        let lines: Vec<String> = found
            .hits
            .iter()
            .enumerate()
            .map(|(i, hit)| {
                let mut line = format!("{}. {}\n{}", i + 1, hit.title, hit.url);
                if !hit.snippet.is_empty() {
                    line.push('\n');
                    line.push_str(&hit.snippet);
                }
                line
            })
            .collect();
        text.push_str(&lines.join("\n\n"));
    }
    text
}
