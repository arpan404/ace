//! `web_fetch`: one page as readable text, a window at a time (spade-fetch). Its output is
//! untrusted: a page can carry instructions written to trick Spade, so the gate tightens after one.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_fetch::{Fetcher, Page};
use spade_models::ToolSpec;

use super::{Tool, ToolFuture, ToolOutput, parse};

pub struct WebFetch(pub Arc<Fetcher>);

#[derive(Deserialize)]
struct Args {
    url: String,
    #[serde(default)]
    offset: Option<usize>,
}

impl Tool for WebFetch {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "web_fetch".to_owned(),
                description: "Read a web page as plain text. Long pages come in parts: pass the \
                              offset given at the end to read the next part."
                    .to_owned(),
                schema: json!({ "type": "object",
                                "properties": { "url": { "type": "string" },
                                                "offset": { "type": "integer", "minimum": 0 } },
                                "required": ["url"] }),
            },
            risk: Risk::Read,
            untrusted_output: true,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, _call_id: &str, arguments: Value) -> ToolFuture {
        let fetcher = self.0.clone();
        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let page = Page {
                offset: args.offset.unwrap_or(0),
                ..Page::default()
            };
            match fetcher.fetch(&args.url, page).await {
                Ok(fetched) => {
                    let mut out = String::new();
                    if let Some(title) = &fetched.title {
                        out.push_str(&format!("# {title}\n"));
                    }
                    out.push_str(&format!("{}\n\n{}", fetched.url, fetched.text));
                    if let Some(next) = fetched.next_offset {
                        out.push_str(&format!(
                            "\n\n[{} of {} characters shown; read on with offset {next}]",
                            next.min(fetched.total_chars),
                            fetched.total_chars
                        ));
                    }
                    if fetched.truncated {
                        out.push_str(
                            "\n\n[The page was too large to read whole; this is its start.]",
                        );
                    }
                    ToolOutput::ok(out)
                }
                Err(error) => ToolOutput::error(error.to_string()),
            }
        })
    }
}
