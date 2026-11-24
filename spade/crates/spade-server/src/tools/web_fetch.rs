//! `web_fetch`: reads a web page or PDF as readable text (`spade-fetch`), saves the full text to
//! the bot's workspace (`web/<host>-<short-hash>.md`) and returns a compact handle (title, URL,
//! total length, saved path, heading outline with character offsets, and the first ~4,000
//! characters). Follow-up calls with `offset` or `query` read from the saved file instead of
//! re-fetching over the network.
//!
//! Its output is untrusted and the saved workspace file is never added to the workspace trust
//! allowlist, so both direct fetches and later workspace reads taint the turn.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_core::web_fetch::{
    self, DEFAULT_WINDOW_CHARS, SavedPage, canonical_url, format_saved, parse_saved, render_query,
    render_window, save_path,
};
use spade_fetch::Fetcher;
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::workspace::{LARGEST_TEXT, PathError, Workspace, Workspaces};

/// Most `(conversation, canonical_url)` entries kept in memory for saved-file reuse.
const MAX_CACHED_URLS: usize = 512;

/// Bounded per-conversation map from canonical URL to the workspace path where `web_fetch` saved
/// it, so follow-up `offset` or `query` calls reuse the saved text without hitting the network.
#[derive(Default)]
struct SavedCache {
    paths: HashMap<(String, String), String>,
    order: VecDeque<(String, String)>,
}

impl SavedCache {
    fn get(&self, conversation: &str, url: &str) -> Option<String> {
        self.paths
            .get(&(conversation.to_owned(), url.to_owned()))
            .cloned()
    }

    fn record(&mut self, conversation: &str, url: String, path: String) {
        let key = (conversation.to_owned(), url);
        if let Some(existing) = self.paths.get_mut(&key) {
            *existing = path;
            return;
        }
        if self.paths.len() >= MAX_CACHED_URLS
            && let Some(oldest) = self.order.pop_front()
        {
            self.paths.remove(&oldest);
        }
        self.order.push_back(key.clone());
        self.paths.insert(key, path);
    }
}

pub struct WebFetch {
    fetcher: Arc<Fetcher>,
    workspaces: Option<Workspaces>,
    bots: Option<EngineHandle>,
    saved: Arc<Mutex<SavedCache>>,
}

impl WebFetch {
    #[must_use]
    pub fn new(fetcher: Arc<Fetcher>) -> Self {
        Self {
            fetcher,
            workspaces: None,
            bots: None,
            saved: Arc::new(Mutex::new(SavedCache::default())),
        }
    }

    /// Saves fetched page text into the calling bot's workspace under `web/`.
    #[must_use]
    pub fn with_workspaces(mut self, workspaces: Workspaces, bots: EngineHandle) -> Self {
        self.workspaces = Some(workspaces);
        self.bots = Some(bots);
        self
    }

    fn target(&self, key: &str) -> Option<(String, Workspace, EngineHandle)> {
        let workspaces = self.workspaces.as_ref()?;
        let bots = self.bots.as_ref()?;
        let bot = bots.agent_for_key(key)?;
        let workspace = workspaces.of(&bot).ok()?;
        Some((bot, workspace, bots.clone()))
    }
}

#[derive(Deserialize)]
struct Args {
    url: String,
    #[serde(default)]
    offset: Option<usize>,
    #[serde(default)]
    query: Option<String>,
}

