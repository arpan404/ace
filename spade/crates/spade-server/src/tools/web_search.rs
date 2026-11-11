//! `web_search`: the person's SearXNG, then Brave (spade-search). Results are untrusted: a page
//! can carry instructions written to trick Spade, so the gate tightens after one.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_search::Search;

use super::{Tool, ToolFuture, ToolOutput, parse};

pub struct WebSearch {
    pub search: Arc<Search>,
    /// ace's tools are there, so when every backend fails an ace agent can search instead.
    pub ace_fallback: bool,
}

/// What the model is told when every backend failed and ace can help.
pub const ACE_FALLBACK: &str = "Every search backend failed. Search through an ace agent instead: \
find ace's delegate tool with tool_search and start one on the cheapest model the person has \
(a small fast model is enough), asking it to search the web for this and report the links it \
finds with a line on each.";

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

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let (search, ace_fallback) = (self.search.clone(), self.ace_fallback);
        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            match search.search(&args.query, args.count.unwrap_or(8)).await {
                Ok(found) if found.results.is_empty() => ToolOutput::ok("No results."),
                Ok(found) => {
                    let lines: Vec<String> = found
                        .results
                        .iter()
                        .enumerate()
                        .map(|(i, r)| format!("{}. {}\n{}\n{}", i + 1, r.title, r.url, r.snippet))
                        .collect();
                    ToolOutput::ok(lines.join("\n\n"))
                }
                Err(error) if ace_fallback => {
                    ToolOutput::error(format!("{error}\n\n{ACE_FALLBACK}"))
                }
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
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
        }
        .run("c1", query)
        .await;
        assert!(alone.is_error && !alone.content.contains("ace agent"));
    }
}
