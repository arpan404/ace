//! A packaged bot's panel pages (ADR 0200 §5.2): the bytes of each `panels/<id>/index.html` the
//! manifest declares, sent beside it at install and on every update or rollback, kept once by
//! their sha256 and served by it, as a Suit's files are (ADR 0150). The bot keeps which page each
//! of its panels shows; a step that was refused changes nothing, and an install keeps them in the
//! same write that makes the bot.

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};
use spade_core::package::Manifest;
use spade_core::package::surfaces::panels;
use spade_core::panel::MOST_PAGE_BYTES;

use spade_store::{page_key, panels_key as bot_key};

use super::PackageError;
use crate::engine::Engine;

/// A page checked for its panel, ready to keep.
#[derive(Debug, Clone)]
pub struct Page {
    pub panel: String,
    pub hash: String,
    pub html: String,
}

/// The page every panel `manifest` declares, from `sent` (path to text); a panel whose page
/// wasn't sent, or is too large, refuses the step. Pages for paths no panel declares are ignored.
pub fn pages(
    manifest: &Manifest,
    sent: &BTreeMap<String, String>,
) -> Result<Vec<Page>, PackageError> {
    let mut out = Vec::new();
    for panel in panels(&manifest.surfaces) {
        let Some(html) = sent.get(&panel.file) else {
            return Err(PackageError::Invalid(format!(
                "{} is declared in surfaces but its page wasn't sent with the manifest",
                panel.file
            )));
        };
        if html.len() > MOST_PAGE_BYTES {
            return Err(PackageError::Invalid(format!(
                "{} is larger than 1 MB",
                panel.file
            )));
        }
        out.push(Page {
            panel: panel.id.clone(),
            hash: hex(&Sha256::digest(html.as_bytes())),
            html: html.clone(),
        });
    }
    Ok(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The settings rows that keep `pages` for `bot`: each page once by hash, and the bot's names.
pub fn rows(bot: &str, pages: &[Page]) -> Vec<(String, String)> {
    let named: BTreeMap<&str, &str> = pages
        .iter()
        .map(|page| (page.panel.as_str(), page.hash.as_str()))
        .collect();
    let mut rows: Vec<(String, String)> = pages
        .iter()
        .map(|page| (page_key(&page.hash), page.html.clone()))
        .collect();
    rows.push((
        bot_key(bot),
        serde_json::to_string(&named).unwrap_or_else(|_| "{}".to_owned()),
    ));
    rows
}

/// Keeps `pages` as bot `bot`'s, after a step that moved it was accepted.
pub fn keep(engine: &Engine, bot: &str, pages: &[Page]) -> Result<(), PackageError> {
    let rows = rows(bot, pages);
    let changes: Vec<(&str, Option<&str>)> = rows
        .iter()
        .map(|(key, value)| (key.as_str(), Some(value.as_str())))
        .collect();
    engine
        .store()
        .set_settings(&changes)
        .map_err(|error| PackageError::Failed(error.to_string()))
}

/// Which page each of bot `bot`'s panels shows, by panel id.
pub fn hashes(engine: &Engine, bot: &str) -> BTreeMap<String, String> {
    let text = engine.store().setting(&bot_key(bot)).ok().flatten();
    text.and_then(|text| serde_json::from_str::<BTreeMap<String, String>>(&text).ok())
        .unwrap_or_default()
}

/// The pages a bot's panels name, from its `bot_panels:<bot>` setting's text: what a move of it
/// carries beside its rows.
pub fn named_in(text: &str) -> Vec<String> {
    serde_json::from_str::<BTreeMap<String, String>>(text)
        .map(|named| named.into_values().filter(|hash| is_hash(hash)).collect())
        .unwrap_or_default()
}

fn is_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Keeps a page a moved bot brought, by its hash: only text of that hash, of a page's size. One
/// this machine keeps already stays as it is (it is the same text). A move that is undone leaves
/// it named by no bot, so the collection takes it out.
pub fn place(engine: &Engine, hash: &str, html: &[u8]) -> Result<(), String> {
    if !is_hash(hash) || html.len() > MOST_PAGE_BYTES || hex(&Sha256::digest(html)) != hash {
        return Err(format!("the panel page {hash} isn't the one its name says"));
    }
    let html =
        std::str::from_utf8(html).map_err(|_| format!("the panel page {hash} isn't text"))?;
    if page(engine, hash).is_some() {
        return Ok(());
    }
    engine
        .store()
        .set_setting(&page_key(hash), Some(html))
        .map_err(|error| error.to_string())
}

/// A kept page's text, by its hash.
pub fn page(engine: &Engine, hash: &str) -> Option<String> {
    let hash = hash.to_ascii_lowercase();
    if !is_hash(&hash) {
        return None;
    }
    engine.store().setting(&page_key(&hash)).ok().flatten()
}