impl Tool for WebFetch {
    fn def(&self) -> ToolDef {
        ToolDef {
            spec: ToolSpec {
                name: "web_fetch".to_owned(),
                description: "Read a web page or PDF as readable text. Saves the full text to \
                              your workspace under web/ and returns the title, URL, length, saved \
                              path, heading outline with character offsets, and the first ~4,000 \
                              characters. Read the outline and pull specific sections with \
                              `offset` or matching passages with `query` (or use \
                              workspace_read/workspace_search on the saved file) instead of \
                              re-fetching."
                    .to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string" },
                        "offset": {
                            "type": "integer",
                            "minimum": 0,
                            "description": "Character offset to read from (use an outline offset or the next offset from a previous call)."
                        },
                        "query": {
                            "type": "string",
                            "description": "Keywords or phrase to return the best-matching passages of the saved page text."
                        }
                    },
                    "required": ["url"]
                }),
            },
            risk: Risk::Read,
            untrusted_output: true,
            deferred: false,
            background: false,
        }
    }

    fn run(&self, key: &str, arguments: Value) -> ToolFuture {
        let fetcher = self.fetcher.clone();
        let saved_cache = self.saved.clone();
        let target = self.target(key);
        let conversation = super::bots::caller(key).to_owned();

        Box::pin(async move {
            let args: Args = match parse(arguments) {
                Ok(args) => args,
                Err(output) => return output,
            };
            let query = args
                .query
                .as_deref()
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(str::to_owned);
            let offset = args.offset.unwrap_or(0);
            let canonical_req = canonical_url(&args.url);

            // Follow-up offset/query reads in the same conversation reuse the saved workspace
            // file instead of hitting the network again.
            if (query.is_some() || offset > 0)
                && let Some((_, workspace, _)) = &target
            {
                let cached_path = saved_cache
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(&conversation, &canonical_req);
                if let Some(cached_path) = cached_path
                    && let Some(page) = read_saved(workspace.clone(), cached_path.clone()).await
                {
                    let rendered = render(&page, Some(&cached_path), offset, query.as_deref());
                    return ToolOutput::ok(rendered).untrusted();
                }
            }

            match fetcher.fetch_page(&args.url).await {
                Ok(fetched) => {
                    let mut page = SavedPage {
                        url: fetched.url,
                        title: fetched.title,
                        content_type: fetched.content_type,
                        pages: fetched.pages,
                        truncated: fetched.truncated,
                        text: fetched.text,
                    };
                    let saved_path = match target {
                        Some((bot, workspace, bots)) => {
                            let path = save_path(&page.url);
                            let saved =
                                save_to_workspace(&workspace, &path, &mut page, &bot, &bots).await;
                            if saved {
                                let mut cache =
                                    saved_cache.lock().unwrap_or_else(|p| p.into_inner());
                                cache.record(&conversation, canonical_req, path.clone());
                                let canonical_final = canonical_url(&page.url);
                                cache.record(&conversation, canonical_final, path.clone());
                                Some(path)
                            } else {
                                None
                            }
                        }
                        None => None,
                    };

                    let rendered = render(&page, saved_path.as_deref(), offset, query.as_deref());
                    ToolOutput::ok(rendered).untrusted()
                }
                Err(error) => {
                    // The network, a rate limit or a server error may pass (ADR 0160).
                    let transient = matches!(
                        &error,
                        spade_fetch::FetchError::Network { .. }
                            | spade_fetch::FetchError::TimedOut(_)
                            | spade_fetch::FetchError::Status(429 | 500..=599)
                    );
                    let output = ToolOutput::error(error.to_string()).untrusted();
                    if transient {
                        output.transient()
                    } else {
                        output
                    }
                }
            }
        })
    }
}

fn render(
    page: &SavedPage,
    saved_path: Option<&str>,
    offset: usize,
    query: Option<&str>,
) -> String {
    match query {
        Some(q) => render_query(page, saved_path, q),
        None => render_window(page, saved_path, offset, DEFAULT_WINDOW_CHARS),
    }
}

async fn read_saved(workspace: Workspace, path: String) -> Option<SavedPage> {
    tokio::task::spawn_blocking(move || {
        let raw = workspace.text(&path).ok()?;
        parse_saved(&raw)
    })
    .await
    .ok()
    .flatten()
}

/// Saves `page` to `path` in `workspace`, keeping it explicitly untrusted and notifying live views.
/// If the formatted file exceeds [`LARGEST_TEXT`], caps `page` to match what was written so
/// `workspace_read` can always open it and offsets stay consistent.
async fn save_to_workspace(
    workspace: &Workspace,
    path: &str,
    page: &mut SavedPage,
    bot: &str,
    bots: &EngineHandle,
) -> bool {
    let max_bytes = usize::try_from(LARGEST_TEXT).unwrap_or(4 * 1024 * 1024);
    let (formatted, capped) = format_saved(page, max_bytes);
    if capped && let Some(parsed) = web_fetch::parse_saved(&formatted) {
        page.text = parsed.text;
        page.truncated = true;
    }

    let ws = workspace.clone();
    let write_path = path.to_owned();
    let url_for_trust = page.url.clone();
    let result = tokio::task::spawn_blocking(move || {
        ws.changing(|| {
            ws.write_bytes(&write_path, formatted.as_bytes(), max_bytes)?;
            // Fetched web pages are always untrusted; remove any prior trust record at this path.
            ws.trust()
                .record_write(&write_path, formatted.as_bytes(), Some(&url_for_trust));
            Ok::<(), PathError>(())
        })
    })
    .await
    .unwrap_or_else(|_| Err(PathError::Io("the file work stopped".to_owned())));

    match result {
        Ok(()) => {
            if let Some(engine) = bots.get()
                && let Some(computers) = engine.computers()
            {
                computers.files_changed(bot, Some(vec![path.to_owned()]));
            }
            true
        }
        Err(error) => {
            tracing::warn!(%error, %path, "web_fetch page was not saved to workspace");
            false
        }
    }
}
