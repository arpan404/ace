//! Where a note or a knowledge entry came from, so the person can ask "why do you think that?":
//! the conversation and the person's message the bot was answering, the call that wrote it,
//! untrusted content that was in the prompt's view (a page, an app's answer), or an import. Stored
//! beside each note and entry when it is written; ones from before have none and are read by
//! their `source` alone. Pure: the keys here are what "forget everything learned from …" matches.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    /// The conversation the bot was in when it wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<String>,
    /// The position of the person's message that turn answered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<i64>,
    /// The call that wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<String>,
    /// Untrusted content in the prompt's view as it was written, each in a few words (a page's
    /// address, "the result of gmail__search").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read: Vec<String>,
    /// What brought it in: a recipe or a bot file ("the Inbox recipe").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import: Option<String>,
}

impl Origin {
    /// Written in `conversation` by `call`, answering the message at `message`, with `read` in
    /// view.
    pub fn conversation(
        conversation: &str,
        message: Option<i64>,
        call: Option<&str>,
        read: Vec<String>,
    ) -> Self {
        Self {
            conversation: Some(conversation.to_owned()),
            message,
            call: call.map(str::to_owned),
            read,
            import: None,
        }
    }

    /// Brought in by `what`.
    pub fn imported(what: &str) -> Self {
        Self {
            import: Some(what.to_owned()),
            ..Self::default()
        }
    }

    /// Read back from a stored column; `None` for one this build can't read.
    pub fn parse(text: Option<&str>) -> Option<Self> {
        text.and_then(|text| serde_json::from_str(text).ok())
    }
}

/// The key of untrusted content described in a few words: `web:<host>` for a page's address,
/// `app:<app>` for an app's tool (`the result of gmail__search` → `app:gmail`), else
/// `read:<words>`.
pub fn read_key(words: &str) -> String {
    let words = words.trim();
    if let Some(host) = host_of(words) {
        return format!("web:{host}");
    }
    let named = words.strip_prefix("the result of ").unwrap_or(words);
    if let Some((app, _)) = named.split_once("__")
        && !app.is_empty()
        && app != "ace"
        && app
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return format!("app:{app}");
    }
    format!("read:{words}")
}

/// The host of an `http(s)` address, lower case, without `www.`.
fn host_of(address: &str) -> Option<String> {
    let rest = address
        .strip_prefix("https://")
        .or_else(|| address.strip_prefix("http://"))?;
    let host = rest
        .split(['/', '?', '#'])
        .next()?
        .rsplit('@')
        .next()?
        .split(':')
        .next()?
        .to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    (!host.is_empty()).then_some(host)
}

/// Every source key a note or entry came from: its conversation, what was in view, its import,
/// and for knowledge its own source (`web` with an address, `tool` naming an app's tool). The
/// person's own words have no source to forget them by, except an import they brought in.
/// Sorted, each once.
pub fn keys(origin: Option<&Origin>, by_person: bool, source_detail: Option<&str>) -> Vec<String> {
    if by_person {
        return origin
            .and_then(|origin| origin.import.as_ref())
            .map(|import| vec![format!("import:{import}")])
            .unwrap_or_default();
    }
    let mut out = Vec::new();
    if let Some(origin) = origin {
        if let Some(conversation) = &origin.conversation {
            out.push(format!("conversation:{conversation}"));
        }
        out.extend(origin.read.iter().map(|words| read_key(words)));
        if let Some(import) = &origin.import {
            out.push(format!("import:{import}"));
        }
    }
    if let Some(detail) = source_detail {
        let key = read_key(detail);
        if !key.starts_with("read:") {
            out.push(key);
        }
    }
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_was_read_is_keyed_by_its_site_or_app() {
        assert_eq!(read_key("https://www.Example.com/a?b=1"), "web:example.com");
        assert_eq!(read_key("the result of gmail__search"), "app:gmail");
        assert_eq!(
            read_key("the result of ace__thread_read"),
            "read:the result of ace__thread_read"
        );
        assert_eq!(
            read_key("another bot's answer"),
            "read:another bot's answer"
        );
    }

    #[test]
    fn a_note_answers_to_its_conversation_what_it_read_and_its_import() {
        let origin = Origin::conversation(
            "c_1",
            Some(4),
            Some("call_9"),
            vec![
                "https://example.com/x".to_owned(),
                "the result of slack__history".to_owned(),
            ],
        );
        assert_eq!(
            keys(Some(&origin), false, None),
            vec!["app:slack", "conversation:c_1", "web:example.com"]
        );
        assert_eq!(
            keys(Some(&Origin::imported("the Inbox recipe")), false, None),
            vec!["import:the Inbox recipe"]
        );
    }

    #[test]
    fn the_persons_own_words_have_no_source_to_forget_them_by() {
        let origin = Origin::conversation("c_1", None, None, Vec::new());
        assert!(keys(Some(&origin), true, Some("https://example.com")).is_empty());
        let imported = Origin::imported("bot file Trips");
        assert_eq!(
            keys(Some(&imported), true, None),
            vec!["import:bot file Trips"]
        );
    }

    #[test]
    fn a_knowledge_entry_from_a_page_answers_to_the_page_without_an_origin() {
        assert_eq!(
            keys(None, false, Some("https://docs.rs/serde")),
            vec!["web:docs.rs"]
        );
        assert!(keys(None, false, Some("src/main.rs")).is_empty());
    }

    #[test]
    fn a_stored_origin_reads_back_and_a_broken_one_reads_as_none() {
        let origin = Origin::conversation("c_1", Some(2), None, Vec::new());
        let text = serde_json::to_string(&origin).unwrap_or_default();
        assert_eq!(Origin::parse(Some(&text)), Some(origin));
        assert_eq!(Origin::parse(Some("{not json")), None);
    }
}
