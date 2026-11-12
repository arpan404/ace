//! `web_search`: the bot's own endpoint's search where its model has one, then the person's
//! SearXNG, then Brave (spade-search). Results are untrusted: a page can carry instructions
//! written to trick Spade, so the gate tightens after one.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_search::{Search, SearchError};

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::engine::Native;

pub struct WebSearch {
    pub search: Arc<Search>,
    /// ace's tools are there, so when every backend fails an ace agent can search instead.
    pub ace_fallback: bool,
    /// The engine, for the calling bot's model and its endpoint's own search.
    pub bots: EngineHandle,
}

/// What the model is told when every backend failed and ace can help.
pub const ACE_FALLBACK: &str = "Every search backend failed. Search through an ace agent instead: \
find ace's delegate tool with tool_search and start one on the cheapest model the person has \
(a small fast model is enough), asking it to search the web for this and report the links it \
finds with a line on each.";

/// The first words of the result when no web search is set up. The app knows them and shows a
/// quiet line under the reply that opens Settings › Spade › Web search (docs/design.md).
pub const NOT_SET_UP: &str = "No web search is set up.";

/// What the model is told to say when no web search is set up.
const POINT_TO_SETTINGS: &str = "Tell the person, in one short sentence, that they can add a \
Brave Search key or their own SearXNG address in Settings › Spade › Web search.";

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
                    "Search the web. Returns titles, addresses and short snippets; read a \
                              page in full with web_fetch."
                        .to_owned(),
                schema: json!({ "type": "object",
                                "properties": { "query": { "type": "string" },
                                                "count": { "type": "integer", "minimum": 1, "maximum": 20 } },
                                "required": ["query"] }),
            },
            risk: Risk::Read,
            untrusted_output: true,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let (search, ace_fallback) = (self.search.clone(), self.ace_fallback);
        let conversation = key.split_once('.').map_or(key, |(c, _)| c).to_owned();
        let engine = self.bots.get();
        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let count = args.count.unwrap_or(8).clamp(1, spade_search::MOST_RESULTS);
            let native = match &engine {
                Some(engine) if !args.query.trim().is_empty() => {
                    engine
                        .native_search(&conversation, args.query.trim(), count)
                        .await
                }
                _ => Native::Unavailable,
            };
            let native_failed = match native {
                Native::Found(found) if !found.hits.is_empty() || !found.answer.is_empty() => {
                    return ToolOutput::ok(native_text(&found));
                }
                Native::Found(_) => Some("it found nothing".to_owned()),
                Native::Failed(why) => Some(why),
                Native::Unavailable => None,
            };
            let failed = match search.search(&args.query, count).await {
                Ok(found) if found.results.is_empty() => return ToolOutput::ok("No results."),
                Ok(found) => {
                    let lines: Vec<String> = found
                        .results
                        .iter()
                        .enumerate()
                        .map(|(i, r)| format!("{}. {}\n{}\n{}", i + 1, r.title, r.url, r.snippet))
                        .collect();
                    return ToolOutput::ok(lines.join("\n\n"));
                }
                Err(error) => error,
            };
            let mut text = match (&failed, &native_failed) {
                // The endpoint's own search was tried: setting up another is not the answer.
                (SearchError::NotSetUp, None) => format!("{NOT_SET_UP} {POINT_TO_SETTINGS}"),
                (error, None) => error.to_string(),
                (error, Some(why)) => {
                    format!("The model's own web search failed ({why}); then {error}")
                }
            };
            if ace_fallback {
                text.push_str("\n\n");
                text.push_str(ACE_FALLBACK);
            }
            ToolOutput::error(text)
        })
    }
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use spade_keys::Keys;
    use spade_search::SearchConfig;

    use super::*;

    /// A search whose only backend refuses connections.
    fn broken() -> Arc<Search> {
        let config = SearchConfig::from_json(
            &json!({ "backends": [
                { "id": "searxng", "name": "SearXNG", "kind": "searxng", "base_url": "http://127.0.0.1:9/" }
            ]})
            .to_string(),
        )
        .unwrap_or_else(|e| panic!("config: {e}"));
        Arc::new(
            Search::new(config, Keys::new(|_| None), Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("search: {e}")),
        )
    }

    #[tokio::test]
    async fn when_every_backend_fails_the_model_is_pointed_at_an_ace_agent_only_if_ace_is_there() {
        let query = json!({ "query": "rust release date" });
        let with_ace = WebSearch {
            search: broken(),
            ace_fallback: true,
            bots: EngineHandle::default(),
        }
        .run("c1", query.clone())
        .await;
        assert!(with_ace.is_error);
        assert!(
            with_ace.content.ends_with(ACE_FALLBACK),
            "{}",
            with_ace.content
        );

        let alone = WebSearch {
            search: broken(),
            ace_fallback: false,
            bots: EngineHandle::default(),
        }
        .run("c1", query)
        .await;
        assert!(alone.is_error && !alone.content.contains("ace agent"));
    }
}
