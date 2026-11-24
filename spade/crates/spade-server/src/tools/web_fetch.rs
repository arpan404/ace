//! `web_fetch`: reads a web page or PDF as readable text (`spade-fetch`), saves an immutable
//! snapshot to the bot's workspace (`web/<host>-<url-hash>-<content-hash>.md`) atomically and
//! without ever clobbering non-fetch files, and returns a compact bounded handle (title, URL,
//! total length, saved path, heading outline with character offsets, and the first ~4,000
//! characters).
//!
//! Each conversation's URL-to-snapshot mapping (with full SHA-256 digest) is persisted outside
//! the bot's workspace folder under `<workspaces>/.web-fetch/<bot>.json` via a no-follow
//! capability directory handle, bounded in both entry count and bytes. Follow-up `offset`
//! (including `offset: 0`) and `query` calls reuse the immutable snapshot only when its digest
//! still matches; any cache miss (missing, evicted, or modified snapshot) refetches a fresh copy
//! into a new snapshot.
//!
//! Its output is untrusted and saved snapshots are never added to the workspace trust allowlist,
//! so both direct/cached `web_fetch` calls and later workspace reads/searches taint the turn.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::{Value, json};
use spade_core::tools::{Risk, ToolDef};
use spade_core::web_fetch::{
    DEFAULT_WINDOW_CHARS, SavedPage, canonical_url, format_saved, is_matching_artifact,
    parse_saved, render_query, render_window, snapshot_path,
};
use spade_fetch::Fetcher;
use spade_models::ToolSpec;

use super::{EngineHandle, Tool, ToolFuture, ToolOutput, parse};
use crate::workspace::web_fetch_index::{self, MAX_INDEX_ENTRIES};
use crate::workspace::{LARGEST_TEXT, PathError, Workspace, Workspaces, trust};

/// Most alternate candidate names tried if unrelated files already occupy snapshot paths.
const MAX_SAVE_ATTEMPTS: usize = 64;

pub struct WebFetch {
    fetcher: Arc<Fetcher>,
    workspaces: Option<Workspaces>,
    bots: Option<EngineHandle>,
    max_index_entries: usize,
}

impl WebFetch {
    #[must_use]
    pub fn new(fetcher: Arc<Fetcher>) -> Self {
        Self {
            fetcher,
            workspaces: None,
            bots: None,
            max_index_entries: MAX_INDEX_ENTRIES,
        }
    }

    /// Saves fetched page snapshots into the calling bot's workspace under `web/`.
    #[must_use]
    pub fn with_workspaces(mut self, workspaces: Workspaces, bots: EngineHandle) -> Self {
        self.workspaces = Some(workspaces);
        self.bots = Some(bots);
        self
    }

    /// Overrides the per-bot snapshot index row cap. Tests only.
    #[cfg(feature = "test-hooks")]
    #[must_use]
    pub fn with_max_index_entries(mut self, max: usize) -> Self {
        self.max_index_entries = max.max(1);
        self
    }

    fn target(&self, key: &str) -> Option<SaveTarget> {
        let workspaces = self.workspaces.as_ref()?;
        let bots = self.bots.as_ref()?;
        let bot = bots.agent_for_key(key)?;
        let workspace = workspaces.of(&bot).ok()?;
        Some(SaveTarget {
            bot,
            workspace,
            bots: bots.clone(),
        })
    }
}

struct SaveTarget {
    bot: String,
    workspace: Workspace,
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
                              file) instead of re-fetching; if no verified saved snapshot exists \
                              (cache miss, eviction, or modified file) it refetches a fresh copy. \
                              Omit both `offset` and `query` to force a fresh fetch."
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
        let max_index_entries = self.max_index_entries;

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
            // persisted immutable snapshot off the async runtime only when its SHA-256 matches;
            // any cache miss (absent, evicted, or edited snapshot) falls through to refetch.
            if reuse_saved
                && let Some(target) = &target
                && let Some(rendered) = load_and_render_saved(
                    target.workspace.clone(),
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
                        target.as_ref().map(|t| t.workspace.clone()),
                        conversation,
                        canonical_req,
                        page,
                        offset,
                        query,
                        max_index_entries,
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

/// Loads this conversation's persisted immutable snapshot, verifies its full SHA-256 content
/// digest, and renders the requested window or query on a blocking worker thread. Returns `None`
/// on any cache miss (missing, evicted, symlinked, or edited file) so the caller refetches.
async fn load_and_render_saved(
    workspace: Workspace,
    conversation: String,
    canonical_req: String,
    offset: usize,
    query: Option<String>,
) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let (saved_path, expected_sha256) = match workspace
            .changing(|| web_fetch_index::get_unlocked(&workspace, &conversation, &canonical_req))
        {
            Ok(Some(found)) => found,
            Ok(None) => return None,
            Err(error) => {
                tracing::warn!(%error, "web_fetch snapshot index could not be opened");
                return None;
            }
        };
        if !workspace.plain_file(&saved_path) {
            return None;
        }
        let raw = workspace.text(&saved_path).ok()?;
        if trust::hash(raw.as_bytes()) != expected_sha256 {
            return None;
        }
        let page = parse_saved(&raw)?;
        Some(render(&page, Some(&saved_path), offset, query.as_deref()))
    })
    .await
    .ok()
    .flatten()
}

