//! `web_fetch`: reads a web page or PDF as readable text (`spade-fetch`), saves an immutable
//! snapshot to the bot's workspace (`web/<host>-<url-hash>-<content-hash>.md`) without ever
//! clobbering non-fetch files, and returns a compact bounded handle (title, URL, total length,
//! saved path, heading outline with character offsets, and the first ~4,000 characters).
//!
//! Each conversation's URL-to-snapshot mapping is persisted outside the bot's workspace folder
//! (under `<workspaces>/.web-fetch/<bot>.json`) so follow-up `offset` (including `offset: 0`) and
//! `query` calls reuse the exact immutable snapshot even across restarts or concurrent fetches.
//!
//! Its output is untrusted and saved snapshots are never added to the workspace trust allowlist,
//! so both direct/cached `web_fetch` calls and later workspace reads/searches taint the turn.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_core::web_fetch::{
    DEFAULT_WINDOW_CHARS, SavedPage, canonical_url, format_saved, is_matching_artifact,
    parse_saved, render_query, render_window, snapshot_path,
};
use spade_fetch::Fetcher;
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::workspace::{LARGEST_TEXT, PathError, Workspace, Workspaces};

/// Most `(conversation, canonical_url) -> snapshot_path` entries persisted per bot.
const MAX_INDEX_ENTRIES: usize = 512;
/// Most alternate candidate names tried if unrelated files already occupy snapshot paths.
const MAX_SAVE_ATTEMPTS: usize = 64;

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedIndex {
    #[serde(default)]
    entries: Vec<IndexEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct IndexEntry {
    conversation: String,
    url: String,
    path: String,
}

impl PersistedIndex {
    fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn get(&self, conversation: &str, url: &str) -> Option<String> {
        self.entries
            .iter()
            .rev()
            .find(|e| e.conversation == conversation && e.url == url)
            .map(|e| e.path.clone())
    }

    fn record(&mut self, conversation: &str, urls: &[String], snapshot: &str) {
        for url in urls {
            self.entries
                .retain(|e| !(e.conversation == conversation && e.url == *url));
            self.entries.push(IndexEntry {
                conversation: conversation.to_owned(),
                url: url.clone(),
                path: snapshot.to_owned(),
            });
        }
        if self.entries.len() > MAX_INDEX_ENTRIES {
            let excess = self.entries.len() - MAX_INDEX_ENTRIES;
            self.entries.drain(0..excess);
        }
    }

    fn save(&self, path: &Path) {
        let written = serde_json::to_string(self)
            .map_err(std::io::Error::other)
            .and_then(|text| crate::atomic::write_whole(path, &text));
        if let Err(error) = written {
            tracing::warn!(%error, "web_fetch snapshot index was not written");
        }
    }
}

pub struct WebFetch {
    fetcher: Arc<Fetcher>,
    workspaces: Option<Workspaces>,
    bots: Option<EngineHandle>,
}

impl WebFetch {
    #[must_use]
    pub fn new(fetcher: Arc<Fetcher>) -> Self {
        Self {
            fetcher,
            workspaces: None,
            bots: None,
        }
    }

    /// Saves fetched page snapshots into the calling bot's workspace under `web/`.
    #[must_use]
    pub fn with_workspaces(mut self, workspaces: Workspaces, bots: EngineHandle) -> Self {
        self.workspaces = Some(workspaces);
        self.bots = Some(bots);
        self
    }

    fn target(&self, key: &str) -> Option<SaveTarget> {
        let workspaces = self.workspaces.as_ref()?;
        let bots = self.bots.as_ref()?;
        let bot = bots.agent_for_key(key)?;
        let workspace = workspaces.of(&bot).ok()?;
        let index_path = workspaces.web_fetch_index(&bot).ok()?;
        Some(SaveTarget {
            bot,
            workspace,
            index_path,
            bots: bots.clone(),
        })
    }
}

struct SaveTarget {
    bot: String,
    workspace: Workspace,
    index_path: PathBuf,
    bots: EngineHandle,
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
                description: "Read a web page or PDF as readable text. Saves an immutable \
                              snapshot of the full text to your workspace under web/ and returns \
                              the title, URL, length, saved path, heading outline with character \
                              offsets, and the first ~4,000 characters. Read the outline and pull \
                              specific sections with `offset` (including 0) or matching passages \
                              with `query` (or use workspace_read/workspace_search on the saved \
                              file) instead of re-fetching; omit both to fetch a fresh copy."
                    .to_owned(),
                schema: json!({
                    "type": "object",
                    "properties": {
                        "url": { "type": "string" },
                        "offset": {
                            "type": "integer",
                            "minimum": 0,
                            "description": "Character offset to read from the saved snapshot (use an outline offset, including 0, or the next offset from a previous call)."
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
            let reuse_saved = query.is_some() || args.offset.is_some();
            let offset = args.offset.unwrap_or(0);
            let canonical_req = canonical_url(&args.url);

            // Follow-up offset (including explicit 0) or query calls reuse this conversation's
            // persisted immutable snapshot off the async runtime without re-fetching.
            if reuse_saved
                && let Some(target) = &target
                && let Some(rendered) = load_and_render_saved(
                    target.workspace.clone(),
                    target.index_path.clone(),
                    conversation.clone(),
                    canonical_req.clone(),
                    offset,
                    query.clone(),
                )
                .await
            {
                return ToolOutput::ok(rendered).untrusted();
            }

            match fetcher.fetch_page(&args.url).await {
                Ok(fetched) => {
                    let page = SavedPage {
                        url: fetched.url,
                        title: fetched.title,
                        content_type: fetched.content_type,
                        pages: fetched.pages,
                        truncated: fetched.truncated,
                        text: fetched.text,
                    };
                    let (rendered, changed_path) = save_and_render(
                        target
                            .as_ref()
                            .map(|t| (t.workspace.clone(), t.index_path.clone())),
                        conversation,
                        canonical_req,
                        page,
                        offset,
                        query,
                    )
                    .await;
                    if let (Some(target), Some(path)) = (target, changed_path)
                        && let Some(engine) = target.bots.get()
                        && let Some(computers) = engine.computers()
                    {
                        computers.files_changed(&target.bot, Some(vec![path]));
                    }
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

/// Loads this conversation's persisted immutable snapshot and renders the requested window or
/// query on a blocking worker thread so extraction/ranking never ties up an async worker.
async fn load_and_render_saved(
    workspace: Workspace,
    index_path: PathBuf,
    conversation: String,
    canonical_req: String,
    offset: usize,
    query: Option<String>,
) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let saved_path = workspace.changing(|| {
            let index = PersistedIndex::load(&index_path);
            index.get(&conversation, &canonical_req)
        })?;
        if !workspace.plain_file(&saved_path) {
            return None;
        }
        let raw = workspace.text(&saved_path).ok()?;
        let page = parse_saved(&raw)?;
        Some(render(&page, Some(&saved_path), offset, query.as_deref()))
    })
    .await
    .ok()
    .flatten()
}

/// Formats, saves (without clobbering non-fetch files), updates the persisted conversation index,
/// and renders the tool result on a blocking worker thread.
/// Returns `(rendered_output, newly_created_path)`.
async fn save_and_render(
    storage: Option<(Workspace, PathBuf)>,
    conversation: String,
    canonical_req: String,
    mut page: SavedPage,
    offset: usize,
    query: Option<String>,
) -> (String, Option<String>) {
    let fallback_page = page.clone();
    let fallback_query = query.clone();
    tokio::task::spawn_blocking(move || {
        let mut saved_path = None;
        let mut created_path = None;

        if let Some((workspace, index_path)) = storage {
            let max_bytes = usize::try_from(LARGEST_TEXT).unwrap_or(4 * 1024 * 1024);
            let (formatted, capped) = format_saved(&page, max_bytes);
            if capped && let Some(parsed) = parse_saved(&formatted) {
                page.text = parsed.text;
                page.truncated = true;
            }
            let canonical_final = canonical_url(&page.url);
            let mut urls = vec![canonical_req];
            if canonical_final != urls[0] {
                urls.push(canonical_final);
            }

            let save_result = workspace.changing(|| {
                let (path, created) =
                    create_immutable_snapshot(&workspace, &page.url, &formatted, max_bytes)?;
                let mut index = PersistedIndex::load(&index_path);
                index.record(&conversation, &urls, &path);
                index.save(&index_path);
                Ok::<(String, bool), PathError>((path, created))
            });

            match save_result {
                Ok((path, created)) => {
                    if created {
                        created_path = Some(path.clone());
                    }
                    saved_path = Some(path);
                }
                Err(error) => {
                    tracing::warn!(%error, "web_fetch snapshot was not saved to workspace");
                }
            }
        }

        let rendered = render(&page, saved_path.as_deref(), offset, query.as_deref());
        (rendered, created_path)
    })
    .await
    .unwrap_or_else(|_| {
        (
            render(&fallback_page, None, offset, fallback_query.as_deref()),
            None,
        )
    })
}

/// Atomically creates an immutable snapshot at `web/<host>-<url-hash>-<content-hash>.md` without
/// ever overwriting an existing file. If a file already exists at a candidate path, reuses it
/// only when it is a plain regular file verified as an identical `web_fetch` artifact for `url`;
/// otherwise leaves it untouched and picks `-2.md`, `-3.md`, etc.
fn create_immutable_snapshot(
    workspace: &Workspace,
    url: &str,
    formatted: &str,
    max_bytes: usize,
) -> Result<(String, bool), PathError> {
    let bytes = formatted.as_bytes();
    for attempt in 1..=MAX_SAVE_ATTEMPTS {
        let candidate = snapshot_path(url, bytes, attempt);
        if workspace.create_new_bytes(&candidate, bytes, max_bytes)? {
            workspace.trust().record_write(&candidate, bytes, Some(url));
            return Ok((candidate, true));
        }
        // Something already exists at `candidate`. Only reuse if verified as our exact immutable
        // fetch artifact; never overwrite user/bot files, links, or folders.
        if workspace.plain_file(&candidate)
            && let Ok(existing) = workspace.text(&candidate)
            && is_matching_artifact(&existing, url, formatted)
        {
            workspace.trust().record_write(&candidate, bytes, Some(url));
            return Ok((candidate, false));
        }
    }
    Err(PathError::Io(format!(
        "too many existing files beside web_fetch snapshot for {url}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn two_conversations_sharing_one_bot_workspace_page_their_own_immutable_snapshots() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let workspaces = Workspaces::new(dir.path().join("workspace"));
        let ws = workspaces.of("bot_1").unwrap_or_else(|e| panic!("{e}"));
        let index = workspaces
            .web_fetch_index("bot_1")
            .unwrap_or_else(|e| panic!("{e}"));
        let url = "https://example.com/live";

        let page_v1 = SavedPage {
            url: url.to_owned(),
            title: Some("Live".to_owned()),
            content_type: "text/html".to_owned(),
            pages: None,
            truncated: false,
            text: format!("{}V1_END", "alpha ".repeat(700)),
        };
        let page_v2 = SavedPage {
            url: url.to_owned(),
            title: Some("Live".to_owned()),
            content_type: "text/html".to_owned(),
            pages: None,
            truncated: false,
            text: format!("{}V2_END", "beta ".repeat(850)),
        };

        let (_, created_v1) = save_and_render(
            Some((ws.clone(), index.clone())),
            "conv_a".to_owned(),
            canonical_url(url),
            page_v1,
            0,
            None,
        )
        .await;
        let (_, created_v2) = save_and_render(
            Some((ws.clone(), index.clone())),
            "conv_b".to_owned(),
            canonical_url(url),
            page_v2,
            0,
            None,
        )
        .await;
        assert!(created_v1.is_some());
        assert!(created_v2.is_some());
        assert_ne!(created_v1, created_v2);

        // Both conversations share the same bot workspace + index file, yet each pages its own
        // immutable snapshot (including explicit offset 0 and offset 4000).
        let a_tail = load_and_render_saved(
            ws.clone(),
            index.clone(),
            "conv_a".to_owned(),
            canonical_url(url),
            4_000,
            None,
        )
        .await
        .unwrap_or_else(|| panic!("conv_a snapshot missing"));
        let b_tail = load_and_render_saved(
            ws.clone(),
            index.clone(),
            "conv_b".to_owned(),
            canonical_url(url),
            4_000,
            None,
        )
        .await
        .unwrap_or_else(|| panic!("conv_b snapshot missing"));
        let a_zero =
            load_and_render_saved(ws, index, "conv_a".to_owned(), canonical_url(url), 0, None)
                .await
                .unwrap_or_else(|| panic!("conv_a offset 0 missing"));

        assert!(a_tail.contains("V1_END"), "{a_tail}");
        assert!(!a_tail.contains("V2_END"));
        assert!(b_tail.contains("V2_END"), "{b_tail}");
        assert!(!b_tail.contains("V1_END"));
        assert!(a_zero.contains("alpha alpha"), "{a_zero}");
    }
}
