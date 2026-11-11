//! `web_search`: the person's SearXNG, then Brave (spade-search). Results are untrusted: a page
//! can carry instructions written to trick Spade, so the gate tightens after one.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_models::ToolSpec;
use spade_search::Search;

use super::{Tool, ToolFuture, ToolOutput, parse};

pub struct WebSearch(pub Arc<Search>);

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
        }
    }

    fn run(&self, arguments: Value) -> ToolFuture {
        let search = self.0.clone();
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
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}