/// Formats, saves atomically (without clobbering non-fetch files), updates the persisted
/// conversation index (with full SHA-256 digest and eviction cleanup), and renders the tool
/// result on a blocking worker thread.
/// Returns `(rendered_output, newly_created_path)`.
async fn save_and_render(
    storage: Option<Workspace>,
    conversation: String,
    canonical_req: String,
    mut page: SavedPage,
    offset: usize,
    query: Option<String>,
    max_index_entries: usize,
) -> (String, Option<String>) {
    let fallback_page = page.clone();
    let fallback_query = query.clone();
    tokio::task::spawn_blocking(move || {
        let mut saved_path = None;
        let mut created_path = None;

        if let Some(workspace) = storage {
            let max_bytes = usize::try_from(LARGEST_TEXT).unwrap_or(4 * 1024 * 1024);
            let (formatted, capped) = format_saved(&page, max_bytes);
            if capped && let Some(parsed) = parse_saved(&formatted) {
                page.text = parsed.text;
                page.truncated = true;
            }
            let sha256 = trust::hash(formatted.as_bytes());
            let canonical_final = canonical_url(&page.url);
            let mut urls = vec![canonical_req];
            if canonical_final != urls[0] {
                urls.push(canonical_final);
            }

            let save_result = workspace.changing(|| {
                let (path, created) =
                    create_immutable_snapshot(&workspace, &page.url, &formatted, max_bytes)?;
                if let Err(error) = web_fetch_index::record_unlocked(
                    &workspace,
                    &conversation,
                    &urls,
                    &path,
                    &sha256,
                    max_index_entries,
                ) {
                    tracing::warn!(%error, "web_fetch snapshot index was not written");
                }
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
    use crate::workspace::web_fetch_index::MAX_INDEX_BYTES;

    #[tokio::test]
    async fn two_conversations_sharing_one_bot_workspace_page_their_own_immutable_snapshots() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let workspaces = Workspaces::new(dir.path().join("workspace"));
        let ws = workspaces.of("bot_1").unwrap_or_else(|e| panic!("{e}"));
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
            Some(ws.clone()),
            "conv_a".to_owned(),
            canonical_url(url),
            page_v1,
            0,
            None,
            MAX_INDEX_ENTRIES,
        )
        .await;
        let (_, created_v2) = save_and_render(
            Some(ws.clone()),
            "conv_b".to_owned(),
            canonical_url(url),
            page_v2,
            0,
            None,
            MAX_INDEX_ENTRIES,
        )
        .await;
        assert!(created_v1.is_some());
        assert!(created_v2.is_some());
        assert_ne!(created_v1, created_v2);

        let a_tail = load_and_render_saved(
            ws.clone(),
            "conv_a".to_owned(),
            canonical_url(url),
            4_000,
            None,
        )
        .await
        .unwrap_or_else(|| panic!("conv_a snapshot missing"));
        let b_tail = load_and_render_saved(
            ws.clone(),
            "conv_b".to_owned(),
            canonical_url(url),
            4_000,
            None,
        )
        .await
        .unwrap_or_else(|| panic!("conv_b snapshot missing"));
        let a_zero = load_and_render_saved(ws, "conv_a".to_owned(), canonical_url(url), 0, None)
            .await
            .unwrap_or_else(|| panic!("conv_a offset 0 missing"));

        assert!(a_tail.contains("V1_END"), "{a_tail}");
        assert!(!a_tail.contains("V2_END"));
        assert!(b_tail.contains("V2_END"), "{b_tail}");
        assert!(!b_tail.contains("V1_END"));
        assert!(a_zero.contains("alpha alpha"), "{a_zero}");
    }

    #[tokio::test]
    async fn oversized_index_file_is_treated_as_empty_and_rebuilt_within_byte_bound() {
        let dir = tempfile::tempdir().unwrap_or_else(|e| panic!("{e}"));
        let workspaces = Workspaces::new(dir.path().join("workspace"));
        let ws = workspaces.of("bot_1").unwrap_or_else(|e| panic!("{e}"));

        // Plant a >1 MiB index file on disk.
        let index_dir = workspaces.root().join(".web-fetch");
        std::fs::create_dir_all(&index_dir).unwrap_or_else(|e| panic!("{e}"));
        let index_file = index_dir.join("bot_1.json");
        let huge = format!(
            "{{\"entries\":[{{\"conversation\":\"c\",\"url\":\"{}\",\"path\":\"web/x.md\",\"sha256\":\"aa\"}}]}}",
            "a".repeat(MAX_INDEX_BYTES + 1024)
        );
        std::fs::write(&index_file, huge).unwrap_or_else(|e| panic!("{e}"));

        // Lookup refuses to load the oversized file (cache miss).
        let miss = load_and_render_saved(
            ws.clone(),
            "c".to_owned(),
            "https://example.com/x".to_owned(),
            0,
            None,
        )
        .await;
        assert!(miss.is_none());

        // Saving a page with a huge URL rebuilds the index within the byte bound.
        let huge_url = format!("https://example.com/{}", "q".repeat(10_000));
        let page = SavedPage {
            url: huge_url.clone(),
            title: Some("Huge".to_owned()),
            content_type: "text/html".to_owned(),
            pages: None,
            truncated: false,
            text: "Bounded body.".to_owned(),
        };
        let (_, created) = save_and_render(
            Some(ws.clone()),
            "c".to_owned(),
            canonical_url(&huge_url),
            page,
            0,
            None,
            MAX_INDEX_ENTRIES,
        )
        .await;
        assert!(created.is_some());

        let meta = std::fs::metadata(&index_file).unwrap_or_else(|e| panic!("{e}"));
        assert!(
            meta.len() < 4_096,
            "rebuilt index should be tiny, got {}",
            meta.len()
        );

        let loaded = load_and_render_saved(ws, "c".to_owned(), canonical_url(&huge_url), 0, None)
            .await
            .unwrap_or_else(|| panic!("rebuilt index should serve huge_url"));
        assert!(loaded.contains("Bounded body."), "{loaded}");
    }
}
